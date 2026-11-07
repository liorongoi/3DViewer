import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { gridGlb } from "./test-models.ts";
import { tileModel, tileModelInWorker } from "./tiler.ts";
import { validateOfficial } from "./validate.ts";

interface Tile {
  boundingVolume: { box: number[] };
  geometricError: number;
  content?: { uri: string };
  children?: Tile[];
}

const walk = (t: Tile, f: (t: Tile, parent: Tile | null) => void, parent: Tile | null = null) => {
  f(t, parent);
  for (const c of t.children ?? []) walk(c, f, t);
};

/** Triangles in a tile's GLB, from its index accessors. */
function triangles(file: string): number {
  const b = readFileSync(file);
  const g = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  return g.meshes[0].primitives.reduce((t: number, p: { indices: number }) => t + g.accessors[p.indices].count / 3, 0);
}

function setup(n: number, zUp = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "tile-"));
  writeFileSync(path.join(dir, "in.glb"), gridGlb(n, zUp));
  return { input: path.join(dir, "in.glb"), out: path.join(dir, "out") };
}

describe("tiler (WP 3.4)", () => {
  it("splits a model into a tile tree that keeps every triangle in the leaves", async () => {
    const { input, out } = setup(100); // 20,000 triangles
    const r = await tileModel(input, out, { leafTriangles: 2000 });
    expect(r.triangles).toBe(20_000);
    expect(r.levels).toBeGreaterThanOrEqual(3);
    const ts = JSON.parse(readFileSync(path.join(out, "tileset.json"), "utf8"));
    expect(ts.asset.version).toBe("1.1");
    let leafTris = 0;
    walk(ts.root, (t, parent) => {
      const n = t.content ? triangles(path.join(out, t.content.uri)) : 0;
      if (!t.children) {
        expect(t.geometricError).toBe(0);
        expect(n).toBeLessThanOrEqual(2000);
        leafTris += n;
      } else expect(n).toBeLessThanOrEqual(2000 * 1.5); // simplified, about one leaf's worth
      if (parent) expect(t.geometricError).toBeLessThan(parent.geometricError);
    });
    expect(leafTris).toBe(20_000);
    // The texture is written once and shared, not copied into every tile.
    expect(readdirSync(path.join(out, "textures"))).toEqual(["0.png"]);
    expect(await validateOfficial("3dtiles", path.join(out, "tileset.json"))).toMatchObject({ severity: "ok" });
  }, 60_000);

  it("bakes the up axis and scale into the tiles", async () => {
    // The same grid exported Z-up in centimetres: once turned and scaled it matches the Y-up one.
    const y = setup(20);
    const z = setup(20, true);
    await tileModel(y.input, y.out, { leafTriangles: 100 });
    await tileModel(z.input, z.out, { leafTriangles: 100, upAxis: "z", scale: 0.01 });
    const box = (o: string) => JSON.parse(readFileSync(path.join(o, "tileset.json"), "utf8")).root.boundingVolume.box as number[];
    // Tileset frame: x east, y north, z up. 100 m wide and ±2 m of relief.
    expect(box(y.out)[3]).toBeCloseTo(50, 3);
    expect(box(y.out)[11]).toBeLessThan(2.1);
    const bz = box(z.out);
    expect(bz[3]).toBeCloseTo(0.5, 4);
    expect(bz[7]).toBeCloseTo(0.5, 4);
    expect(bz[11]).toBeLessThan(0.021);
  }, 60_000);

  it("keeps east, north and up where the viewer puts them for a single model", async () => {
    // One small triangle 30 m east, 70 m north and 5 m up, written Y-up (north is −Z) and Z-up.
    const marker = async (p: [number, number, number]) => {
      const doc = new Document();
      const buf = doc.createBuffer();
      const d = 0.5;
      const pos = doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([p[0] - d, p[1] - d, p[2] - d, p[0] + d, p[1] - d, p[2] + d, p[0], p[1] + d, p[2]]));
      const idx = doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint32Array([0, 1, 2]));
      const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos).setIndices(idx));
      doc.createScene().addChild(doc.createNode().setMesh(mesh));
      const dir = mkdtempSync(path.join(tmpdir(), "tile-"));
      await new NodeIO().write(path.join(dir, "in.glb"), doc);
      return { input: path.join(dir, "in.glb"), out: path.join(dir, "out") };
    };
    const y = await marker([30, 5, -70]);
    const z = await marker([30, 70, 5]);
    await tileModel(y.input, y.out, {});
    await tileModel(z.input, z.out, { upAxis: "z" });
    for (const o of [y.out, z.out]) {
      const box = JSON.parse(readFileSync(path.join(o, "tileset.json"), "utf8")).root.boundingVolume.box as number[];
      expect(box.slice(0, 3).map((v) => Math.round(v))).toEqual([30, 70, 5]);
    }
  }, 60_000);

  it("keeps the original's parts as layers: a tree in the tileset, a feature per part in each tile", async () => {
    // A building group with two named parts, each a grid of 5,000 triangles side by side, plus a lone marker.
    const doc = new Document();
    const buf = doc.createBuffer();
    const grid = (x0: number, n: number) => {
      const p: number[] = [], ix: number[] = [];
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) p.push(x0 + i, 0, -j);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        ix.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
      const prim = doc.createPrimitive()
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array(p)))
        .setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint32Array(ix)));
      return doc.createMesh().addPrimitive(prim);
    };
    const walls = doc.createNode("Walls").setMesh(grid(0, 50));
    const roof = doc.createNode("Roof").setMesh(grid(60, 50));
    const building = doc.createNode("Building").addChild(walls).addChild(roof);
    const marker = doc.createNode("Marker").setMesh(grid(200, 2));
    const empty = doc.createNode("Empty");
    doc.createScene().addChild(building).addChild(marker).addChild(empty);
    const dir = mkdtempSync(path.join(tmpdir(), "tile-"));
    await new NodeIO().write(path.join(dir, "in.glb"), doc);
    const out = path.join(dir, "out");
    await tileModel(path.join(dir, "in.glb"), out, { leafTriangles: 2000 });

    const ts = JSON.parse(readFileSync(path.join(out, "tileset.json"), "utf8"));
    const strip = (l: { name: string; node: number; children: unknown[] }): unknown => ({ name: l.name, node: l.node, children: l.children.map((c) => strip(c as typeof l)) });
    // Node indices as in the original file: Walls 0, Roof 1, Building 2, Marker 3. Empty has no mesh.
    expect(ts.extras.layers.map(strip)).toEqual([
      { name: "Building", node: 2, children: [{ name: "Walls", node: 0, children: [] }, { name: "Roof", node: 1, children: [] }] },
      { name: "Marker", node: 3, children: [] },
    ]);
    expect(ts.extras.layers[0].children[1].box).toEqual({ lo: [60, 0, -50], hi: [110, 0, 0] });
    expect(ts.extras.layers[0].box).toEqual({ lo: [0, 0, -50], hi: [110, 0, 0] });

    // In every tile each vertex names its part; leaves together hold every part's triangles.
    const perNode = new Map<number, number>();
    walk(ts.root, (t) => {
      if (!t.content) return;
      const b = readFileSync(path.join(out, t.content.uri));
      const g = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
      const bin = b.subarray(20 + b.readUInt32LE(12) + 8);
      const prim = g.meshes[0].primitives[0];
      expect(prim.extensions.EXT_mesh_features.featureIds[0]).toMatchObject({ attribute: 0, propertyTable: 0 });
      const table = g.extensions.EXT_structural_metadata.propertyTables[0];
      const tv = g.bufferViews[table.properties.node.values];
      const nodes = new Uint32Array(bin.buffer.slice(bin.byteOffset + tv.byteOffset, bin.byteOffset + tv.byteOffset + tv.byteLength));
      expect(table.count).toBe(nodes.length);
      if (t.children) return;
      for (const p of g.meshes[0].primitives) {
        const fa = g.accessors[p.attributes._FEATURE_ID_0], fv = g.bufferViews[fa.bufferView];
        const fid = new Float32Array(bin.buffer.slice(bin.byteOffset + fv.byteOffset, bin.byteOffset + fv.byteOffset + fv.byteLength));
        const ia = g.accessors[p.indices], iv = g.bufferViews[ia.bufferView];
        const idx = ia.componentType === 5123 ? new Uint16Array(bin.buffer.slice(bin.byteOffset + iv.byteOffset, bin.byteOffset + iv.byteOffset + iv.byteLength)) : new Uint32Array(bin.buffer.slice(bin.byteOffset + iv.byteOffset, bin.byteOffset + iv.byteOffset + iv.byteLength));
        for (let k = 0; k < idx.length; k += 3) {
          const n = nodes[fid[idx[k]!]!]!;
          expect(nodes[fid[idx[k + 1]!]!]).toBe(n);
          perNode.set(n, (perNode.get(n) ?? 0) + 1);
        }
      }
    });
    expect(Object.fromEntries(perNode)).toEqual({ 0: 5000, 1: 5000, 3: 8 });
    expect(await validateOfficial("3dtiles", path.join(out, "tileset.json"))).toMatchObject({ severity: "ok" });
  }, 60_000);

  it("tiles on its own thread, so the server keeps answering meanwhile", async () => {
    const { input, out } = setup(600); // 720,000 triangles: several seconds of tiling
    // The longest the main thread goes without running a 10 ms timer.
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    const progress: number[] = [];
    const started = performance.now();
    const r = await tileModelInWorker(input, out, { leafTriangles: 50_000 }, (done) => progress.push(done));
    clearInterval(timer);
    const took = performance.now() - started;
    if (process.env.TILER_TIMING) console.log(`worker: ${took.toFixed(0)} ms, main thread held at most ${worst.toFixed(0)} ms`);
    expect(r.triangles).toBe(720_000);
    expect(progress.length).toBeGreaterThan(0);
    expect(took).toBeGreaterThan(1000); // long enough to mean something
    // On the main thread the same job held it for over a second at a time.
    expect(worst).toBeLessThan(150);
    // Same tiles as on the main thread.
    const ts = JSON.parse(readFileSync(path.join(out, "tileset.json"), "utf8"));
    expect(ts.asset.version).toBe("1.1");
  }, 120_000);

  it("reports a tiling failure from the worker as an error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tile-"));
    writeFileSync(path.join(dir, "bad.glb"), "not a glb");
    await expect(tileModelInWorker(path.join(dir, "bad.glb"), path.join(dir, "out"))).rejects.toThrow();
  }, 60_000);
});
