// AC-10 / NFR-12, the browser side: a full working session sends nothing outside the VIEWER server.
//
// Run by scripts/check-outbound.sh, inside a network namespace whose packets are captured; it can
// also run on its own against `vite preview` on :4173. With the real server (and its upload
// workers), in English then Hebrew, it:
//   - opens the library and a model from the server, and each part of the interface (side tabs,
//     layers, map data, settings, help, the palette);
//   - selects every base map and terrain that is not marked online;
//   - uploads and publishes a model through the wizard, and opens it;
//   - signs in as administrator and opens each admin section;
//   - then sets "hide online sources" and checks that the pickers offer no online source.
// Every request the page, its workers and its frames make is recorded; any to a host other than
// the web app and the server fails the check. The list is written to <out>/requests.txt.
//
// Usage: node scripts/check-outbound.cjs [out folder]. CHROMIUM may point at a Chromium binary.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");

const ROOT = path.resolve(__dirname, "..");
const PASSWORD = "check-server-only-0123";
const LOCAL = new Set(["localhost:4173", "127.0.0.1:4173", "localhost:8787", "127.0.0.1:8787"]);

(async () => {
  const out = path.resolve(process.argv[2] || "check-out/outbound");
  fs.mkdirSync(out, { recursive: true });
  const I18N = await import(path.join(ROOT, "packages/shared/src/i18n.ts"));
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) {
      failed++;
      if (detail) console.log(`     ${String(detail).split("\n").join("\n     ")}`);
    }
  };

  const { api, stop } = await startServer({ password: PASSWORD, workers: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const requests = [];
  const record = (url, what) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return; // data:, blob:: never leave the machine
    requests.push({ host: u.host, url, what });
  };

  try {
    for (const lang of ["en", "he"]) {
      console.log(`· ${lang}`);
      const T = I18N[lang];
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      ctx.setDefaultTimeout(120000);
      await ctx.addInitScript((l) => {
        localStorage.setItem("viewer.lang", l);
        localStorage.setItem("viewer.fadeTools", "false");
        localStorage.setItem("viewer.quality", "low");
      }, lang);
      ctx.on("request", (r) => record(r.url(), `${lang} ${r.resourceType()}`));
      ctx.on("serviceworker", (w) => record(w.url(), `${lang} service worker`));
      const page = await ctx.newPage();
      page.on("websocket", (w) => record(w.url(), `${lang} websocket`));
      page.on("worker", (w) => record(w.url(), `${lang} worker`));
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const btn = (name) => page.getByRole("button", { name, exact: true }).first();
      const settle = (ms = 800) => page.waitForTimeout(ms);
      const ready = () => page.waitForFunction(() => window.viewerEngine?.model?.ready && !window.viewerEngine.loading.get(), null, { timeout: 120000 });

      await page.goto("http://localhost:4173/", { waitUntil: "load" });
      await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
      await page.waitForSelector("[data-model-card]", { timeout: 60000 });
      await settle(1500);
      check(true, `${lang}: the library opens`);

      await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
      await ready();
      await settle(1500);
      check(true, `${lang}: a model from the server opens`);

      for (const name of [T.viewer.measurements, T.side.analysis, T.viewer.properties, T.side.flyBy]) {
        const tab = page.getByRole("tab", { name, exact: true });
        if (await tab.count()) await tab.click().then(settle, () => {});
      }
      await page.getByRole("tab", { name: T.viewer.layers, exact: true }).click().catch(() => {});
      await settle();

      // Every base map and terrain that is not online (bundled, offline and the site's own).
      await page.getByRole("tab", { name: T.shell.mapData, exact: true }).click();
      await settle();
      const radios = page.locator("[role=radio]");
      const n = await radios.count();
      let chosen = 0;
      for (let i = 0; i < n; i++) {
        const r = radios.nth(i);
        const note = (await r.locator("span.uppercase").textContent().catch(() => "")) ?? "";
        if (note.trim() === T.map.online || (await r.isDisabled())) continue;
        await r.click();
        await settle(1500);
        chosen++;
      }
      check(chosen >= 2, `${lang}: every offline base map and terrain was shown (${chosen})`);

      await btn(T.viewer.settings).click();
      await settle(400);
      await page.keyboard.press("Escape");
      await btn(T.viewer.help).click();
      await settle(400);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await settle(400);
      await page.keyboard.press("Escape");

      if (lang === "en") {
        // Upload and publish a model: the server's checks and conversion run on it.
        await page.keyboard.press("Control+k");
        await page.getByRole("option", { name: T.library.upload }).first().click();
        const dialog = page.getByRole("dialog", { name: T.upload.title });
        await dialog.locator('input[type="file"]').first().setInputFiles(path.join(ROOT, "apps/web/public/samples/khronos/Lantern.glb"));
        await dialog.getByTestId("upload-report").waitFor({ timeout: 60000 });
        const next = dialog.getByRole("button", { name: T.common.next, exact: true });
        await next.click();
        const inputs = dialog.locator("input.num");
        await inputs.nth(0).fill("34.78");
        await inputs.nth(1).fill("32.08");
        await next.click();
        await next.click();
        await dialog.getByLabel(/Model name/).fill("Lantern, outbound check");
        await dialog.locator("select.font-semibold").selectOption({ index: 1 });
        await dialog.getByRole("button", { name: T.upload.publish, exact: true }).click();
        await dialog.waitFor({ state: "detached", timeout: 180000 });
        await page.waitForFunction(() => window.viewerEngine.current.get()?.name === "Lantern, outbound check" && window.viewerEngine.model?.ready, null, { timeout: 120000 });
        await settle(1500);
        check(true, `${lang}: a model is uploaded, published and opened`);
      }

      // The admin page, each section.
      await btn(T.viewer.settings).click();
      await page.getByRole("button", { name: T.settings.admin, exact: true }).click();
      const admin = page.getByRole("dialog", { name: T.admin.title });
      await admin.waitFor();
      const pw = admin.locator("input[type=password]").first();
      await pw.waitFor();
      await pw.fill(PASSWORD);
      await pw.press("Enter");
      await page.getByRole("navigation", { name: T.admin.sections }).waitFor({ timeout: 15000 });
      for (const id of ["levels", "basemaps", "storage", "delete", "audit", "password"]) {
        await page.getByRole("navigation", { name: T.admin.sections }).getByRole("button", { name: T.admin.tabs[id], exact: true }).click();
        await settle(500);
      }
      check(true, `${lang}: each admin section opens`);
      await page.keyboard.press("Escape");
      check(errors.length === 0, `${lang}: no page errors`, errors.join("\n"));
      await ctx.close();
    }

    // An air-gapped site hides the online sources: the pickers then offer none.
    const cfg = await api("GET", "/api/basemaps");
    await api("PUT", "/api/admin/basemaps", { ...cfg, hideOnline: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.quality", "low");
    });
    ctx.on("request", (r) => record(r.url(), `hide-online ${r.resourceType()}`));
    const page = await ctx.newPage();
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForSelector("[data-model-card]", { timeout: 60000 });
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
    await page.waitForFunction(() => window.viewerEngine?.model?.ready, null, { timeout: 120000 });
    await page.getByRole("tab", { name: I18N.en.shell.mapData, exact: true }).click();
    await page.waitForTimeout(800);
    const notes = await page.locator("[role=radio] span.uppercase").allTextContents();
    check(notes.length > 0 && !notes.some((x) => x.trim() === I18N.en.map.online), "with online sources hidden, the pickers offer none", notes.join(", "));
    await ctx.close();
  } catch (e) {
    for (const c of browser.contexts()) for (const p of c.pages()) await p.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
    check(false, "the session runs to the end", e.stack ?? e);
  } finally {
    await browser.close();
    stop();
  }

  const hosts = [...new Set(requests.map((r) => r.host))].sort();
  fs.writeFileSync(path.join(out, "requests.txt"), requests.map((r) => `${r.what}\t${r.url}`).join("\n") + "\n");
  const outside = requests.filter((r) => !LOCAL.has(r.host));
  check(requests.length > 0, `requests were recorded (${requests.length}, to ${hosts.join(", ")})`);
  check(outside.length === 0, "the browser asked nothing of any other host", [...new Set(outside.map((r) => `${r.what}: ${r.url}`))].slice(0, 30).join("\n"));
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll outbound checks passed.");
  process.exit(failed ? 1 : 0);
})();
