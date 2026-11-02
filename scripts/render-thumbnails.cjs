// Renders a thumbnail turntable sprite (24 frames, 320x180 each) for every sample model
// using the real viewer core, so cards look exactly like the viewer (UPL-08).
// The server renders uploads the same way (apps/server/src/thumbnails.ts, plan WP 3.5).
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
  await page.waitForFunction(() => !!window.viewerEngine && !!window.__renderTurntable && !!window.__samples, null, { timeout: 60000 });
  const library = await page.evaluate(() => window.__samples);
  page.on("console", (m) => console.log("page:", m.text().slice(0, 200)));
  const only = process.argv[2];
  for (const m of library.filter((x) => !only || x.id === only)) {
    const t0 = Date.now();
    // The same renderer the server's thumbnail worker uses (apps/web/src/thumbnail.ts).
    // Samples are rendered without the classification band; uploads get theirs on the server.
    const dataUrl = await page.evaluate((model) => window.__renderTurntable(model, null), m);
    if (!dataUrl) { console.log("skip", m.id); continue; }
    fs.writeFileSync(path.join(out, `${m.id}.webp`), Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log("ok", m.id, Date.now() - t0, "ms");
  }
  await browser.close();
})();
