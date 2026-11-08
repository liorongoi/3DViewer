// WP 2.7 accuracy harness (NFR-07, NFR-18, AC-06): measurements against survey data, in both
// clients, the web app in Chromium and the desktop app (Electron).
//
// The survey (scripts/fixtures/survey-reference.json, from scripts/survey-reference.py through
// PROJ): a 24 × 14 × 9 m block surveyed in the Israeli grid (EPSG:2039) near Jerusalem, 800 m
// up, turned 30° from grid north. Its file is written as a producer would export it, in grid
// metres from the survey origin, and placed in the viewer from that origin with the app's own
// grid placement (the upload wizard's Place step), so grid north and grid scale are the app's
// to get right: 24 grid metres are 24.0028 m on the ground there.
//
// In each client, six distances are measured with the mouse, each end snapped to a corner:
// roof edges, a roof diagonal, a vertical edge, a ground edge and a space diagonal. Each must be
// within 1 cm or 0.1 % of the survey (NFR-07), and the two clients must agree to 1 mm (NFR-18).
//
// Usage: build apps/web and apps/desktop, start `vite preview` on :4173, fetch the Electron
// binary once (node node_modules/electron/install.js), then
//   xvfb-run node scripts/check-accuracy.cjs        (the desktop part needs a display)
// Set CHROMIUM to a Chromium binary if needed; SKIP_DESKTOP=1 runs the web part alone.
const fs = require("fs");
const path = require("path");
const { chromium, _electron } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SURVEY = require("./fixtures/survey-reference.json");
const OUT = path.join(ROOT, "apps/web/dist/samples/_check-accuracy");
const GLB = path.join(OUT, "block.glb");
const GLB_URL = "samples/_check-accuracy/block.glb";

// The app's own grid placement, from its TypeScript source.
const jitiPath = require.resolve("jiti", { paths: [path.dirname(require.resolve("vite/package.json", { paths: [path.join(ROOT, "apps/web")] }))] });
const jiti = require(jitiPath).createJiti(__filename);
const { placementFromGrid } = jiti(path.join(ROOT, "packages/core/src/geo/place.ts"));

const [E0, N0, H0] = SURVEY.origin;
const byName = Object.fromEntries(SURVEY.points.map((p) => [p.name, p]));
const PAIRS = [
  ["SW-roof", "SE-roof", "roof edge, long side"],
  ["SE-roof", "NE-roof", "roof edge, short side"],
  ["SW-roof", "NE-roof", "roof diagonal"],
  ["SE-ground", "SE-roof", "vertical edge"],
  ["SW-ground", "SE-ground", "ground edge"],
  ["SW-ground", "NE-roof", "space diagonal"],
];

// ---- The file: a closed box in grid metres from the survey origin, glTF y-up (x east, -z north) ----
function writeBlock(file) {
  const names = ["SW-ground", "SE-ground", "NE-ground", "NW-ground", "SW-roof", "SE-roof", "NE-roof", "NW-roof"];
  const v = names.map((n) => {
    const [e, nn, h] = byName[n].grid;
    return [e - E0, h - H0, -(nn - N0)];
  });
  // Faces as quads of corner indices, wound outward (counter-clockwise seen from outside).
  const quads = [
    [0, 3, 2, 1], // ground, seen from below
    [4, 5, 6, 7], // roof
    [0, 1, 5, 4], // south
    [1, 2, 6, 5], // east
    [2, 3, 7, 6], // north
    [3, 0, 4, 7], // west
  ];
  const pos = [];
  const idx = [];
  for (const q of quads) {
    const base = pos.length / 3;
    for (const i of q) pos.push(...v[i]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const p32 = new Float32Array(pos);
  const i16 = new Uint16Array(idx);
  const min = [0, 1, 2].map((k) => Math.min(...v.map((x) => x[k])));
  const max = [0, 1, 2].map((k) => Math.max(...v.map((x) => x[k])));
  const pad = Buffer.alloc((4 - (i16.byteLength % 4)) % 4);
  const bin = Buffer.concat([Buffer.from(p32.buffer), Buffer.from(i16.buffer), pad]);
  const json = {
    asset: { version: "2.0", generator: "check-accuracy" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Surveyed block", mesh: 0 }],
    meshes: [{ name: "Surveyed block", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.78, 0.74, 0.66, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: p32.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5123, count: i16.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: p32.byteLength, target: 34962 },
      { buffer: 0, byteOffset: p32.byteLength, byteLength: i16.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const chunk = (buf, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(buf.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, buf]);
  };
  const body = Buffer.concat([chunk(jsonBuf, 0x4e4f534a), chunk(bin, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

const truth = (a, b) => {
  const p = byName[a].ecef;
  const q = byName[b].ecef;
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

/** Opens the block in a page of either client and measures every pair with the mouse. */
async function measureAll(page, label, check) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // When drawing fails the viewer closes the model and logs why: show it, or a check that then
  // finds no model gives no clue.
  page.on("console", (m) => m.type() === "error" && /drawing failed/.test(m.text()) && console.log(`INFO the viewer closed the model: ${m.text()}`));
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
  await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
  await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
  const placement = placementFromGrid({ epsg: SURVEY.epsg, x: E0, y: N0, height: H0 });
  await page.evaluate(
    async ({ placement, url }) => {
      const e = window.viewerEngine;
      const s = e.current.get();
      await e.open({ ...s, id: "check-accuracy", name: "Surveyed block", placement, source: { kind: "glb", url } }, { fly: false });
      // Corners near the ground must not hide behind terrain: the survey is the only ground here.
      e.widget.scene.globe.show = false;
      e.widget.scene.shadowMap.enabled = false;
      e.shadowsWanted = false;
      e.widget.useDefaultRenderLoop = false;
      window.__renderTimer = setInterval(() => e.widget.render(), 100);
    },
    { placement, url: GLB_URL },
  );
  await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });

  // Where each named corner is on screen, after setting the view.
  const aim = (names) =>
    page.evaluate(
      async ({ pts }) => {
        const e = window.viewerEngine;
        const scene = e.widget.scene;
        const cam = scene.camera;
        const C3 = cam.position.constructor;
        // Standing south-south-east of the block, looking north-north-west: the south and east
        // faces, and so every corner the pairs use, face the camera.
        cam.lookAt(e.model.boundingSphere.center, { heading: (345 * Math.PI) / 180, pitch: (-28 * Math.PI) / 180, range: 70 });
        cam.lookAtTransform(cam.transform.constructor.IDENTITY);
        for (let i = 0; i < 4; i++) {
          e.widget.render();
          await new Promise((r) => setTimeout(r, 150));
        }
        return pts.map((p) => {
          const s = scene.cartesianToCanvasCoordinates(new C3(p[0], p[1], p[2]));
          return s ? [s.x, s.y] : null;
        });
      },
      { pts: names.map((n) => byName[n].ecef) },
    );

  const box = await page.locator("canvas").first().boundingBox();
  const results = [];
  await page.keyboard.press("m");
  for (const [a, b, what] of PAIRS) {
    const spots = await aim([a, b]);
    if (spots.some((s) => !s)) {
      check(false, `${label}: ${what}: both corners on screen`);
      continue;
    }
    // A few pixels off each corner: the snap must pull the point onto it.
    const off = [[3, -2], [-2, 3]];
    for (let i = 0; i < 2; i++) {
      const [x, y] = spots[i];
      await page.mouse.move(box.x + x + off[i][0], box.y + y + off[i][1], { steps: 3 });
      await page.waitForTimeout(400);
      await page.mouse.click(box.x + x + off[i][0], box.y + y + off[i][1]);
      await page.waitForTimeout(400);
    }
    const m = await page.evaluate(() => {
      const list = window.viewerEngine.measure.measurements.get();
      return list.length ? list[list.length - 1].result.total3d : null;
    });
    const t = truth(a, b);
    const tol = Math.max(0.01, t * 0.001);
    const err = m === null ? null : m - t;
    results.push(m);
    check(err !== null && Math.abs(err) <= tol, `${label}: ${what}, ${a} to ${b}: within 1 cm or 0.1 % of the survey`, err === null ? "no measurement" : `${m.toFixed(4)} m measured, ${t.toFixed(4)} m surveyed, ${(err * 1000).toFixed(1)} mm`);
    // Tighter than NFR-07: snapped to exact corners nothing should be lost, so a systematic error
    // (a grid scale applied to heights was 1 mm on these 9 m) shows long before it nears the limit.
    if (err !== null) check(Math.abs(err) <= 0.0005, `${label}: ${what}: and within 0.5 mm`, `${(err * 1000).toFixed(2)} mm`);
  }
  check(errors.length === 0, `${label}: no page errors`, errors.slice(0, 3).join(" | "));
  return results;
}

(async () => {
  writeBlock(GLB);
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  check(Math.abs(truth("SW-roof", "SE-roof") - 24) > 0.002, "the survey's 24 grid metres are not 24 m on the ground, so grid scale is tested", `${truth("SW-roof", "SE-roof").toFixed(4)} m`);

  // ---- The web app ----
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
  });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  const web = await measureAll(page, "web", check);
  await browser.close();

  // ---- The desktop app ----
  if (process.env.SKIP_DESKTOP) console.log("INFO desktop part skipped (SKIP_DESKTOP)");
  else {
    const app = await _electron.launch({
      executablePath: require(path.join(ROOT, "apps/desktop/node_modules/electron")),
      args: [path.join(ROOT, "apps/desktop"), "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      env: { ...process.env, VIEWER_WEB_DIR: path.join(ROOT, "apps/web/dist") },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("load");
    await win.evaluate(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
    });
    await win.reload({ waitUntil: "load" });
    const exe = await measureAll(win, "desktop", check);
    await app.close();
    PAIRS.forEach(([a, b, what], i) => {
      const d = web[i] !== null && exe[i] !== null ? Math.abs(web[i] - exe[i]) : null;
      check(d !== null && d <= 0.001, `web and desktop agree to 1 mm: ${what}`, d === null ? "missing" : `${(d * 1000).toFixed(3)} mm`);
    });
  }

  console.log(failed ? `${failed} check(s) failed` : "All accuracy checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
