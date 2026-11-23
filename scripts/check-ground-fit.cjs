// VWR-GEO-01: georeferenced cities sit on the terrain, whatever height datum they come in.
//
// Builds small synthetic cities (a flat street level with blocks of buildings, as 3D Tiles
// with a GLB tile) and synthetic Terrarium terrain, serves both to the real viewer through
// request interception, opens each city and reads the automatic ground fit's report.
// Each case reproduces a way the fit has gone wrong before:
//   A. Strasbourg: an ellipsoidal city (streets 48.5 m above sea-level terrain) whose root
//      volume covers 21 km for 300 m of data. The fit used to sample the root's area, miss
//      the data and leave the city floating.
//   B. Lyon Fourvière: an ellipsoidal city on terrain that rounds off the ground by ±9 m. The
//      fit used to measure 38 m for a 49.85 m datum gap and leave the quays floating.
//   C. Lyon 1st district: a city already in sea-level heights. It must not be moved.
//   D. Strasbourg with no terrain: the streets come down to the ellipsoid.
//   E. Two small patches 2 km apart: the fit cannot measure, so it must say so (report.ok
//      false, offset 0) rather than leave a shift nobody asked for.
//   F. Strasbourg as published: above the fine tile, a level of content with the same 21 km
//      volume (centred 3 km from the data), which is all that is drawn from the opening view.
//      PR #51 looked only at drawn tiles and still sampled the 21 km area (1 of 81 hits).
// A datum case passes when the shift is the geoid height to 0.5 m and at least 60 of the 81
// samples landed on the data.
//
// REAL=1 also opens the real samples (samples/3dtiles/lyon-photomesh, strasbourg-photomesh,
// lyon1) on the online AWS terrain when they are present: they must shift to within 2 m of
// the datum difference with at least 20 samples on the data. They are not in CI's light set.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-ground-fit.cjs [out folder]
// Set CHROMIUM to a Chromium binary if Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { chromium } = require("playwright");

// ---------- WGS 84 ----------
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const rad = (d) => (d * Math.PI) / 180;
function ecef(lat, lon, h) {
  const [p, l] = [rad(lat), rad(lon)];
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}
/** East-north-up frame at a point, as a column-major 4×4 (3D Tiles `transform`). */
function enu(lat, lon, h) {
  const [p, l] = [rad(lat), rad(lon)];
  const e = [-Math.sin(l), Math.cos(l), 0];
  const n = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const u = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  return [...e, 0, ...n, 0, ...u, 0, ...ecef(lat, lon, h), 1];
}

// ---------- GLB: a street level with blocks of buildings ----------
/**
 * Patches of `size` metres centred at (dx, dy) east/north of the tile's origin. Each is a
 * flat street level at height 0 with a 4 × 4 grid of buildings covering a quarter of it,
 * 12 to 30 m high, so the fit's low quantile lands on streets as it does in a real city.
 */
function cityGlb(patches) {
  const pos = [];
  const idx = [];
  // glTF is Y-up; 3D Tiles turns it Z-up: (east, up, -north).
  const v = (e, n, u) => (pos.push(e, u, -n), pos.length / 3 - 1);
  const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
  for (const { dx, dy, size } of patches) {
    const h = size / 2;
    quad(v(dx - h, dy - h, 0), v(dx + h, dy - h, 0), v(dx + h, dy + h, 0), v(dx - h, dy + h, 0));
    const cell = size / 4;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const cx = dx - h + cell * (i + 0.5);
        const cy = dy - h + cell * (j + 0.5);
        const b = cell / 4; // building half-width: a quarter of the area
        const top = 12 + ((i * 7 + j * 5) % 19);
        const c = [
          [cx - b, cy - b],
          [cx + b, cy - b],
          [cx + b, cy + b],
          [cx - b, cy + b],
        ];
        const lo = c.map(([e, n]) => v(e, n, 0));
        const hi = c.map(([e, n]) => v(e, n, top));
        quad(hi[0], hi[1], hi[2], hi[3]);
        for (let k = 0; k < 4; k++) quad(lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k]);
      }
  }
  const p = new Float32Array(pos);
  const ix = new Uint32Array(idx);
  const min = [0, 1, 2].map((k) => Math.min(...p.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...p.filter((_, i) => i % 3 === k)));
  const bin = Buffer.concat([Buffer.from(p.buffer), Buffer.from(ix.buffer)]);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.7, 0.6, 1], metallicFactor: 0 }, doubleSided: true }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: p.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5125, count: ix.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: p.byteLength },
      { buffer: 0, byteOffset: p.byteLength, byteLength: ix.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  return Buffer.concat([head, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}

/**
 * A tileset whose one content tile holds the patches, at street height h (ellipsoidal) over
 * (lat, lon). `bigRoot` gives the root a region 21 km across with no content, as the
 * Strasbourg publisher does.
 */
function cityTileset({ lat, lon, h, patches, bigRoot, coarse }) {
  const reach = Math.max(...patches.map((q) => Math.max(Math.abs(q.dx), Math.abs(q.dy)) + q.size / 2));
  const leaf = {
    transform: enu(lat, lon, h),
    boundingVolume: { box: [0, 0, 15, reach, 0, 0, 0, reach, 0, 0, 0, 16] },
    geometricError: 0,
    refine: "REPLACE",
    content: { uri: "city.glb" },
  };
  if (!bigRoot) return { asset: { version: "1.1" }, geometricError: 4000, root: leaf };
  // As the Strasbourg publisher: the whole Eurométropole, its centre 3 km south-west of the data.
  const [clat, clon] = [lat - 0.012, lon - 0.04];
  const region = { region: [rad(clon - 0.19), rad(clat - 0.14), rad(clon + 0.19), rad(clat + 0.14), -1607, 1668] };
  // `coarse`: a level of content with that same 21 km volume above the fine tile, coarse
  // enough to be all that is drawn from the opening view (the real one has 20 such levels).
  // A region ignores transforms, so the coarse tile can carry the ENU frame for its content
  // and its child while keeping the 21 km volume.
  const { transform, ...leafInFrame } = leaf;
  const mid = coarse ? { transform, boundingVolume: region, geometricError: 100, refine: "REPLACE", content: { uri: "coarse.glb" }, children: [leafInFrame] } : leaf;
  return { asset: { version: "1.1" }, geometricError: 4000, root: { boundingVolume: region, geometricError: 4000, refine: "REPLACE", children: [mid] } };
}

// ---------- Terrarium terrain ----------
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function png(size, rgbAt) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) rgbAt(x, y).forEach((v, k) => (raw[y * (size * 3 + 1) + 1 + x * 3 + k] = v));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A Terrarium tile (sea-level heights, as the real Terrain Tiles) from height(lat, lon). */
function terrariumTile(z, x, y, height) {
  const n = 2 ** z;
  return png(256, (px, py) => {
    const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / 256)) / n))) * 180) / Math.PI;
    const v = height(lat, lon) + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v) % 256;
    return [r, g, Math.floor((v - Math.floor(v)) * 256)];
  });
}

// ---------- cases ----------
const STRAS = { lat: 48.5818, lon: 7.7509, geoid: 48.48, ground: 140 };
const LYON = { lat: 45.7646, lon: 4.8239, geoid: 49.85, ground: 170 };
// Terrain that rounds the ground off by up to 9 m, in bumps about 250 m across.
const bumpy = (base) => (lat, lon) => base + 9 * Math.sin(rad(lat) * 6371000 / 40) * Math.cos(rad(lon) * 4450000 / 40);
const flat = (base) => () => base;
const block = [{ dx: 0, dy: 0, size: 300 }];

const twoPatches = [
  { dx: -1000, dy: 0, size: 12 },
  { dx: 1000, dy: 0, size: 12 },
];

const CASES = [
  {
    name: "A. Strasbourg: ellipsoidal, root volume 21 km across",
    site: STRAS,
    terrain: flat(STRAS.ground),
    tileset: cityTileset({ lat: STRAS.lat, lon: STRAS.lon, h: STRAS.ground + STRAS.geoid, patches: block, bigRoot: true }),
    expect: { shift: -STRAS.geoid, tol: 0.5, hits: 60 },
  },
  {
    name: "F. Strasbourg as published: coarse levels with the 21 km volume drawn first",
    site: STRAS,
    terrain: flat(STRAS.ground),
    tileset: cityTileset({ lat: STRAS.lat, lon: STRAS.lon, h: STRAS.ground + STRAS.geoid, patches: block, bigRoot: true, coarse: true }),
    expect: { shift: -STRAS.geoid, tol: 0.5, hits: 60 },
  },
  {
    name: "B. Lyon Fourvière: ellipsoidal, terrain off by ±9 m",
    site: LYON,
    terrain: bumpy(LYON.ground),
    tileset: cityTileset({ lat: LYON.lat, lon: LYON.lon, h: LYON.ground + LYON.geoid, patches: block }),
    expect: { shift: -LYON.geoid, tol: 0.5, hits: 60 },
  },
  {
    name: "C. Lyon 1st district: already in sea-level heights",
    site: LYON,
    terrain: bumpy(LYON.ground),
    tileset: cityTileset({ lat: LYON.lat, lon: LYON.lon, h: LYON.ground, patches: block }),
    expect: { shift: 0, tol: 0.01, hits: 60 },
  },
  {
    name: "D. Strasbourg with no terrain: streets on the ellipsoid",
    site: STRAS,
    terrainId: "none",
    tileset: cityTileset({ lat: STRAS.lat, lon: STRAS.lon, h: STRAS.ground + STRAS.geoid, patches: block, bigRoot: true }),
    expect: { shift: -(STRAS.ground + STRAS.geoid), tol: 0.5, hits: 60 },
  },
  {
    name: "E. Two small patches 2 km apart: the fit says it could not measure",
    site: STRAS,
    terrain: flat(STRAS.ground),
    tileset: cityTileset({ lat: STRAS.lat, lon: STRAS.lon, h: STRAS.ground + STRAS.geoid, patches: twoPatches }),
    patches: twoPatches,
    expect: { failed: true },
  },
];

const REAL = [
  { name: "Real: Lyon Fourvière photomesh", url: "samples/3dtiles/lyon-photomesh/tileset.json", site: LYON, shift: -LYON.geoid },
  { name: "Real: Strasbourg Grande Île photomesh", url: "samples/3dtiles/strasbourg-photomesh/tileset.json", site: STRAS, shift: -STRAS.geoid },
  { name: "Real: Lyon 1st district", url: "samples/3dtiles/lyon1/tileset.json", site: { lat: 45.77, lon: 4.8261 }, shift: 0 },
];

const summary = (id, url, site) => ({
  id,
  name: id,
  classificationId: "unclassified",
  status: "current",
  version: 1,
  versions: 1,
  sourceFormat: "3dtiles",
  centre: { lat: site.lat, lon: site.lon },
  source: { kind: "3dtiles", url, groundFit: "street" },
});

(async () => {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  page.on("pageerror", (e) => console.log("page error:", e.message));

  // The case being run decides what the interception serves.
  let current = null;
  const tileCache = new Map();
  await page.route("**/check-ground-fit/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("tileset.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(current.tileset) });
    if (u.pathname.endsWith(".glb")) return route.fulfill({ contentType: "model/gltf-binary", body: current.glb });
    return route.fulfill({ status: 404 });
  });
  await page.route("**/samples/terrain/**", (route) => {
    if (!current?.terrain) return route.fallback();
    const m = new URL(route.request().url()).pathname.match(/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) return route.fulfill({ status: 404 });
    const key = `${current.name}|${m[1]}/${m[2]}/${m[3]}`;
    if (!tileCache.has(key)) tileCache.set(key, terrariumTile(+m[1], +m[2], +m[3], current.terrain));
    return route.fulfill({ contentType: "image/png", body: tileCache.get(key) });
  });

  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  await page.evaluate(() => {
    const e = window.viewerEngine;
    // Rendered by hand, on a timer: Playwright stalls while software rendering runs flat out,
    // and height sampling only finishes on rendered frames.
    e.widget.useDefaultRenderLoop = false;
    setInterval(() => e.widget.render(), 100);
  });

  const run = (s, terrainId) =>
    page.evaluate(
      async ({ s, terrainId }) => {
        const e = window.viewerEngine;
        await e.setTerrain(terrainId);
        await e.open(s, { fly: true });
        const t0 = Date.now();
        while (!e.groundFit.get() && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 250));
        return { fit: e.groundFit.get(), offset: e.groundOffset.get() };
      },
      { s, terrainId },
    );

  let failed = 0;
  const report = (name, problems, r) => {
    const f = r.fit;
    const detail = f ? `shift ${r.offset.toFixed(2)} m, ${f.hits}/${f.samples} samples on the data, ${f.attempts} attempt(s)${f.gap !== null ? `, measured gap ${f.gap.toFixed(1)} m` : ""}${f.geoid !== null ? `, geoid ${f.geoid.toFixed(2)} m` : ""}` : "no fit report";
    console.log(`${problems.length ? "FAIL" : "ok  "} ${name}\n     ${detail}${problems.length ? `\n     ${problems.join("; ")}` : ""}`);
    if (problems.length) failed++;
  };

  for (const c of CASES) {
    current = { ...c, glb: cityGlb(c.patches ?? block) };
    const r = await run(summary(`gf-${c.name[0]}`, `check-ground-fit/${c.name[0]}/tileset.json`, c.site), c.terrainId ?? "local");
    const problems = [];
    const f = r.fit;
    if (!f) problems.push("the fit never reported");
    else if (c.expect.failed) {
      if (f.ok) problems.push("the fit claimed to measure");
      if (r.offset !== 0) problems.push(`shifted ${r.offset.toFixed(2)} m with nothing measured`);
    } else {
      if (!f.ok) problems.push("the fit could not measure");
      if (f.hits < c.expect.hits) problems.push(`only ${f.hits} samples on the data (need ${c.expect.hits})`);
      if (Math.abs(r.offset - c.expect.shift) > c.expect.tol) problems.push(`shift ${r.offset.toFixed(2)} m, expected ${c.expect.shift.toFixed(2)} ± ${c.expect.tol} m`);
    }
    report(c.name, problems, r);
    if (out) await page.screenshot({ path: path.join(out, `${c.name[0]}.png`) });
  }

  if (process.env.REAL) {
    current = null;
    const pub = path.join(__dirname, "../apps/web/public");
    for (const c of REAL) {
      if (!fs.existsSync(path.join(pub, c.url))) {
        console.log(`skip ${c.name}: ${c.url} is not here`);
        continue;
      }
      const r = await run(summary(`gf-real-${c.url}`, c.url, c.site), process.env.TERRAIN || "aws");
      const problems = [];
      if (!r.fit?.ok) problems.push("the fit could not measure");
      else if (r.fit.hits < 20) problems.push(`only ${r.fit.hits} samples on the data (need 20)`);
      if (Math.abs(r.offset - c.shift) > 2) problems.push(`shift ${r.offset.toFixed(2)} m, expected ${c.shift.toFixed(2)} ± 2 m`);
      report(c.name, problems, r);
    }
  }

  await browser.close();
  console.log(failed ? `\nFAIL: ${failed} case(s)` : "\nPASS: every city sits on the ground, and a fit that cannot measure says so");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
