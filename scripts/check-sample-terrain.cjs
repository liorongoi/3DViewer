// Every georeferenced 3D Tiles sample in the library sits inside an offline demo terrain area.
//
// The offline terrain (scripts/build-demo-basemaps.py) is detailed (z6–14) only over a few
// areas; elsewhere it falls back to world tiles at z0–3, a pixel every 20 km or so. A city
// sample outside those areas is then fitted to, and drawn on, ground that is tens of metres
// out. This compares each sample's centre in packages/shared/src/sample-library.ts with the
// REGIONS bounding boxes of build-demo-basemaps.py, and fails naming the samples left out and
// the box to add. No data needed: it reads the two source files.
//
// Usage: node scripts/check-sample-terrain.cjs
// The fetch scripts for city samples run it at the end, as a warning.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const py = fs.readFileSync(path.join(root, "scripts/build-demo-basemaps.py"), "utf8");
const regions = [...py.matchAll(/"([\w-]+)":\s*dict\(bbox=\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/g)].map((m) => ({ name: m[1], w: +m[2], s: +m[3], e: +m[4], n: +m[5] }));
if (!regions.length) throw new Error("No REGIONS found in scripts/build-demo-basemaps.py");

const lib = fs.readFileSync(path.join(root, "packages/shared/src/sample-library.ts"), "utf8");
// One entry per `id: "..."` block, up to the next one.
const blocks = lib.split(/\n\s*\{\s*\n\s*id: /).slice(1);
const samples = blocks
  .map((b) => ({
    id: b.match(/^"([^"]+)"/)?.[1],
    tiles: /kind: "3dtiles"/.test(b) && /groundFit: "(street|surface)"/.test(b),
    lat: +(b.match(/centre: \{ lat: ([-\d.]+)/)?.[1] ?? NaN),
    lon: +(b.match(/centre: \{ lat: [-\d.]+, lon: ([-\d.]+)/)?.[1] ?? NaN),
  }))
  .filter((s) => s.id && s.tiles && Number.isFinite(s.lat) && Number.isFinite(s.lon));

const outside = samples.filter((s) => !regions.some((r) => s.lon >= r.w && s.lon <= r.e && s.lat >= r.s && s.lat <= r.n));
for (const s of samples) {
  const r = regions.find((r) => s.lon >= r.w && s.lon <= r.e && s.lat >= r.s && s.lat <= r.n);
  console.log(`${r ? "ok  " : "MISS"} ${s.id} (${s.lat}, ${s.lon})${r ? ` in "${r.name}"` : ""}`);
}
if (outside.length) {
  console.log(`\nFAIL: ${outside.length} sample(s) outside the offline demo terrain. Add a region to REGIONS in scripts/build-demo-basemaps.py, for example:`);
  for (const s of outside) console.log(`  "${s.id}": dict(bbox=(${(s.lon - 0.02).toFixed(3)}, ${(s.lat - 0.012).toFixed(3)}, ${(s.lon + 0.02).toFixed(3)}, ${(s.lat + 0.012).toFixed(3)}), s2="<a Sentinel-2 L2A TCI.tif over it>"),`);
  process.exit(1);
}
console.log(`\nPASS: ${samples.length} georeferenced 3D Tiles samples, all inside the offline demo terrain`);
