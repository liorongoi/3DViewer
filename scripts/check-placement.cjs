// WP 1.3 acceptance: test models land within 10 cm of surveyed positions.
//
// Surveyed points (scripts/proj-reference.py: grid coordinates and the WGS 84 position PROJ
// gives for each) are built into models the way a producer would export them, uploaded through
// the web app's own upload wizard, and opened. Where Cesium then draws each point is read back
// from the model and compared with the surveyed position:
//   A. ITM (EPSG:2039) on Mount Hermon, a Y-up GLB, position typed in the Place step
//   B. UTM 36N (EPSG:32636) at Eilat, a Z-up GLB, typed in
//   C. Israeli Grid 05/12 (EPSG:6991) in Tel Aviv, a Y-up GLB with a ContextCapture metadata.xml
//   D. Haifa, a GLB with its own CESIUM_RTC centre
// Each model holds one 2 cm marker at a surveyed point; the far corners of a 400 m by 300 m site
// are checked, with 25 m of relief.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-placement.cjs [out folder]
// Set CHROMIUM to a Chromium binary if Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
// fflate is a dependency of packages/core.
const { zipSync } = require(require.resolve("fflate", { paths: [path.join(__dirname, "../packages/core")] }));

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/core/src/geo/fixtures/proj-reference.json"), "utf8"));
const survey = (epsg, site) => ref.surveys.find((s) => s.epsg === epsg && s.site === site);

/** A GLB with one 2 cm marker whose box is centred on p, so its bounding sphere centre is p. */
function markerGlb(p, extra = {}) {
  const d = 0.01;
  const pos = new Float32Array([p[0] - d, p[1] - d, p[2] - d, p[0] + d, p[1] - d, p[2] + d, p[0], p[1] + d, p[2]]);
  const bin = Buffer.from(pos.buffer);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Survey marker", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: p.map((v) => v - d), max: p.map((v) => v + d) }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
    ...extra,
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

// WGS 84 geodetic to ECEF, double precision.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function ecef(lat, lon, h) {
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}

const corners = (s) => [s.points[0], s.points[2], s.points[3], s.points[4]];
const CASES = [
  { id: "A", what: "ITM, Mount Hermon, Y-up GLB, typed in", s: survey(2039, "Mount Hermon"), up: "y", typed: true },
  { id: "B", what: "UTM 36N, Eilat, Z-up GLB, typed in", s: survey(32636, "Eilat"), up: "z", typed: true },
  { id: "C", what: "Israeli Grid 05/12, Tel Aviv, Y-up GLB with metadata.xml", s: survey(6991, "Tel Aviv"), up: "y", sidecar: true },
  { id: "D", what: "Haifa, GLB with its own CESIUM_RTC centre", s: survey(2039, "Haifa"), rtc: true },
];

/** The files a producer would upload for one marker. */
function filesFor(c, pt) {
  const { s } = c;
  if (c.rtc) {
    const o = s.points[0];
    const centre = ecef(o.lat, o.lon, o.h);
    const p = ecef(pt.lat, pt.lon, pt.h);
    const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    // Cesium turns glTF Y-up to Earth Z: (x, y, z) → (x, −z, y).
    return { name: "port.glb", buffer: markerGlb([d[0], d[2], -d[1]], { extensionsUsed: ["CESIUM_RTC"], extensions: { CESIUM_RTC: { center: centre } } }) };
  }
  const dx = pt.x - s.origin.x;
  const dy = pt.y - s.origin.y;
  const dh = pt.h - s.origin.h;
  const glb = markerGlb(c.up === "z" ? [dx, dy, dh] : [dx, dh, -dy]);
  if (!c.sidecar) return { name: "site.glb", buffer: glb };
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<ModelMetadata version="1">\n\t<SRS>EPSG:${s.epsg}</SRS>\n\t<SRSOrigin>${s.origin.x},${s.origin.y},${s.origin.h}</SRSOrigin>\n</ModelMetadata>\n`;
  return { name: "site.zip", buffer: Buffer.from(zipSync({ "site/Data/site.glb": glb, "site/metadata.xml": Buffer.from(xml) })) };
}

(async () => {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => localStorage.setItem("viewer.lang", "en"));
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
    console.log(`page error: ${e.message}\n${e.stack ?? ""}`);
  });
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });

  let failed = 0;
  let worstAll = 0;
  const rows = [];
  for (const c of CASES) {
    let worst = 0;
    for (const [i, pt] of corners(c.s).entries()) {
      const dialog = page.getByRole("dialog", { name: "Upload a model" });
      // The library's button the first time; the command palette (Ctrl+K) once a model is open.
      const button = page.getByRole("button", { name: "Upload model" }).first();
      if (await button.isVisible()) await button.click();
      else {
        await page.keyboard.press("Control+k");
        await page.getByRole("option", { name: "Upload model" }).click();
      }
      await dialog.locator('input[type="file"]').first().setInputFiles(filesFor(c, pt));
      await dialog.getByTestId("upload-report").waitFor({ timeout: 30000 });
      const next = dialog.getByRole("button", { name: "Next" });
      await next.click();
      if (c.typed) {
        await dialog.locator("select").first().selectOption(String(c.s.epsg));
        const inputs = dialog.locator("input.num");
        await inputs.nth(0).fill(String(c.s.origin.x));
        await inputs.nth(1).fill(String(c.s.origin.y));
        await dialog.getByLabel("Sit the model base on the terrain").uncheck();
        await inputs.nth(2).fill(String(c.s.origin.h));
        await dialog.getByTestId("up-axis").selectOption(c.up);
      }
      if (i === 0) {
        const text = await dialog.innerText();
        if (c.sidecar) check(text.includes("The position comes from metadata.xml"), `${c.id}: the Place step says the position is from metadata.xml`);
        if (c.rtc) check(text.includes("The file has its own position."), `${c.id}: the Place step says the file has its own position`);
        if (!c.rtc) check(/grid north is [\d.]+° (east|west) of true north/.test(text), `${c.id}: the Place step shows grid north and grid scale`);
        if (out) await page.screenshot({ path: path.join(out, `${c.id}-place.png`) });
      }
      await next.click();
      await next.click();
      await dialog.locator("select.font-semibold").selectOption({ index: 1 });
      const before = await page.evaluate(() => window.viewerEngine.current.get()?.id ?? null);
      await dialog.getByRole("button", { name: "Publish" }).click();
      await dialog.waitFor({ state: "detached", timeout: 30000 });
      // The new model, not the one still open from the last point.
      await page.waitForFunction((id) => {
        const e = window.viewerEngine;
        return e.current.get()?.id !== id && e.model?.ready && e.current.get()?.id?.startsWith("upload-");
      }, before, { timeout: 60000 });
      const got = await page.evaluate(() => {
        const e = window.viewerEngine;
        e.widget.render();
        const m = e.current.get();
        const b = e.model.boundingSphere.center;
        return { c: [b.x, b.y, b.z], placement: m.placement ?? null, georeferenced: !!m.source.georeferenced };
      });
      const want = ecef(pt.lat, pt.lon, pt.h);
      const err = Math.hypot(got.c[0] - want[0], got.c[1] - want[1], got.c[2] - want[2]);
      worst = Math.max(worst, err);
      if (c.rtc && i === 0) check(got.georeferenced && !got.placement, `${c.id}: published with the file's own position, no placement`);
      if (c.sidecar && i === 0) check(got.placement?.grid?.epsg === c.s.epsg, `${c.id}: the placement records EPSG:${c.s.epsg} from metadata.xml`);
    }
    worstAll = Math.max(worstAll, worst);
    rows.push(`${c.id}  ${c.what}: worst ${(worst * 100).toFixed(1)} cm over ${corners(c.s).length} points`);
    check(worst < 0.1, `${c.id}: ${c.what} lands within 10 cm (worst ${(worst * 100).toFixed(1)} cm)`);
  }
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
  if (out) await page.screenshot({ path: path.join(out, "last-model.png") });
  await browser.close();
  console.log(`\n${rows.join("\n")}`);
  console.log(failed ? `\n${failed} check(s) failed.` : `\nAll checks passed. Worst point: ${(worstAll * 100).toFixed(1)} cm.`);
  process.exit(failed ? 1 : 0);

  function check(ok, what) {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failed++;
  }
})();
