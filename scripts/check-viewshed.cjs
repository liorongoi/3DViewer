// WP 2.9 viewshed check (VWR-ANL-03): the 360° visibility against gdal_viewshed on a test DEM.
//
// The reference (scripts/fixtures/viewshed-reference.json, from scripts/viewshed-reference.py)
// is gdal_viewshed run on the line-of-sight test DEM (scripts/fixtures/sight-dem.tif, 10 m cells,
// UTM 36N) from four observers: on a ridge, on a hill's flank, in a valley and on a 30 m mast,
// each with a 1 km radius, the target on the ground, and refraction k = 0.13.
//
// In the web app, with the DEM added as terrain the way a user adds it, for each observer:
//   - the visible area the panel works out is within 2 % of gdal_viewshed's (the plan's
//     acceptance), and cell by cell the two agree on at least 98 % of the ground;
//   - the GPU overlay, read back from the screen looking straight down, agrees with
//     gdal_viewshed on at least 95 % of the cells away from a visible / hidden edge;
// and, once: the panel's GeoTIFF export is a UTM 36N raster on the observer's grid whose seen
// cells add up to the area shown; and the scale bar reads the ground in the middle of the view.
//
// Usage: build apps/web, start `vite preview` on :4173, then node scripts/check-viewshed.cjs
// (CHROMIUM may point at a Chromium binary).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const REF = require("./fixtures/viewshed-reference.json");
const OUT = path.join(ROOT, "apps/web/dist/samples/_check-viewshed");
const DEM_URL = "samples/_check-viewshed/sight-dem.tif";

const jitiPath = require.resolve("jiti", { paths: [path.dirname(require.resolve("vite/package.json", { paths: [path.join(ROOT, "apps/web")] }))] });
const jiti = require(jitiPath).createJiti(__filename);
const { fromUtm } = jiti(path.join(ROOT, "packages/core/src/geo/utm.ts"));

const unpack = (b64, n) => {
  const bytes = Buffer.from(b64, "base64");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures/sight-dem.tif"), path.join(OUT, "sight-dem.tif"));
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
  await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
  await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
  await page.evaluate(async (url) => {
    const e = window.viewerEngine;
    const layer = await e.userLayers.addGeoTiff(url, "sight-dem");
    await e.userLayers.setAsTerrain(layer.id, true);
    if (e.model) e.model.show = false;
    e.widget.scene.shadowMap.enabled = false;
    e.shadowsWanted = false;
    e.widget.useDefaultRenderLoop = false;
  }, DEM_URL);
  // The panel, as a user opens it: the viewshed tool (V).
  await page.keyboard.press("v");
  await page.keyboard.press("Escape");

  const half = (REF.observers[0].size - 1) / 2;
  for (const [n, o] of REF.observers.entries()) {
    const label = `observer ${n + 1}, ${o.name} (eye ${o.eye} m)`;
    // ---- Place the observer and look straight down on it ----
    await page.evaluate(
      async ({ o, radius }) => {
        const e = window.viewerEngine;
        const C3 = e.widget.camera.position.constructor;
        const Carto = e.widget.camera.positionCartographic.constructor;
        const [g] = await e.sampleGround([Carto.fromDegrees(o.lon, o.lat)]);
        e.viewshed.set({ lon: o.lon, lat: o.lat, ground: g.height, height: o.eye, radius });
        e.widget.camera.setView({ destination: C3.fromDegrees(o.lon, o.lat, g.height + 2600), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        for (let i = 0; i < 40; i++) {
          e.widget.render();
          await new Promise((r) => setTimeout(r, 100));
          if (e.widget.scene.globe.tilesLoaded && i > 10) break;
        }
      },
      { o, radius: REF.radius },
    );

    // The scale bar measures at the ground in the middle of the view, wherever the camera was
    // put (it once read 20 km here, measured at the model the camera had left).
    if (n === 0) {
      const sc = await page.evaluate(() => {
        const e = window.viewerEngine;
        const cam = e.widget.camera;
        const h = cam.positionCartographic.height - e.viewshed.state.get().ground;
        const want = (2 * h * Math.tan(cam.frustum.fovy / 2)) / e.widget.scene.canvas.clientHeight;
        return { want, got: e.cameraInfo.get().metresPerPixel };
      });
      check(Math.abs(sc.got / sc.want - 1) < 0.05, "the scale bar is for the ground in the middle of the view", `${sc.got.toFixed(2)} m per pixel, ${sc.want.toFixed(2)} expected`);
    }

    // ---- The visible area, from the panel ----
    // How long the work takes in the page: sampling 161,000 ground points and the grid.
    // Best of three: software rendering in the same page makes single timings noisy.
    const areaS = await page.evaluate(async () => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await window.viewerEngine.viewshed.computeArea();
        best = Math.min(best, performance.now() - t);
      }
      window.viewerEngine.viewshed.area.set(null);
      return best / 1000;
    });
    check(areaS < 3, `${label}: the visible area is worked out in under 3 s`, `${areaS.toFixed(1)} s for 401 × 401 cells`);
    await page.getByTestId("viewshed-area").getByRole("button", { name: "Visible area" }).click();
    const seenEl = page.getByTestId("viewshed-area").locator("[data-seen]");
    await seenEl.waitFor({ timeout: 120000 });
    if (n === 0 && process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    const app = await page.evaluate(() => {
      const a = window.viewerEngine.viewshed.area.get();
      return { size: a.result.size, cell: a.result.cell, visible: Array.from(a.result.visible), visibleArea: a.result.visibleArea, area: a.result.area };
    });
    const shown = Number(await seenEl.getAttribute("data-seen"));
    check(shown === app.visibleArea, `${label}: the panel shows the area worked out`);
    const appFrac = app.visibleArea / app.area;
    const gdalFrac = o.visibleArea / o.area;
    check(Math.abs(appFrac - gdalFrac) <= 0.02, `${label}: visible area within 2 % of gdal_viewshed`, `${(appFrac * 100).toFixed(2)} % seen, gdal_viewshed ${(gdalFrac * 100).toFixed(2)} %`);
    // Cell by cell, where the viewer's grid (cell / 2 when 5 m) meets gdal's 10 m cells.
    const ratio = Math.round(REF.cell / app.cell);
    const am = (app.size - 1) / 2;
    const gdal = unpack(o.mask, o.size * o.size);
    let same = 0;
    let total = 0;
    for (let j = -half; j <= half; j++)
      for (let i = -half; i <= half; i++) {
        if (Math.hypot(i, j) * REF.cell > REF.radius) continue;
        const v = app.visible[(am + j * ratio) * app.size + (am + i * ratio)];
        if (v === 255) continue;
        total++;
        if (v === gdal[(half + j) * o.size + (half + i)]) same++;
      }
    check(same / total >= 0.98, `${label}: the grid agrees with gdal_viewshed cell by cell`, `${((same / total) * 100).toFixed(1)} % of ${total} cells`);

    // ---- The GPU overlay, read back from the screen ----
    // Cells away from a visible / hidden edge, every third one.
    const cells = [];
    for (let j = -half + 1; j < half; j += 3)
      for (let i = -half + 1; i < half; i += 3) {
        if (Math.hypot(i, j) * REF.cell > REF.radius * 0.95 || Math.hypot(i, j) < 3) continue;
        const v = gdal[(half + j) * o.size + (half + i)];
        let edge = false;
        for (let dj = -1; dj <= 1 && !edge; dj++) for (let di = -1; di <= 1; di++) if (gdal[(half + j + dj) * o.size + (half + i + di)] !== v) edge = true;
        if (edge) continue;
        const { lat, lon } = fromUtm({ zone: 36, hemisphere: "N", easting: o.x + i * REF.cell, northing: o.y - j * REF.cell });
        cells.push({ lon, lat, v });
      }
    const gpu = await page.evaluate(async (cells) => {
      const e = window.viewerEngine;
      const scene = e.widget.scene;
      const C3 = e.widget.camera.position.constructor;
      const Carto = e.widget.camera.positionCartographic.constructor;
      const ground = await e.sampleGround(cells.map((c) => Carto.fromDegrees(c.lon, c.lat)));
      e.viewshed.debugMode = 1; // blue = seen, straight from the comparison, no tint
      e.widget.render();
      const gl = scene.context._gl;
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      e.viewshed.debugMode = 0;
      const sx = W / scene.canvas.clientWidth;
      const sy = H / scene.canvas.clientHeight;
      let same = 0;
      let total = 0;
      cells.forEach((c, i) => {
        const s = scene.cartesianToCanvasCoordinates(C3.fromDegrees(c.lon, c.lat, ground[i].height));
        if (!s) return;
        const x = Math.round(s.x * sx);
        const y = H - 1 - Math.round(s.y * sy);
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const seen = px[(y * W + x) * 4 + 2] > 127 ? 1 : 0;
        total++;
        if (seen === c.v) same++;
      });
      return { same, total };
    }, cells);
    check(gpu.total > 0.9 * cells.length && gpu.same / gpu.total >= 0.95, `${label}: the overlay agrees with gdal_viewshed away from edges`, `${((gpu.same / gpu.total) * 100).toFixed(1)} % of ${gpu.total} cells`);

    // ---- The GeoTIFF export, once ----
    if (n === 0) {
      const dl = page.waitForEvent("download");
      await page.getByTestId("viewshed-area").getByRole("button", { name: "GeoTIFF" }).click();
      const file = await (await dl).path();
      const { fromArrayBuffer } = await import(require.resolve(path.join(ROOT, "packages/core/node_modules/geotiff/dist-node/geotiff.js")));
      const buf = fs.readFileSync(file);
      const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const img = await tiff.getImage();
      const [band] = await img.readRasters({ interleave: false });
      const keys = img.getGeoKeys();
      const [ox, oy] = img.getOrigin();
      const seen = band.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
      check(keys.ProjectedCSTypeGeoKey === 32636, "the GeoTIFF is in UTM 36N", `EPSG ${keys.ProjectedCSTypeGeoKey}`);
      check(img.getWidth() === app.size && img.getHeight() === app.size, "the GeoTIFF is the grid", `${img.getWidth()} × ${img.getHeight()}`);
      const am2 = (app.size - 1) / 2;
      check(Math.abs(ox + (am2 + 0.5) * app.cell - o.x) < 0.01 && Math.abs(oy - (am2 + 0.5) * app.cell - o.y) < 0.01, "the GeoTIFF's middle cell is the observer", `origin ${ox.toFixed(2)}, ${oy.toFixed(2)}`);
      check(seen * app.cell * app.cell === app.visibleArea, "the GeoTIFF's seen cells add up to the area shown", `${seen} cells`);
      check(img.getGDALNoData() === 255, "outside the radius is no data", `${img.getGDALNoData()}`);
    }
  }

  // Moving the observer clears the area: it was for the old place.
  await page.evaluate(() => window.viewerEngine.viewshed.setHeight(50));
  check(!(await page.evaluate(() => window.viewerEngine.viewshed.area.get())), "moving the observer clears the old area");

  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All viewshed checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
