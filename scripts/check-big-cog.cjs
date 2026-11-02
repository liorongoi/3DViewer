// WP 1.9 acceptance: a 2 GB Cloud Optimised GeoTIFF streams without loading fully.
//
// Writes a 2 GB tiled RGB GeoTIFF with overviews (COG layout, UTM 31N over Lyon), links it
// into the web build so `vite preview` serves it with range requests from the app's own
// origin, opens it in the real viewer as a user layer and looks at it from far and from
// close. It reports how many bytes the viewer actually read (from the browser's own count).
//
// Usage: build apps/web and start `vite preview` on :4173, then
//   node scripts/check-big-cog.cjs <work folder>   (needs about 2.2 GB free)
// Set CHROMIUM to a Chromium binary if Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TILE = 512;
const BASE = 23168; // pixels per side at full resolution: 1.6 GB of RGB, 2.15 GB with overviews

/** A classic TIFF, written in COG order: all IFDs first, then the tiles, smallest overview first. */
function writeCog(file) {
  const levels = [];
  for (let w = BASE; ; w = Math.ceil(w / 2)) {
    levels.push({ w, tx: Math.ceil(w / TILE) });
    if (w <= TILE) break;
  }
  const tileBytes = TILE * TILE * 3;
  const ifdSize = (lv, i) => 2 + 17 * 12 + 4 + 6 + 6 + lv.tx * lv.tx * 8 + (i === 0 ? 24 + 48 + 32 : 0);
  let off = 8;
  const ifdAt = levels.map((lv, i) => ((off += i ? ifdSize(levels[i - 1], i - 1) : 0), off));
  off += ifdSize(levels[levels.length - 1], levels.length - 1);
  off = Math.ceil(off / 16) * 16;
  // Tile data: smallest level first, as a COG puts it, so an overview read stays near the start.
  const dataAt = new Array(levels.length);
  for (let i = levels.length - 1; i >= 0; i--) (dataAt[i] = off), (off += levels[i].tx * levels[i].tx * tileBytes);
  const total = off;
  if (total >= 2 ** 32) throw new Error("Too big for classic TIFF");

  const fd = fs.openSync(file, "w");
  const head = Buffer.alloc(8);
  head.write("II", 0);
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdAt[0], 4);
  fs.writeSync(fd, head, 0, 8, 0);
  levels.forEach((lv, i) => {
    const n = lv.tx * lv.tx;
    const buf = Buffer.alloc(ifdSize(lv, i));
    const base = ifdAt[i];
    let extra = 2 + 17 * 12 + 4; // where arrays go, after the entries
    const tags = [];
    const put = (tag, type, count, value) => tags.push({ tag, type, count, value });
    const arr = (bytes) => { const at = base + extra; extra += bytes; return at; };
    const bps = arr(6), sf = arr(6), offs = arr(n * 4), counts = arr(n * 4);
    put(254, 4, 1, i ? 1 : 0);
    put(256, 4, 1, lv.w);
    put(257, 4, 1, lv.w);
    put(258, 3, 3, bps);
    put(259, 3, 1, 1);
    put(262, 3, 1, 2);
    put(277, 3, 1, 3);
    put(284, 3, 1, 1);
    put(322, 3, 1, TILE);
    put(323, 3, 1, TILE);
    // TIFF stores a value that fits in 4 bytes in the entry itself, so a single tile's offset and size go inline.
    put(324, 4, n, n === 1 ? dataAt[i] : offs);
    put(325, 4, n, n === 1 ? tileBytes : counts);
    put(339, 3, 3, sf);
    if (i === 0) {
      const scale = arr(24), tie = arr(48), keys = arr(32);
      put(33550, 12, 3, scale);
      put(33922, 12, 6, tie);
      put(34735, 3, 16, keys);
      const at = (p) => p - base;
      [1, 1, 0].forEach((v, k) => buf.writeDoubleLE(v, at(scale) + k * 8));
      [0, 0, 0, 630000, 5080000, 0].forEach((v, k) => buf.writeDoubleLE(v, at(tie) + k * 8));
      // GTModelType projected, RasterType pixel-is-area, ProjectedCSType EPSG:32631.
      [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32631].forEach((v, k) => buf.writeUInt16LE(v, at(keys) + k * 2));
    }
    tags.sort((a, b) => a.tag - b.tag);
    buf.writeUInt16LE(tags.length, 0);
    tags.forEach((t, k) => {
      const o = 2 + k * 12;
      buf.writeUInt16LE(t.tag, o);
      buf.writeUInt16LE(t.type, o + 2);
      buf.writeUInt32LE(t.count, o + 4);
      if (t.type === 3 && t.count === 1) buf.writeUInt16LE(t.value, o + 8);
      else buf.writeUInt32LE(t.value, o + 8);
    });
    // Unused entry slots stay zero; the next-IFD link follows the real entries.
    buf.writeUInt32LE(i + 1 < levels.length ? ifdAt[i + 1] : 0, 2 + tags.length * 12);
    [8, 8, 8].forEach((v, k) => buf.writeUInt16LE(v, bps - base + k * 2));
    [1, 1, 1].forEach((v, k) => buf.writeUInt16LE(v, sf - base + k * 2));
    for (let t = 0; t < n; t++) {
      buf.writeUInt32LE(dataAt[i] + t * tileBytes, offs - base + t * 4);
      buf.writeUInt32LE(tileBytes, counts - base + t * 4);
    }
    fs.writeSync(fd, buf, 0, buf.length, base);
  });
  // Pixels: a checkerboard of 1 km squares whose colour changes across the image, so any
  // tile read from the wrong place, level or row shows.
  const row = Buffer.alloc(TILE * 3);
  const tile = Buffer.alloc(tileBytes);
  levels.forEach((lv, i) => {
    const s = BASE / lv.w;
    for (let ty = 0; ty < lv.tx; ty++)
      for (let tx = 0; tx < lv.tx; tx++) {
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const gx = (tx * TILE + x) * s, gy = (ty * TILE + y) * s;
            const on = (Math.floor(gx / 1000) + Math.floor(gy / 1000)) % 2;
            row[x * 3] = on ? 40 + (gx / BASE) * 200 : 230;
            row[x * 3 + 1] = on ? 90 : 225;
            row[x * 3 + 2] = on ? 40 + (gy / BASE) * 200 : 210;
          }
          row.copy(tile, y * TILE * 3);
        }
        fs.writeSync(fd, tile, 0, tileBytes, dataAt[i] + (ty * lv.tx + tx) * tileBytes);
      }
  });
  fs.closeSync(fd);
  return total;
}

(async () => {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: node scripts/check-big-cog.cjs <work folder>");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "big.tif");
  let t0 = Date.now();
  const size = fs.existsSync(file) ? fs.statSync(file).size : writeCog(file);
  console.log(`COG: ${(size / 1024 ** 3).toFixed(2)} GB, written in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Served by vite preview from the web build, so the app's security policy allows it.
  const linkDir = path.join(__dirname, "../apps/web/dist/cog-check");
  fs.mkdirSync(linkDir, { recursive: true });
  try { fs.unlinkSync(path.join(linkDir, "big.tif")); } catch {}
  fs.symlinkSync(path.resolve(file), path.join(linkDir, "big.tif"));
  const url = "http://localhost:4173/cog-check/big.tif";
  const stats = { bytes: 0, requests: 0 };

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => console.log("page error:", e.message));
  page.on("requestfinished", async (req) => {
    if (!req.url().endsWith("/big.tif")) return;
    stats.requests++;
    stats.bytes += (await req.sizes()).responseBodySize;
  });
  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  t0 = Date.now();
  const info = await page.evaluate(async (u) => (await window.viewerEngine.userLayers.addGeoTiff(u, "2 GB test COG")).name ?? "added", url);
  console.log(`Opened (${info}) in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(stats.bytes / 1024 ** 2).toFixed(1)} MB read in ${stats.requests} requests`);

  const look = async (name, lon, lat, height) => {
    const before = stats.bytes;
    t0 = Date.now();
    await page.evaluate(([lon, lat, height]) => {
      // WGS 84 to Earth-centred coordinates, straight down from `height`.
      const a = 6378137, e2 = 6.69437999014e-3, f = Math.PI / 180;
      const N = a / Math.sqrt(1 - e2 * Math.sin(lat * f) ** 2);
      const x = (N + height) * Math.cos(lat * f) * Math.cos(lon * f);
      const y = (N + height) * Math.cos(lat * f) * Math.sin(lon * f);
      const z = (N * (1 - e2) + height) * Math.sin(lat * f);
      window.viewerEngine.widget.camera.setView({ destination: { x, y, z } });
    }, [lon, lat, height]);
    // Let the tiles load: render until the globe says it is done, or 90 s.
    await page.evaluate(async () => {
      const w = window.viewerEngine.widget;
      for (let i = 0; i < 900; i++) {
        w.render();
        if (w.scene.globe.tilesLoaded && i > 20) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.screenshot({ path: path.join(dir, `cog-${name}.png`) });
    console.log(`${name}: ${((stats.bytes - before) / 1024 ** 2).toFixed(1)} MB read in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };
  // The image covers 630–653 km E, 5057–5080 km N in UTM 31N: about 4.69–4.99° E, 45.65–45.86° N.
  await look("whole", 4.84, 45.755, 60000);
  await look("close", 4.75, 45.80, 2500);
  const share = stats.bytes / size;
  console.log(`Total read: ${(stats.bytes / 1024 ** 2).toFixed(1)} MB of ${(size / 1024 ** 2).toFixed(0)} MB (${(share * 100).toFixed(2)}%)`);
  await browser.close();
  fs.unlinkSync(path.join(linkDir, "big.tif"));
  if (share > 0.05) {
    console.log("FAIL: the viewer read more than 5% of the file");
    process.exit(1);
  }
  console.log("PASS: the COG streams without loading fully");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
