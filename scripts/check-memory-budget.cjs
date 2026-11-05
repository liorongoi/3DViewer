// WP 1.5 acceptance for NFR-04 and NFR-02: GPU memory stays within the budget with no crash,
// and a 3D Tiles dataset shows its first view within 3 s.
//
// Opens the Lyon 1st district city mesh (3D Tiles, textured) in the real viewer and:
//   1. First view: the time from opening it to the first frame that draws one of its tiles.
//   2. Free run: with the default budget (10 GB), looks at the city from four close views and
//      notes the most GPU memory the tiles use.
//   3. Capped: sets the budget to 40% of that and looks again, sampling the memory on every
//      frame. It must stay within the budget; the viewer must keep drawing tiles (coarser
//      ones: Cesium raises the screen-space error it accepts) and raise no error.
//   4. Released: back to 10 GB, the detail comes back.
// Memory is Cesium's own count of what the tileset holds on the GPU (geometry and textures).
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-memory-budget.cjs
// The 3 s first view is judged only with JUDGE_FPS=1, on the target PC: software rendering
// here takes seconds to draw one frame.
// Set CHROMIUM to a Chromium binary if needed.
const { chromium } = require("playwright");

const LYON = {
  id: "mb-lyon",
  name: "Lyon",
  classificationId: "unclassified",
  status: "current",
  version: 1,
  versions: 1,
  sourceFormat: "3dtiles",
  centre: { lat: 45.77, lon: 4.8261 },
  source: { kind: "3dtiles", url: "samples/3dtiles/lyon1/tileset.json", groundFit: "street" },
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });

  // 1. First view (NFR-02).
  const first = await page.evaluate(async (summary) => {
    const e = window.viewerEngine;
    e.widget.scene.shadowMap.enabled = false;
    const t0 = performance.now();
    const before = performance.getEntriesByType("resource").length;
    let drawn = null;
    const off = e.widget.scene.postRender.addEventListener(() => {
      const ts = e.tileset;
      if (drawn === null && ts && ts.statistics.selected > 0) drawn = performance.now() - t0;
    });
    void e.open(summary, { fly: false });
    while (drawn === null && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 20));
    off();
    // When the first tile file had arrived: the server and network part of the first view.
    const tile = performance.getEntriesByType("resource").slice(before).find((r) => /\.(b3dm|glb|i3dm|pnts|cmpt)(\?|$)/.test(r.name));
    return { loaded: tile ? tile.responseEnd - t0 : null, drawn };
  }, LYON);
  const sec = (ms) => (ms === null ? "never" : `${(ms / 1000).toFixed(2)} s`);
  // Fetching the tileset and its first tiles is the part software rendering does not slow down.
  check(first.loaded !== null && first.loaded <= 3000, "the city's first tiles have arrived within 3 s", sec(first.loaded));
  // Drawing that first frame in software takes several seconds, so the full time is judged on the target PC.
  if (process.env.JUDGE_FPS) check(first.drawn !== null && first.drawn <= 3000, "first view of the 3D Tiles city within 3 s (NFR-02)", sec(first.drawn));
  else console.log(`INFO first view drawn after ${sec(first.drawn)} (software rendering; judged with JUDGE_FPS=1 on the target PC)`);

  // Four close views around the city, each held until its tiles have loaded.
  const tour = (label) =>
    page.evaluate(async (label) => {
      const e = window.viewerEngine;
      const ts = e.tileset;
      const bs = ts.boundingSphere;
      let peak = 0;
      let worstSse = ts.maximumScreenSpaceError;
      let frames = 0;
      let drawnFrames = 0;
      const off = e.widget.scene.postRender.addEventListener(() => {
        peak = Math.max(peak, ts.totalMemoryUsageInBytes);
        worstSse = Math.max(worstSse, ts.memoryAdjustedScreenSpaceError);
        frames++;
        if (ts.statistics.selected > 0) drawnFrames++;
      });
      for (const heading of [0, 90, 180, 270]) {
        e.widget.camera.flyToBoundingSphere(bs, { offset: { heading: (heading * Math.PI) / 180, pitch: -0.5, range: bs.radius * 0.6 }, duration: 0 });
        const t = performance.now();
        await new Promise((r) => setTimeout(r, 500));
        while (!ts.tilesLoaded && performance.now() - t < 120000) await new Promise((r) => setTimeout(r, 100));
      }
      off();
      return { label, peakMB: peak / 1048576, nowMB: ts.totalMemoryUsageInBytes / 1048576, sse: ts.maximumScreenSpaceError, worstSse, frames, drawnFrames };
    }, label);

  // 2. Free run.
  await page.evaluate(() => window.viewerEngine.setMemoryBudget(10 * 1024 ** 3));
  const free = await tour("10 GB");
  console.log(`INFO free run: tiles used up to ${free.peakMB.toFixed(1)} MB; screen-space error stayed at ${free.worstSse.toFixed(0)} (set ${free.sse})`);
  check(free.worstSse === free.sse, "with the default 10 GB budget, detail is never reduced for memory");

  // 3. Capped at 40% of what the free run used.
  const capMB = Math.max(16, free.peakMB * 0.4);
  await page.evaluate((mb) => window.viewerEngine.setMemoryBudget(mb * 1048576), capMB);
  // Lowered below what the view holds, the viewer coarsens and lets tiles go within a few frames.
  const settled = await page.evaluate(async (mb) => {
    const ts = window.viewerEngine.tileset;
    const t0 = performance.now();
    while (ts.totalMemoryUsageInBytes > mb * 1048576 * 1.05 && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
    return { s: (performance.now() - t0) / 1000, mb: ts.totalMemoryUsageInBytes / 1048576 };
  }, capMB);
  check(settled.mb <= capMB * 1.05, `lowered to ${capMB.toFixed(0)} MB, the viewer lets tiles go until it is within it`, `${settled.mb.toFixed(1)} MB after ${settled.s.toFixed(1)} s`);
  const capped = await tour(`${capMB.toFixed(0)} MB`);
  // One tile can arrive between two checks; Cesium unloads on the next frame.
  check(capped.peakMB <= capMB * 1.05, `with a ${capMB.toFixed(0)} MB budget, GPU memory stays within it`, `peak ${capped.peakMB.toFixed(1)} MB`);
  check(capped.worstSse > capped.sse, "over the budget the viewer draws coarser tiles instead", `screen-space error up to ${capped.worstSse.toFixed(1)} (set ${capped.sse})`);
  check(capped.frames > 0 && capped.drawnFrames === capped.frames, "it keeps drawing the city on every frame", `${capped.drawnFrames} of ${capped.frames} frames`);
  check(errors.length === 0, "no page errors while over budget", errors[0]);

  // 4. Released.
  await page.evaluate(() => window.viewerEngine.setMemoryBudget(10 * 1024 ** 3));
  const back = await tour("10 GB again");
  const sseNow = await page.evaluate(() => window.viewerEngine.tileset.memoryAdjustedScreenSpaceError);
  check(back.peakMB > capMB && sseNow < capped.worstSse, "with the budget raised again, detail comes back", `${back.peakMB.toFixed(1)} MB, screen-space error ${sseNow.toFixed(1)}`);

  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();
