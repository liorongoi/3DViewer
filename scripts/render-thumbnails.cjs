// Renders a thumbnail turntable sprite (24 frames, 320x180 each) for every sample model
// using the real viewer core, so cards look exactly like the viewer (UPL-08).
// Prototype stand-in for the server thumbnail worker (plan WP 3.5).
// Usage: start `vite preview` on :4173, then `node scripts/render-thumbnails.cjs`.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const out = path.join(__dirname, "../apps/web/public/samples/thumbs");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine && !!window.Cesium && !!window.__samples, null, { timeout: 60000 });
  const library = await page.evaluate(() => window.__samples);
  page.on("console", (m) => console.log("page:", m.text().slice(0, 200)));
  const only = process.argv[2];
  for (const m of library.filter((x) => !only || x.id === only)) {
    const t0 = Date.now();
    const dataUrl = await page.evaluate(async (model) => {
      const e = window.viewerEngine;
      const C = window.Cesium;
      e.setGlobe(false);
      e.setShadows(true);
      e.widget.scene.skyAtmosphere.show = false;
      e.widget.scene.skyBox.show = false;
      e.widget.scene.backgroundColor = C.Color.fromCssColorString("#2A2E35");
      await e.open(model, { fly: false });
      const bs = e.boundingSphere();
      if (!bs) return null;
      // Let 3D Tiles refine.
      for (let i = 0; i < 40; i++) { e.widget.render(); await new Promise((r) => setTimeout(r, 50)); }
      const W = 320, H = 180, N = 24;
      const sprite = document.createElement("canvas");
      sprite.width = W * N; sprite.height = H;
      const ctx = sprite.getContext("2d");
      for (let i = 0; i < N; i++) {
        const heading = C.Math.toRadians(30 + (360 / N) * i);
        e.widget.camera.lookAt(bs.center, new C.HeadingPitchRange(heading, C.Math.toRadians(-22), bs.radius * 2.6));
        for (let k = 0; k < 3; k++) e.widget.render();
        ctx.drawImage(e.widget.canvas, i * W, 0, W, H);
      }
      e.widget.camera.lookAtTransform(C.Matrix4.IDENTITY);
      return sprite.toDataURL("image/webp", 0.82);
    }, m);
    if (!dataUrl) { console.log("skip", m.id); continue; }
    fs.writeFileSync(path.join(out, `${m.id}.webp`), Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log("ok", m.id, Date.now() - t0, "ms");
  }
  await browser.close();
})();
