// WP 1.8 acceptance: the shell renders in both languages and both themes, and contrast tests pass.
//
// In the real web app, for English and Hebrew, dark and light, it visits the library, a model
// open with its panels, the command palette, settings, the upload wizard and the help, and on
// each screen checks:
//   - axe-core 4.14 finds no serious or critical WCAG 2.1 A/AA problem, colour contrast included
//     (the 3D view itself is left out: it is a picture of the map, not text);
//   - the page runs the right way (dir="rtl" and lang="he" in Hebrew) and nothing spills past
//     the window;
//   - in Hebrew, no English words are left in the interface (visible text, labels and tooltips),
//     apart from names that stay in Latin letters (file formats, units, EPSG, key names) and
//     what people wrote (model names and metadata, classification names), marked data-content.
// Screenshots of every screen go to the out folder.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-shell.cjs [out folder]
// ONLY=en-dark,he-light limits the runs. SHELL_MODEL="Sci-Fi" opens that model instead of the
// first card. Set CHROMIUM to a Chromium binary if needed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

// Words that stay in Latin letters in the Hebrew interface: formats, standards, units, codes,
// product and data names.
const LATIN_OK = new Set(
  "VIEWER GLB glTF gltf FBX OBJ 3D Tiles tileset json zip KTX2 PNG JPG CSV GeoJSON GeoTIFF COG KML KMZ WMTS WMS XYZ TMS SHP shapefile EPSG WGS ITM UTM N S E W km m cm mm ft in MB GB KB TB fps Ctrl Shift Alt Esc Enter Tab Space PgUp PgDn Home End F Del Backspace Cesium CesiumJS OpenStreetMap OSM Esri AWS Terrarium Lyon Tarn Jerusalem Natural Earth ISO TOP API IP SIEM CEF HTTPS URL ID AA WCAG".split(" "),
);

const LABELS = {
  en: { settings: "Settings", upload: "Upload model", help: "Keyboard and mouse help" },
  he: { settings: "הגדרות", upload: "העלאת מודל", help: "עזרה למקלדת ועכבר" },
};

(async () => {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const only = process.env.ONLY?.split(",");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) {
      failed++;
      if (detail) console.log(`     ${String(detail).split("\n").join("\n     ")}`);
    }
  };

  for (const lang of ["en", "he"])
    for (const theme of ["dark", "light"]) {
      const run = `${lang}-${theme}`;
      if (only && !only.includes(run)) continue;
      console.log(`· ${run}`);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(([l, t]) => {
        localStorage.setItem("viewer.lang", l);
        localStorage.setItem("viewer.theme", t);
        // Tools stay shown: the check clicks them without waking them first.
        localStorage.setItem("viewer.fadeTools", "false");
      }, [lang, theme]);
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.goto("http://localhost:4173/", { waitUntil: "load" });
      await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const L = LABELS[lang];

      const screens = [
        { id: "library", go: async () => {} },
        {
          id: "model",
          go: async () => {
            // SHELL_MODEL picks the card by name (CI has only the light sample set).
            const cards = page.locator("button:has(img), button:has([role=img])");
            await (process.env.SHELL_MODEL ? cards.filter({ hasText: process.env.SHELL_MODEL }) : cards).first().click();
            await page.waitForFunction(() => window.viewerEngine.model?.ready || window.viewerEngine.tileset, null, { timeout: 120000 });
            await page.waitForTimeout(2500);
          },
          back: async () => {},
        },
        { id: "palette", go: async () => (await page.keyboard.press("Control+k"), await page.waitForTimeout(400)), back: () => page.keyboard.press("Escape") },
        {
          id: "settings",
          go: async () => {
            await page.getByRole("button", { name: L.settings, exact: true }).first().click();
            await page.waitForTimeout(400);
          },
          back: () => page.getByRole("button", { name: L.settings, exact: true }).first().click(),
        },
        {
          id: "upload",
          go: async () => {
            await page.keyboard.press("Control+k");
            await page.getByRole("option", { name: L.upload }).click();
            await page.waitForTimeout(400);
          },
          back: () => page.keyboard.press("Escape"),
        },
        { id: "help", go: async () => (await page.keyboard.press("?"), await page.waitForTimeout(400)), back: () => page.keyboard.press("?") },
      ];

      for (const s of screens) {
        try {
          await s.go();
        } catch (e) {
          check(false, `${run} ${s.id}: the screen opens`, e.message.split("\n").filter((l) => /intercepts|Timeout|not visible|waiting for/.test(l)).slice(-3).join("\n"));
          continue;
        }
        const r = await page.evaluate(
          async ({ axe, latinOk, lang }) => {
            if (!window.axe) new Function(axe)();
            const res = await window.axe.run(
              { exclude: [["canvas"], [".cesium-widget"]] },
              { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] },
            );
            const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
            const html = document.documentElement;
            const overflow = document.documentElement.scrollWidth - window.innerWidth;
            // English left in the Hebrew interface.
            const latin = new Map();
            if (lang === "he") {
              const ok = new Set(latinOk);
              const note = (text, where) => {
                for (const w of (text.match(/[A-Za-z][A-Za-z'’-]+/g) ?? []).map((x) => x.replace(/[-'’]+$/, ""))) {
                  if (ok.has(w) || /^[A-Z0-9]{2,}$/.test(w)) continue;
                  latin.set(`${text.trim().slice(0, 60)}`, where);
                }
              };
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const el = n.parentElement;
                if (!el || !n.textContent.trim() || el.closest("[dir=ltr], .num, code, pre, .cesium-widget, script, style, [data-content], [lang]:not(html)")) continue;
                if (!el.checkVisibility?.()) continue;
                note(n.textContent, el.tagName.toLowerCase());
              }
              for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], [data-tip]"))
                for (const a of ["aria-label", "title", "placeholder", "data-tip"]) if (el.getAttribute(a) && !el.closest(".cesium-widget, [data-content]")) note(el.getAttribute(a), `@${a}`);
            }
            return {
              violations: bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1, 2).join("") ?? ""}`).join("\n  ")}${v.nodes.length > 4 ? `\n  and ${v.nodes.length - 4} more` : ""}`),
              dir: html.dir,
              lang: html.lang,
              overflow,
              latin: [...latin].map(([t, w]) => `${w}: ${t}`),
            };
          },
          { axe: AXE, latinOk: [...LATIN_OK], lang },
        );
        if (out) await page.screenshot({ path: path.join(out, `${run}-${s.id}.png`) });
        check(r.violations.length === 0, `${run} ${s.id}: no serious accessibility problems`, r.violations.join("\n"));
        check(r.dir === (lang === "he" ? "rtl" : "ltr") && r.lang === lang, `${run} ${s.id}: runs ${lang === "he" ? "right to left" : "left to right"} (dir=${r.dir}, lang=${r.lang})`);
        check(r.overflow <= 0, `${run} ${s.id}: nothing spills past the window`, `${r.overflow}px`);
        if (lang === "he") check(r.latin.length === 0, `${run} ${s.id}: no English left in the interface`, (process.env.FULL ? r.latin : r.latin.slice(0, 25)).join("\n") + (!process.env.FULL && r.latin.length > 25 ? `\nand ${r.latin.length - 25} more` : ""));
        if (s.back) await s.back();
        await page.waitForTimeout(300);
      }
      check(pageErrors.length === 0, `${run}: no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
      await ctx.close();
    }
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();
