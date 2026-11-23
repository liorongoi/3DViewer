// Downloads one area of the Strasbourg 2022 photomesh (aerial photogrammetry, 5 cm pixels,
// Licence Ouverte, Ville et Eurométropole de Strasbourg) and repackages it as a small,
// self-contained 3D Tiles sample with its LOD chain.
//
// The publisher already serves 3D Tiles 1.0 with b3dm holding glTF 2.0 and unlit materials,
// so tiles are copied as they are. The script walks the city tileset (following external
// tileset.json links), keeps every tile whose bounding region touches the chosen square and
// whose parent is still coarser than the finest error asked for, and writes one tileset.json.
//
// Usage: node scripts/fetch-strasbourg-photomesh.mjs <out dir> [lon] [lat] [half size m] [finest error m]
//   lon lat        centre, default 7.7509 48.5818 (Notre-Dame cathedral, Grande Île)
//   half size      half the side of the square in metres, default 300 (600 × 600 m)
//   finest error   stop below this geometric error, default 0.25 m
// Needs network access to s3.eu-west-2.wasabisys.com. No npm packages.
import fs from "node:fs";
import path from "node:path";

const ROOT_URL = "https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json";
const [OUT, LON = "7.7509", LAT = "48.5818", HALF = "300", MINERR = "0.25"] = process.argv.slice(2);
if (!OUT) throw new Error("Usage: fetch-strasbourg-photomesh.mjs <out dir> [lon] [lat] [half size m] [finest error m]");
const lon = Number(LON), lat = Number(LAT), half = Number(HALF), minErr = Number(MINERR);
const rad = Math.PI / 180;
const dLat = half / 6371000, dLon = half / (6371000 * Math.cos(lat * rad));
// Area of interest as a 3D Tiles region (radians).
const AOI = { w: lon * rad - dLon, s: lat * rad - dLat, e: lon * rad + dLon, n: lat * rad + dLat };

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

/** ECEF (m) → [lon, lat] in radians, WGS 84 (Bowring, good to well under a metre). */
function ecefToLonLat(x, y, z) {
  const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f), e2 = f * (2 - f), ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(z * a, p * b);
  const la = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  return [Math.atan2(y, x), la];
}

/** Region-like [w, s, e, n] (radians) of a bounding volume, or null when it can't be told. */
function footprint(bv, transform) {
  if (bv.region) return bv.region.slice(0, 4);
  const t = transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const apply = ([x, y, z]) => [t[0] * x + t[4] * y + t[8] * z + t[12], t[1] * x + t[5] * y + t[9] * z + t[13], t[2] * x + t[6] * y + t[10] * z + t[14]];
  let centre, r;
  if (bv.sphere) [centre, r] = [bv.sphere.slice(0, 3), bv.sphere[3]];
  else if (bv.box) {
    const h = bv.box;
    centre = h.slice(0, 3);
    r = Math.hypot(h[3], h[4], h[5]) + Math.hypot(h[6], h[7], h[8]) + Math.hypot(h[9], h[10], h[11]);
  } else return null;
  const [cl, cb] = ecefToLonLat(...apply(centre));
  const rl = r / (6371000 * Math.cos(cb)), rb = r / 6371000;
  return [cl - rl, cb - rb, cl + rl, cb + rb];
}
const touches = (f) => !f || (f[0] <= AOI.e && f[2] >= AOI.w && f[1] <= AOI.n && f[3] >= AOI.s);
const mul = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};

fs.mkdirSync(OUT, { recursive: true });
const jobs = [];
const seen = new Set();
/** Local file name for a remote tile URL: the path under the tileset folder, flattened. */
const base = ROOT_URL.slice(0, ROOT_URL.lastIndexOf("/") + 1);
const localName = (url) => url.slice(base.length).replace(/[^\w.-]+/g, "_");

let external = 0;
/** Returns the pruned copy of a tile, or null when it falls outside the area. */
async function walk(tile, url, parentTransform) {
  const world = mul(parentTransform, tile.transform);
  if (!touches(footprint(tile.boundingVolume, world))) return null;
  const out = { ...tile, children: undefined, content: undefined };
  delete out.contents;
  const uri = tile.content?.uri ?? tile.content?.url;
  let children = tile.children ?? [];
  if (uri) {
    const abs = new URL(uri, url).href;
    if (abs.split("?")[0].endsWith(".json")) {
      // External tileset: inline its root under this tile.
      external++;
      const ts = JSON.parse((await get(abs)).toString());
      const sub = await walk(ts.root, abs, world);
      if (!sub) return null;
      children = [];
      out.children = [sub];
    } else {
      const name = localName(abs.split("?")[0]);
      if (!seen.has(name)) {
        seen.add(name);
        jobs.push({ url: abs, file: path.join(OUT, "tiles", name) });
      }
      out.content = { uri: `tiles/${name}` };
    }
  }
  if (tile.geometricError > minErr && children.length) {
    const kept = [];
    for (const c of children) {
      const k = await walk(c, url, world);
      if (k) kept.push(k);
    }
    if (kept.length) out.children = [...(out.children ?? []), ...kept];
  }
  // A tile cut off from its children must not ask for more detail than it has.
  if (!out.children?.length && (tile.children?.length || (uri && !out.content))) out.geometricError = 0;
  return out;
}

console.log(`· Strasbourg 2022 photomesh: walking the city tileset for ${2 * half} × ${2 * half} m around ${lat}, ${lon}`);
const top = JSON.parse((await get(ROOT_URL)).toString());
const root = await walk(top.root, ROOT_URL, undefined);
if (!root) throw new Error("The area does not touch the Strasbourg photomesh");
console.log(`· ${jobs.length} tiles to fetch (${external} external tilesets read)`);

let next = 0, done = 0, bytes = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < jobs.length) {
      const { url, file } = jobs[next++];
      if (!fs.existsSync(file)) {
        const buf = await get(url);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      }
      bytes += fs.statSync(file).size;
      if (++done % 50 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} tiles, ${(bytes / 1e6).toFixed(0)} MB`);
    }
  }),
);

fs.writeFileSync(path.join(OUT, "tileset.json"), JSON.stringify({ asset: { version: "1.0" }, geometricError: top.geometricError ?? root.geometricError * 2, root }));
fs.writeFileSync(
  path.join(OUT, "README.md"),
  `# Strasbourg 2022 photomesh · ${2 * half} × ${2 * half} m around ${lat}, ${lon}\n\n` +
    `Source: Ville et Eurométropole de Strasbourg, Photomaillage 3D 2022 (aerial survey of June and August 2022, 5 cm), ` +
    `https://data.strasbourg.eu/explore/dataset/pm3d_2022/. Licence Ouverte. Co-funded by FEDER / DataGrandEst. ` +
    `Credit "Ville et Eurométropole de Strasbourg" and FEDER/DataGrandEst when showing or passing on this data. ` +
    `Copied by scripts/fetch-strasbourg-photomesh.mjs; ${jobs.length} tiles down to ${minErr} m geometric error.\n`,
);
console.log(`Done: ${OUT} (${(bytes / 1e6).toFixed(0)} MB)`);
