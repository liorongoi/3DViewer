import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gridGlb } from "./test-models.ts";
import { tileModel } from "./tiler.ts";
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
});
