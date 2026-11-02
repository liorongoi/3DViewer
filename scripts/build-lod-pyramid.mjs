// Builds a real LOD pyramid over a flat 3D Tiles city (one b3dm per block):
// parents merge their children's meshes, simplify them and pack their textures into one
// smaller atlas, so far views draw a few light tiles and close views the full blocks.
// Usage: node scripts/build-lod-pyramid.mjs <in tileset dir> <out tileset dir>
// Needs: npm i @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 @gltf-transform/functions@4.5.1
//        draco3dgltf@1.5.7 meshoptimizer@0.25.0 sharp@0.34.5 (fetch-samples.sh does this in a temp folder).
// The leaves stay the original blocks; the source tileset.json is kept as tileset-flat.json.
import fs from "node:fs";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const [IN, OUT] = process.argv.slice(2);
function b3dmToGlb(buf) {
  const ftj = buf.readUInt32LE(12), ftb = buf.readUInt32LE(16), btj = buf.readUInt32LE(20), btb = buf.readUInt32LE(24);
  const ft = JSON.parse(buf.subarray(28, 28 + ftj).toString() || "{}");
  return { glb: buf.subarray(28 + ftj + ftb + btj + btb), ft, batchTable: btj ? JSON.parse(buf.subarray(28 + ftj + ftb, 28 + ftj + ftb + btj).toString()) : null };
}

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "meshopt.encoder": MeshoptEncoder,
});
const srcFile = fs.existsSync(path.join(IN, "tileset-flat.json")) ? "tileset-flat.json" : "tileset.json";
const src = JSON.parse(fs.readFileSync(path.join(IN, srcFile), "utf8"));
if (src.root.children?.some((c) => c.children?.length)) throw new Error("This tileset already has a hierarchy.");
fs.mkdirSync(path.join(OUT, "lod"), { recursive: true });
if (path.resolve(IN) !== path.resolve(OUT)) fs.cpSync(path.join(IN, "tiles"), path.join(OUT, "tiles"), { recursive: true });
fs.writeFileSync(path.join(OUT, "tileset-flat.json"), JSON.stringify(src));

// ---------- leaves: geometry in ECEF (z-up), one texture each ----------
const v3 = { add: (a, b) => a.map((x, i) => x + b[i]), sub: (a, b) => a.map((x, i) => x - b[i]), len: (a) => Math.hypot(...a) };
const leaves = [];
for (const t of src.root.children) {
  const tr = t.transform.slice(12, 15);
  const b = t.boundingVolume.box;
  const c = v3.add(tr, b.slice(0, 3));
  const half = [b.slice(3, 6), b.slice(6, 9), b.slice(9, 12)];
  const corners = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(c.map((x, i) => x + sx * half[0][i] + sy * half[1][i] + sz * half[2][i]));
  const { glb } = b3dmToGlb(fs.readFileSync(path.join(IN, t.content.uri)));
  const doc = await io.readBinary(new Uint8Array(glb));
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const pos = prim.getAttribute("POSITION").getArray();
  const uv = prim.getAttribute("TEXCOORD_0")?.getArray();
  const idx = prim.getIndices()?.getArray();
  const tex = doc.getRoot().listMaterials()[0]?.getBaseColorTexture();
  const world = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) world[i + k] = pos[i + k] + tr[k];
  leaves.push({ tile: t, centre: c, corners, world, uv, idx, tex: tex ? Buffer.from(tex.getImage()) : null });
}

// East/north axes at the city centre, to split the blocks into a quadtree on the map.
const rootC = src.root.boundingVolume.box.slice(0, 3);
const up = rootC.map((x) => x / v3.len(rootC));
const east = (() => { const e = [-up[1], up[0], 0]; const l = v3.len(e); return e.map((x) => x / l); })();
const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

let seq = 0;
const stats = [];
async function build(items, depth) {
  // items: leaves or built parents (both have centre, corners, world, uv, idx, tex)
  let children;
  if (items.length <= 8) children = items.map((x) => x);
  else {
    const byE = [...items].sort((a, b) => dot(a.centre, east) - dot(b.centre, east));
    const half = Math.ceil(byE.length / 2);
    const quads = [];
    for (const side of [byE.slice(0, half), byE.slice(half)]) {
      const byN = [...side].sort((a, b) => dot(a.centre, north) - dot(b.centre, north));
      const h = Math.ceil(byN.length / 2);
      quads.push(byN.slice(0, h), byN.slice(h));
    }
    children = [];
    for (const q of quads.filter((q) => q.length)) children.push(q.length === 1 ? q[0] : await build(q, depth + 1));
  }
  return merge(children, depth);
}

async function merge(children, depth) {
  const id = seq++;
  const corners = children.flatMap((c) => c.corners);
  const centre = corners.reduce((a, p) => v3.add(a, p), [0, 0, 0]).map((x) => x / corners.length);
  const radius = Math.max(...corners.map((p) => v3.len(v3.sub(p, centre))));
  // Texture atlas: children in a grid, then scaled to at most 1024 px.
  const n = Math.ceil(Math.sqrt(children.length));
  const cell = 512;
  const tiles = await Promise.all(children.map((c) => (c.tex ? sharp(c.tex).resize(cell, cell, { fit: "fill" }).png().toBuffer() : null)));
  const atlas = await sharp({ create: { width: n * cell, height: n * cell, channels: 3, background: "#808080" } })
    .composite(tiles.map((b, i) => (b ? { input: b, left: (i % n) * cell, top: Math.floor(i / n) * cell } : null)).filter(Boolean))
    .resize(Math.min(1024, n * cell), Math.min(1024, n * cell))
    .jpeg({ quality: 80 })
    .toBuffer();
  // Geometry: all children in one primitive, relative to this tile's centre, UVs into the atlas.
  let vCount = 0, iCount = 0;
  for (const c of children) { vCount += c.world.length / 3; iCount += c.idx.length; }
  const pos = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2), idx = new Uint32Array(iCount);
  let vo = 0, io2 = 0;
  children.forEach((c, k) => {
    const ox = (k % n) / n, oy = Math.floor(k / n) / n;
    for (let i = 0; i < c.world.length / 3; i++) {
      for (let a = 0; a < 3; a++) pos[(vo + i) * 3 + a] = c.world[i * 3 + a] - centre[a];
      const u = c.uv ? c.uv[i * 2] : 0, v = c.uv ? c.uv[i * 2 + 1] : 0;
      // Atlases are in [0,1]; a repeat would bleed into the neighbour, so clamp.
      uv[(vo + i) * 2] = ox + Math.min(1, Math.max(0, u)) / n;
      uv[(vo + i) * 2 + 1] = oy + Math.min(1, Math.max(0, v)) / n;
    }
    for (let i = 0; i < c.idx.length; i++) idx[io2 + i] = c.idx[i] + vo;
    vo += c.world.length / 3;
    io2 += c.idx.length;
  });
  // Weld: the source blocks repeat a vertex for every triangle, which leaves the simplifier
  // nothing to collapse. Merge vertices with the same position and texture coordinate.
  {
    const key = new Map();
    const map = new Uint32Array(pos.length / 3);
    for (let i = 0; i < map.length; i++) {
      const k = `${Math.round(pos[i * 3] * 1000)},${Math.round(pos[i * 3 + 1] * 1000)},${Math.round(pos[i * 3 + 2] * 1000)},${Math.round(uv[i * 2] * 1e5)},${Math.round(uv[i * 2 + 1] * 1e5)}`;
      let j = key.get(k);
      if (j === undefined) key.set(k, (j = i));
      map[i] = j;
    }
    for (let i = 0; i < idx.length; i++) idx[i] = map[idx[i]];
  }
  // Simplify: a third of the children's triangles, between 1 000 and 20 000 per tile. The
  // Prune drops small detached parts (chimneys, kiosks) that vanish at a distance anyway.
  const before = idx.length / 3;
  const target = Math.max(1000, Math.min(20000, Math.round(before / 3))) * 3;
  let sIdx = idx;
  if (idx.length > target) {
    const r = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.05, ["Prune"]);
    sIdx = r[0] ?? r;
  }
  // Keep only the vertices still used.
  const remap = new Int32Array(pos.length / 3).fill(-1);
  let nv = 0;
  for (const i of sIdx) if (remap[i] < 0) remap[i] = nv++;
  const cPos = new Float32Array(nv * 3), cUv = new Float32Array(nv * 2), cIdx = new Uint32Array(sIdx.length);
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i];
    if (j < 0) continue;
    cPos.set(pos.subarray(i * 3, i * 3 + 3), j * 3);
    cUv.set(uv.subarray(i * 2, i * 2 + 2), j * 2);
  }
  for (let i = 0; i < sIdx.length; i++) cIdx[i] = remap[sIdx[i]];
  const doc = new Document();
  const buf = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(cPos).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(cUv).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(cIdx).setBuffer(buf))
    .setMaterial(doc.createMaterial().setBaseColorTexture(doc.createTexture().setImage(new Uint8Array(atlas)).setMimeType("image/jpeg")).setMetallicFactor(0).setRoughnessFactor(1));
  // Same convention as the source b3dm: z-up positions under a node turned to glTF's y-up.
  // The tile centre goes on the node (glTF y-up: x, z, -y), not on the tile: a tile transform
  // would also move the child tiles, which carry their own absolute positions.
  doc.createScene().addChild(
    doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)).setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]).setTranslation([centre[0], centre[2], -centre[1]]),
  );
  const p2 = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const after = p2.getIndices().getCount() / 3;
  // Keep the simplified geometry (in ECEF) for the next level up.
  const sp = p2.getAttribute("POSITION").getArray();
  const world = new Float64Array(sp.length);
  for (let i = 0; i < sp.length; i += 3) for (let a = 0; a < 3; a++) world[i + a] = sp[i + a] + centre[a];
  const outUv = Float32Array.from(p2.getAttribute("TEXCOORD_0").getArray());
  const outIdx = Uint32Array.from(p2.getIndices().getArray());
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const file = `lod/p${id}.glb`;
  fs.writeFileSync(path.join(OUT, file), await io.writeBinary(doc));
  // Each level up at least doubles the error, so refinement always goes parent -> child.
  const childErr = Math.max(...children.map((c) => (c.json ?? c.tile).geometricError));
  const geometricError = Math.max(radius / 20, childErr * 2);
  stats.push({ id, depth, children: children.length, before, after, kb: Math.round(fs.statSync(path.join(OUT, file)).size / 1024), geometricError: +geometricError.toFixed(1) });
  return {
    centre, corners, world, uv: outUv, idx: outIdx, tex: atlas,
    json: {
      boundingVolume: { sphere: [...centre, radius] },
      geometricError,
      refine: "REPLACE",
      content: { uri: file },
      children: children.map((c) => c.json ?? c.tile),
    },
  };
}

const root = await build(leaves, 0);
const out = { asset: { version: "1.1", generator: "VIEWER LOD pyramid (scripts/build-lod-pyramid.mjs)" }, geometricError: root.json.geometricError * 4, root: root.json };
fs.writeFileSync(path.join(OUT, "tileset.json"), JSON.stringify(out));
if (path.resolve(IN) !== path.resolve(OUT) && fs.existsSync(path.join(IN, "README.md"))) fs.copyFileSync(path.join(IN, "README.md"), path.join(OUT, "README.md"));
console.log(JSON.stringify(stats.sort((a, b) => a.depth - b.depth)));
