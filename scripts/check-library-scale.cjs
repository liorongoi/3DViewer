// WP 6.3, NFR-06, the viewer side: the library page with a thousand models (5,000 versions) in the
// real web app against the real server.
//   - the library shows its cards no more than 1.5 s later than with the sample library alone (the
//     app's own start, in software rendering on CI, takes seconds either way);
//   - it fetches the turntable thumbnails only of the cards near the view, not of all of them;
//   - scrolling to the end brings the last cards' thumbnails;
//   - typing a search narrows the cards within half a second, in Hebrew too;
//   - a model far down the list opens.
// The server side (10 TB, the storage page, delete, quota) is apps/server/src/storage-scale.test.ts.
//
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
//   node scripts/check-library-scale.cjs
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");

const MODELS = 1000;

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  // The setup adds a thousand models at once: more changes than one address may make by default.
  const { api, stop } = await startServer({ env: { WRITE_RATE_LIMIT: "0" } });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const open = async (watch = () => {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(() => {
        localStorage.setItem("viewer.lang", "en");
        localStorage.setItem("viewer.quality", "low");
      });
      ctx.setDefaultTimeout(60000);
      const page = await ctx.newPage();
      watch(page);
      const t = Date.now();
      await page.goto("http://localhost:4173/", { waitUntil: "load" });
      await page.waitForSelector("[data-model-card]");
      return { ctx, page, ms: Date.now() - t };
    };
    const base = await open();
    const baseline = base.ms;
    await base.ctx.close();

    const sample = await api("GET", "/api/models/m-chess");
    let t = Date.now();
    for (let i = 1; i <= MODELS; i += 50)
      await Promise.all(
        Array.from({ length: Math.min(50, MODELS - i + 1) }, (_, k) => {
          const g = i + k;
          return api("POST", "/api/models", {
            name: g % 2 ? `Site ${g} block ${String.fromCharCode(65 + (g % 26))}` : `מבנה ${g} · גבעה ${g % 37}`,
            project: `פרויקט ${g % 20}`,
            operation: `Operation ${g % 12}`,
            responsibleEntity: `יחידה ${g % 8}`,
            status: ["draft", "inProduction", "current", "superseded"][g % 4],
            classificationId: sample.classificationId,
            sourceFormat: sample.sourceFormat,
            source: sample.source,
            centre: sample.centre,
            placement: sample.placement,
            sizeBytes: 2e9,
            versions: 5,
          });
        }),
      );
    console.log(`  ${MODELS} models of 5 versions added in ${((Date.now() - t) / 1000).toFixed(1)} s`);

    const thumbs = new Set();
    const errors = [];
    const big = await open((p) => {
      p.on("request", (r) => /\/thumbs\/|thumbnail/.test(r.url()) && thumbs.add(r.url()));
      p.on("pageerror", (e) => errors.push(e.message));
    });
    const { page } = big;
    await page.waitForFunction((n) => document.querySelectorAll("[data-model-card]").length > n, MODELS);
    const cards = await page.locator("[data-model-card]").count();
    check(big.ms - baseline < 1500, `the library shows all ${cards} cards`, `${(big.ms / 1000).toFixed(2)} s, against ${(baseline / 1000).toFixed(2)} s with the samples alone`);
    await page.waitForTimeout(1500);
    const first = thumbs.size;
    check(first > 0 && first < 120, "only the thumbnails near the view are fetched", `${first} of ${cards}`);

    // Scroll the list to its end: the last cards get theirs.
    await page.locator("[data-model-card]").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    const lastId = await page.evaluate(() => {
      const c = [...document.querySelectorAll("[data-model-card]")].at(-1);
      return c?.querySelector("[role=img], svg") ? "ok" : "none";
    });
    check(thumbs.size > first && lastId === "ok", "scrolling to the end brings the last cards' thumbnails (or their icon)", `${thumbs.size} fetched`);

    // Search: typing narrows the cards quickly.
    const search = page.getByRole("textbox", { name: "Search", exact: true }).first();
    for (const q of ["Site 77", "גבעה 12"]) {
      t = Date.now();
      await search.fill(q);
      await page.waitForFunction((n) => document.querySelectorAll("[data-model-card]").length < n, cards);
      const ms = Date.now() - t;
      const n = await page.locator("[data-model-card]").count();
      await search.fill("");
      await page.waitForFunction((n) => document.querySelectorAll("[data-model-card]").length === n, cards);
      check(ms < 500 && n > 0 && n < 100, `searching "${q}" narrows ${cards} cards to ${n}`, `${ms} ms, budget 500 ms`);
    }

    // A model far down the list opens.
    await search.fill("Site 999");
    await page.waitForFunction(() => document.querySelectorAll("[data-model-card]").length === 1);
    await page.locator("[data-model-card]").first().click();
    const opened = await page.waitForFunction(() => window.viewerEngine?.current.get()?.name?.startsWith("Site 999 "), null, { timeout: 120000 }).then(
      () => null,
      () => page.evaluate(() => JSON.stringify({ current: window.viewerEngine?.current.get()?.name, error: String(window.viewerEngine?.error.get() ?? ""), cards: [...document.querySelectorAll("[data-model-card]")].map((c) => c.textContent.slice(0, 40)) })),
    );
    if (opened) throw new Error(`the model did not open: ${opened}`);
    check(true, "a model far down the list opens");
    check(errors.length === 0, "no page errors", errors.join("\n"));
  } catch (e) {
    check(false, "the check runs to the end", e.stack ?? e);
  } finally {
    await browser.close();
    stop();
  }
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll library scale checks passed.");
  process.exit(failed ? 1 : 0);
})();
