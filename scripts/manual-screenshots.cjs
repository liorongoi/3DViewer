// The user manual's screenshots (WP 6.6), in English and Hebrew, from the real web app against the
// real server and its sample library. Run it again after a change to the interface:
//
//   build apps/web and apps/server, start `vite preview` on :4173, then
//   node scripts/manual-screenshots.cjs [en|he]
//
// Writes docs/manual/img/<lang>/<name>.png. CHROMIUM may point at a Chromium binary.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs/manual/img");
const MODEL = /A Beautiful Game/;

(async () => {
  const I18N = await import(path.join(ROOT, "packages/shared/src/i18n.ts"));
  const langs = process.argv[2] ? [process.argv[2]] : ["en", "he"];
  const password = "manual-screens-0123";
  const { stop } = await startServer({ password });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const failed = [];
  try {
    for (const lang of langs) {
      const T = I18N[lang];
      const dir = path.join(OUT, lang);
      fs.mkdirSync(dir, { recursive: true });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      ctx.setDefaultTimeout(60000);
      await ctx.addInitScript((l) => {
        localStorage.setItem("viewer.lang", l);
        localStorage.setItem("viewer.theme", "dark");
        localStorage.setItem("viewer.fadeTools", "false");
        localStorage.setItem("viewer.onboarding", "1");
        localStorage.setItem("viewer.quality", "low");
      }, lang);
      const page = await ctx.newPage();
      const btn = (name) => page.getByRole("button", { name, exact: true }).first();
      const tab = (name) => page.getByRole("tab", { name, exact: true }).first();
      /** Renders until the globe and the model have loaded, then a little more. */
      const settle = () =>
        page.evaluate(async () => {
          const e = window.viewerEngine;
          const t0 = performance.now();
          for (let quiet = 0; quiet < 4 && performance.now() - t0 < 60000; ) {
            e.widget.scene.requestRender();
            e.widget.render();
            await new Promise((r) => setTimeout(r, 300));
            const tiles = !e.tileset || e.tileset.tilesLoaded;
            quiet = e.widget.scene.globe.tilesLoaded && tiles ? quiet + 1 : 0;
          }
        });
      const shot = async (name, prepare) => {
        try {
          await prepare();
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(dir, `${name}.png`) });
          console.log(`  ${lang}/${name}.png`);
        } catch (e) {
          failed.push(`${lang}/${name}: ${String(e.message ?? e).split("\n")[0]}`);
        }
        // Back to the plain view.
        for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
      };

      await page.goto("http://localhost:4173/", { waitUntil: "load" });
      await page.waitForFunction(() => !!window.viewerEngine?.widget, null, { timeout: 60000 });
      await page.getByRole("button", { name: MODEL }).first().waitFor();
      await settle();

      // ---- The library ----
      await shot("library", async () => {});
      await shot("upload", async () => {
        await btn(T.library.upload).click();
        await page.getByRole("dialog").first().waitFor();
      });

      // ---- The viewer ----
      await page.getByRole("button", { name: MODEL }).first().click();
      await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
      await settle();
      await shot("viewer", async () => {});
      await shot("layers", async () => {
        if ((await tab(T.viewer.layers).count()) === 0) await page.keyboard.press("l");
        await tab(T.viewer.layers).click();
      });
      await shot("map", async () => {
        if ((await tab(T.shell.mapData).count()) === 0) await page.keyboard.press("l");
        await tab(T.shell.mapData).click();
      });
      if ((await tab(T.viewer.layers).count()) > 0) await page.keyboard.press("l");

      await shot("measure", async () => {
        // Two points on the board, as a user clicks them.
        await page.keyboard.press("m");
        const box = await page.locator("canvas").first().boundingBox();
        await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
        await page.waitForTimeout(400);
        await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
        await page.waitForTimeout(400);
        await page.keyboard.press("Escape");
        if ((await tab(T.viewer.measurements).count()) === 0) await page.keyboard.press(".");
        await tab(T.viewer.measurements).click();
        await settle();
      });
      await shot("analysis", async () => {
        if ((await tab(T.side.analysis).count()) === 0) await page.keyboard.press(".");
        await tab(T.side.analysis).click();
      });
      await shot("properties", async () => {
        if ((await tab(T.viewer.properties).count()) === 0) await page.keyboard.press(".");
        await tab(T.viewer.properties).click();
      });
      await shot("flyby", async () => {
        if ((await tab(T.side.flyBy).count()) === 0) await page.keyboard.press(".");
        await tab(T.side.flyBy).click();
      });
      if ((await tab(T.viewer.measurements).count()) > 0) await page.keyboard.press(".");

      await shot("palette", async () => {
        await page.keyboard.press("Control+k");
        await page.getByRole("option").first().waitFor();
      });
      await shot("help", async () => {
        await btn(T.viewer.help).click();
        await page.getByRole("dialog", { name: T.help.title }).waitFor();
      });
      await shot("settings", async () => {
        await btn(T.viewer.settings).click();
        await page.getByRole("dialog", { name: T.viewer.settings }).waitFor();
      });
      await shot("admin", async () => {
        await btn(T.viewer.settings).click();
        await btn(T.settings.admin).click();
        const dlg = page.getByRole("dialog", { name: T.admin.title });
        await dlg.waitFor();
        await dlg.locator("input[type=password]").fill(password);
        await page.keyboard.press("Enter");
        await page.getByRole("navigation", { name: T.admin.sections }).waitFor({ timeout: 15000 });
      });
      await ctx.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  if (failed.length) {
    console.log(`\nNot taken:\n  ${failed.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nAll screenshots taken.");
})();
