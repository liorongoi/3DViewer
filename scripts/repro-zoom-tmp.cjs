// Temporary repro: does the point under the cursor stay put during a wheel zoom, with the
// normal render loop (adaptive resolution on) at a Windows display scale?
const { chromium } = require("playwright");
const DPR = Number(process.env.DPR ?? 1.25);
const ID = process.env.MODEL ?? "m-tiles-city";
(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: DPR });
  await ctx.addInitScript(() => { localStorage.setItem("viewer.lang", "en"); });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  await page.evaluate(async (id) => { const e = window.viewerEngine; const { SAMPLE_LIBRARY } = await import("/src/none.js").catch(() => ({})); }, ID).catch(()=>{});
  const label = { "m-chess": "A Beautiful Game", "m-tiles-lod": "Discrete LOD", "m-tiles-city": "City block" }[ID] ?? ID;
  await page.getByRole("button", { name: new RegExp(label) }).first().click();
  await page.waitForFunction((id) => window.viewerEngine.current.get()?.id === id && (window.viewerEngine.model?.ready || window.viewerEngine.tileset), ID, { timeout: 120000 });
  await page.waitForTimeout(6000);
  const box = await page.locator(".cesium-widget canvas").boundingBox();
  const cx = box.width * 0.7, cy = box.height * 0.6;
  await page.mouse.move(box.x + cx, box.y + cy);
  await page.waitForTimeout(500);
  // The world point under the cursor before zooming.
  await page.evaluate(({ cx, cy }) => {
    const e = window.viewerEngine;
    const C2 = e.widget.scene.camera.position.constructor; // Cartesian3
    window.__p = e.pick(new (window.Cesium?.Cartesian2 ?? function (x, y) { this.x = x; this.y = y; })(cx, cy));
    window.__log = [];
    const sc = e.widget.scene;
    sc.postRender.addEventListener(() => {
      if (!window.__p) return;
      const s = sc.cartesianToCanvasCoordinates(window.__p);
      window.__log.push({ t: performance.now(), x: s?.x, y: s?.y, res: e.widget.resolutionScale, h: sc.camera.positionCartographic.height });
    });
  }, { cx, cy });
  const p0 = await page.evaluate(() => !!window.__p);
  console.log("picked", p0, "DPR", DPR, "base", await page.evaluate(() => window.viewerEngine.baseScale ?? null));
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(120); }
  await page.waitForTimeout(3000);
  const log = await page.evaluate(() => window.__log);
  let worst = 0;
  for (const l of log) if (l.x !== undefined) worst = Math.max(worst, Math.hypot(l.x - cx, l.y - cy));
  const scales = [...new Set(log.map((l) => l.res.toFixed(3)))];
  console.log("frames", log.length, "worst drift px", worst.toFixed(1), "scales", scales.join(","), "final", log.at(-1) && [log.at(-1).x?.toFixed(1), log.at(-1).y?.toFixed(1)], "target", cx.toFixed(1), cy.toFixed(1));
  await browser.close();
})();
