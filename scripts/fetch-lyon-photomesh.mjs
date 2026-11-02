// Downloads one district of the Métropole de Lyon 2023 photomesh (aerial photogrammetry,
// 5.5 cm pixels, Licence Ouverte 2.0) from data.grandlyon.com and repackages it as a
// small, self-contained 3D Tiles sample with its full LOD chain:
//   the publisher's pyramid levels over the district → each block's own tile tree.
// Tiles are converted from glTF 1.0 (what the publisher serves) to glTF 2.0 with Draco
// geometry and an unlit material (the lighting is already in the photos).
//
// Usage: node scripts/fetch-lyon-photomesh.mjs <out dir> [pyramid tile] [block depth]
//   pyramid tile  publisher pyramid node to keep, default p-10024 (Fourvière and the
//                 north of Vieux Lyon, 16 blocks, about 570 × 700 m)
//   block depth   levels to keep inside each block's tree, default 3 (finest kept
//                 level ≈ 0.4 m geometric error). 5 keeps everything (≈ 150 MB per block).
// Needs: npm i gltf-pipeline@4.1.0 with an npm override cesium@1.120.0 (fetch-samples.sh
// does this in a temp folder). Needs network access to data.grandlyon.com.
import fs from "node:fs";
import path from "node:path";
import gltfPipeline from "gltf-pipeline";

const BASE = "https://data.grandlyon.com/files/grandlyon/2023/mesh";
const [OUT, NODE = "p-10024", DEPTH = "3"] = process.argv.slice(2);
if (!OUT) throw new Error("Usage: fetch-lyon-photomesh.mjs <out dir> [pyramid tile] [block depth]");
const blockDepth = Number(DEPTH);

async function get(url, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
}

/** glTF 1.0 b3dm → glTF 2.0 b3dm (Draco, unlit). Keeps CESIUM_RTC, which CesiumJS reads. */
async function convertB3dm(buf) {
  const ftj = buf.readUInt32LE(12), ftb = buf.readUInt32LE(16), btj = buf.readUInt32LE(20), btb = buf.readUInt32LE(24);
  const glb1 = buf.subarray(28 + ftj + ftb + btj + btb);
  const { glb } = await gltfPipeline.processGlb(glb1, { dracoOptions: { compressionLevel: 7 } });
  // Make the materials unlit: rewrite the GLB JSON chunk.
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "KHR_materials_unlit"])];
  for (const m of json.materials ?? []) m.extensions = { ...m.extensions, KHR_materials_unlit: {} };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = glb.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.write("glTF", 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + j.length + bin.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.write("JSON", 16);
  const glb2 = Buffer.concat([head, j, bin]);
  // b3dm with an empty batch: feature table {"BATCH_LENGTH":0} padded to 8 bytes.
  let ft = Buffer.from(JSON.stringify({ BATCH_LENGTH: 0 }));
  ft = Buffer.concat([ft, Buffer.alloc((8 - ((28 + ft.length) % 8)) % 8, 0x20)]);
  const h = Buffer.alloc(28);
  h.write("b3dm", 0);
  h.writeUInt32LE(1, 4);
  h.writeUInt32LE(28 + ft.length + glb2.length, 8);
  h.writeUInt32LE(ft.length, 12);
  return Buffer.concat([h, ft, glb2]);
}

// Simple worker pool so a few hundred tiles download and convert in parallel.
const jobs = [];
function queue(url, file) {
  jobs.push({ url, file });
  return path.basename(file);
}
async function runJobs(n = 8) {
  let next = 0, done = 0, bytes = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const { url, file } = jobs[next++];
        if (!fs.existsSync(file)) {
          const out = await convertB3dm(await get(url));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, out);
        }
        bytes += fs.statSync(file).size;
        if (++done % 50 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} tiles, ${(bytes / 1e6).toFixed(0)} MB`);
      }
    }),
  );
}

console.log("· Lyon 2023 photomesh: reading the publisher's tile index (21 MB)");
const pyramid = JSON.parse((await get(`${BASE}/pyramid/tileset.json`)).toString());
function findNode(t) {
  if (t.content?.uri === `${NODE}.b3dm`) return t;
  for (const c of t.children ?? []) {
    const r = findNode(c);
    if (r) return r;
  }
}
const root = findNode(pyramid.root);
if (!root) throw new Error(`Pyramid tile ${NODE} not found`);

fs.mkdirSync(OUT, { recursive: true });
const blocks = [];
// Pyramid nodes keep their content; leaves point at one block's own tileset.
function rewritePyramid(t) {
  const uri = t.content.uri;
  if (uri.endsWith(".json")) {
    const name = uri.split("/")[1]; // ../Tile-93-172-1-1/tileset.json
    blocks.push(name);
    return { ...t, content: { ...t.content, uri: `${name}/tileset.json` } };
  }
  queue(`${BASE}/pyramid/${uri}`, path.join(OUT, "pyramid", uri));
  return { ...t, content: { ...t.content, uri: `pyramid/${uri}` }, children: t.children?.map(rewritePyramid) };
}
const newRoot = rewritePyramid(root);

console.log(`· ${blocks.length} blocks under ${NODE}, keeping ${blockDepth} levels in each`);
for (const name of blocks) {
  const ts = JSON.parse((await get(`${BASE}/${name}/tileset.json`)).toString());
  const prune = (t, depth) => {
    queue(`${BASE}/${name}/${t.content.uri}`, path.join(OUT, name, t.content.uri));
    if (depth + 1 >= blockDepth || !t.children?.length) return { ...t, geometricError: t.children?.length ? 0 : t.geometricError, children: undefined };
    return { ...t, children: t.children.map((c) => prune(c, depth + 1)) };
  };
  ts.root = prune(ts.root, 0);
  fs.mkdirSync(path.join(OUT, name), { recursive: true });
  fs.writeFileSync(path.join(OUT, name, "tileset.json"), JSON.stringify(ts));
}

await runJobs();
fs.writeFileSync(
  path.join(OUT, "tileset.json"),
  JSON.stringify({ asset: { version: "1.0" }, geometricError: newRoot.geometricError * 2, root: newRoot }),
);
fs.writeFileSync(
  path.join(OUT, "README.md"),
  `# Lyon 2023 photomesh · ${NODE}\n\nSource: Métropole de Lyon, Photomaillage 3D (aerial survey of summer 2023, 5.5 cm), ` +
    `https://data.grandlyon.com/portail/fr/jeux-de-donnees/photomaillage-3d-de-la-metropole-de-lyon. ` +
    `Licence Ouverte 2.0 (Etalab). Converted to glTF 2.0 (Draco, unlit) by scripts/fetch-lyon-photomesh.mjs; ` +
    `${blocks.length} blocks, ${blockDepth} levels kept per block.\n`,
);
console.log(`Done: ${OUT}`);
