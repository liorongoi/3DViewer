// WP 6.2 (NFR-17) and WP 6.1 (NFR-16): every screen, by keyboard and to a screen reader, in both
// languages and both themes, in the web app against the real server (library, versions, admin).
//
// On each screen (the library; a model with each side tab, the layers and map data panel, the
// view modes, each measuring and analysis tool; the versions; settings; the admin page with each
// of its sections; the upload wizard; the command palette; the help):
//   - axe-core finds no serious or critical WCAG 2.1 A/AA problem, colour contrast included
//     (the 3D view, a picture, is left out);
//   - it runs the right way (dir and lang), nothing spills past the window, and in Hebrew no
//     English is left in the interface (the same rules as check-shell.cjs).
// By keyboard alone:
//   - Tab reaches every control in order, each shows a focus ring (2.4.7) and has a name (4.1.2);
//   - a model opens from its card with Enter;
//   - each dialog takes the focus when it opens, keeps it while open (modal ones), closes with
//     Escape, and gives the focus back to the control that opened it (2.4.3);
//   - side tabs move with the arrow keys and Home/End (WAI-ARIA tabs), and each tab names the
//     panel it controls.
//
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
//   node scripts/check-a11y.cjs [out folder]
// ONLY=en-dark,he-light limits the runs. CHROMIUM may point at a Chromium binary.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");

const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const PASSWORD = "check-server-only-0123";
const LATIN_OK = new Set(
  "HOLO GLB glTF gltf FBX OBJ 3D Tiles tileset json zip KTX2 PNG JPG CSV GeoJSON GeoTIFF COG KML KMZ WMTS WMS XYZ TMS SHP shapefile EPSG WGS ITM UTM N S E W km m cm mm ft in MB GB KB TB fps Ctrl Shift Alt Esc Enter Tab Space PgUp PgDn Home End F Del Backspace Cesium CesiumJS OpenStreetMap OSM Esri AWS Terrarium Lyon Tarn Jerusalem Natural Earth ISO TOP API IP SIEM CEF HTTPS URL ID AA WCAG ADMIN_PASSWORD ADMIN_PASSWORD_RESET viewer env etc Sentinel cloudless Terrain quantized mesh terrarium xyz tms wmts hex".split(" "),
);

(async () => {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const only = process.env.ONLY?.split(",");
  const I18N = await import(path.join(__dirname, "../packages/shared/src/i18n.ts"));
  const { stop } = await startServer({ password: PASSWORD });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) {
      failed++;
      if (detail) console.log(`     ${String(detail).split("\n").join("\n     ")}`);
    }
  };

  try {
    for (const lang of ["en", "he"])
      for (const theme of ["dark", "light"]) {
        const run = `${lang}-${theme}`;
        if (only && !only.includes(run)) continue;
        console.log(`· ${run}`);
        const T = I18N[lang];
        // Reduced motion, as the app honours it: a check must not catch a colour half way through a
        // transition (software rendering can take seconds a frame).
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await ctx.addInitScript(([l, t]) => {
          localStorage.setItem("viewer.lang", l);
          localStorage.setItem("viewer.theme", t);
          localStorage.setItem("viewer.fadeTools", "false");
          localStorage.setItem("viewer.quality", "low");
        }, [lang, theme]);
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        await page.goto("http://localhost:4173/", { waitUntil: "load" });
        await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
        await page.waitForSelector("[data-model-card], button:has([role=img]), button:has(img)", { timeout: 60000 });
        await page.waitForTimeout(1500);

        const audit = async (id) => {
          const r = await page.evaluate(
            async ({ axe, latinOk, lang }) => {
              if (!window.axe) new Function(axe)();
              const res = await window.axe.run({ exclude: [["canvas"], [".cesium-widget"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
              const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
              const latin = new Map();
              if (lang === "he") {
                const ok = new Set(latinOk);
                const note = (text, where) => {
                  // Addresses (host:port, a.b/c) and file extensions (.shp) are not words.
                  text = text.replace(/\S*[A-Za-z0-9][.:/][A-Za-z0-9]\S*/g, " ").replace(/\.[a-z0-9]{2,5}\b/g, " ");
                  for (const w of (text.match(/[A-Za-z][A-Za-z'’-]+/g) ?? []).map((x) => x.replace(/[-'’]+$/, ""))) {
                    if (ok.has(w) || /^[A-Z0-9_]{2,}$/.test(w)) continue;
                    latin.set(text.trim().slice(0, 60), where);
                  }
                };
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                  const el = n.parentElement;
                  if (!el || !n.textContent.trim() || el.closest("[dir=ltr], [dir=auto], .num, code, pre, .cesium-widget, script, style, [data-content], [lang]:not(html)")) continue;
                  if (!el.checkVisibility?.()) continue;
                  note(n.textContent, el.tagName.toLowerCase());
                }
                for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], [data-tip]"))
                  for (const a of ["aria-label", "title", "placeholder", "data-tip"]) if (el.getAttribute(a) && !el.closest(".cesium-widget, [data-content]")) note(el.getAttribute(a), `@${a}`);
              }
              return {
                violations: bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1, 2).join("") ?? ""}`).join("\n  ")}${v.nodes.length > 4 ? `\n  and ${v.nodes.length - 4} more` : ""}`),
                dir: document.documentElement.dir,
                lang: document.documentElement.lang,
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                latin: [...latin].map(([t, w]) => `${w}: ${t}`),
              };
            },
            { axe: AXE, latinOk: [...LATIN_OK], lang },
          );
          if (out) await page.screenshot({ path: path.join(out, `${run}-${id}.png`), timeout: 60000, animations: "disabled" }).catch(() => {});
          check(r.violations.length === 0, `${run} ${id}: no serious accessibility problems`, r.violations.join("\n"));
          check(r.dir === (lang === "he" ? "rtl" : "ltr") && r.lang === lang && r.overflow <= 0, `${run} ${id}: runs ${lang === "he" ? "right to left" : "left to right"}, nothing spills past the window`, `dir=${r.dir} lang=${r.lang} overflow=${r.overflow}px`);
          if (lang === "he") check(r.latin.length === 0, `${run} ${id}: no English left in the interface`, r.latin.slice(0, 20).join("\n"));
        };
        const step = async (id, go) => {
          try {
            await go();
          } catch (e) {
            check(false, `${run} ${id}: the screen opens`, e.message.split("\n").slice(0, 3).join("\n"));
            return false;
          }
          await page.waitForTimeout(350);
          await audit(id);
          return true;
        };
        const btn = (name) => page.getByRole("button", { name, exact: true }).first();
        // Where the focus is: inside which dialog, its name, and whether it shows a ring.
        const focusInfo = () =>
          page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const dialog = el.closest("[role=dialog]");
            const ring = (e) => {
              const s = getComputedStyle(e);
              return [s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "", s.boxShadow !== "none" ? s.boxShadow : "", s.borderColor, s.textDecorationLine].join("|");
            };
            const chain = [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean);
            const focused = chain.map(ring);
            el.blur();
            const blurred = chain.map(ring);
            el.focus({ focusVisible: true });
            const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.textContent || el.labels?.[0]?.textContent || el.getAttribute("title") || (el.matches("input,textarea,select") ? el.getAttribute("placeholder") : el.textContent) || "";
            return {
              tag: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${name.trim().slice(0, 40)}"`,
              name: name.trim(),
              ring: focused.some((f, i) => f !== blurred[i]),
              dialog: dialog ? dialog.getAttribute("aria-label") : null,
              key: el.dataset.a11yKey ?? (el.dataset.a11yKey = String(Math.random())),
            };
          });
        const tabWalk = async (what, max, inside) => {
          const seen = [];
          const noRing = [];
          const noName = [];
          const left = [];
          for (let i = 0; i < max; i++) {
            await page.keyboard.press("Tab");
            const f = await focusInfo();
            if (!f) continue;
            if (seen.includes(f.key)) break;
            seen.push(f.key);
            if (!f.ring) noRing.push(f.tag);
            if (!f.name) noName.push(f.tag);
            if (inside !== undefined && f.dialog !== inside) left.push(f.tag);
          }
          check(seen.length > 0, `${run} ${what}: Tab moves through the controls (${seen.length})`);
          check(noRing.length === 0, `${run} ${what}: every control shows a focus ring`, noRing.slice(0, 10).join("\n"));
          check(noName.length === 0, `${run} ${what}: every control has a name`, noName.slice(0, 10).join("\n"));
          if (inside !== undefined) check(left.length === 0, `${run} ${what}: the focus stays in the dialog`, left.slice(0, 5).join("\n"));
        };
        // Opens a dialog from a control by keyboard, checks the focus goes in, stays in, and comes
        // back to that control on Escape.
        const dialogByKeyboard = async (what, opener, dialogName, modal) => {
          await opener.focus();
          await page.keyboard.press("Enter");
          await page.waitForTimeout(500);
          const f = await focusInfo();
          check(f?.dialog === dialogName, `${run} ${what}: the focus moves into the dialog when it opens`, f ? `${f.tag} in ${f.dialog}` : "nothing focused");
          if (modal) await tabWalk(what, 60, dialogName);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          const open = await page.locator(`[role=dialog][aria-label="${dialogName}"]`).count();
          const back = await opener.evaluate((el) => el === document.activeElement);
          check(open === 0 && back, `${run} ${what}: Escape closes it and the focus goes back to the button`, `open=${open} focus back=${back}`);
        };

        // --- The library ---------------------------------------------------------------------
        await audit("library");
        await page.locator("body").focus();
        await tabWalk("library", 80);
        await dialogByKeyboard("settings", btn(T.viewer.settings), T.viewer.settings, false);
        await dialogByKeyboard("help", btn(T.viewer.help), T.help.title, true);

        // --- A model, opened from its card by keyboard ----------------------------------------
        const card = page.locator("[data-model-card]").first();
        const cardOk = (await card.count()) > 0;
        check(cardOk, `${run}: model cards are marked (data-model-card)`);
        if (cardOk) {
          await card.focus();
          await page.keyboard.press("Enter");
          const opened = await page.waitForFunction(() => window.viewerEngine.model?.ready || window.viewerEngine.tileset, null, { timeout: 120000 }).then(() => true, () => false);
          check(opened, `${run}: a model opens from its card with Enter`);
          await page.waitForTimeout(2000);
        }
        await audit("model");
        await page.locator("body").focus();
        await tabWalk("model", 120);

        // Side tabs, by arrow keys.
        if ((await page.getByRole("tab", { name: T.viewer.measurements, exact: true }).count()) === 0) {
          await page.locator("body").focus();
          await page.keyboard.press(".");
        }
        for (const [panel, tabs] of [
          ["side", [T.viewer.measurements, T.side.analysis, T.viewer.properties, T.side.flyBy]],
        ]) {
          const first = page.getByRole("tab", { name: tabs[0], exact: true });
          await first.click();
          await first.focus();
          const next = lang === "he" ? "ArrowLeft" : "ArrowRight";
          await page.keyboard.press(next);
          const second = await page.getByRole("tab", { name: tabs[1], exact: true }).evaluate((el) => el === document.activeElement && el.getAttribute("aria-selected") === "true");
          await page.keyboard.press("End");
          const last = await page.getByRole("tab", { name: tabs[3], exact: true }).evaluate((el) => el === document.activeElement && el.getAttribute("aria-selected") === "true");
          await page.keyboard.press("Home");
          const home = await first.evaluate((el) => el === document.activeElement && el.getAttribute("aria-selected") === "true");
          check(second && last && home, `${run} ${panel} tabs: ${next}, End and Home move between tabs`, `next=${second} end=${last} home=${home}`);
          const controls = await page.getByRole("tab", { name: tabs[0], exact: true }).evaluate((el) => {
            const p = document.getElementById(el.getAttribute("aria-controls") ?? "");
            return !!p && p.getAttribute("role") === "tabpanel" && p.getAttribute("aria-labelledby") === el.id;
          });
          check(controls, `${run} ${panel} tabs: each tab names the panel it controls`);
        }
        for (const [id, name] of [
          ["measurements", T.viewer.measurements],
          ["analysis", T.side.analysis],
          ["properties", T.viewer.properties],
          ["fly-by", T.side.flyBy],
        ])
          await step(`model-${id}`, () => page.getByRole("tab", { name, exact: true }).click());

        if ((await page.getByRole("tab", { name: T.viewer.layers, exact: true }).count()) === 0) {
          await page.locator("body").focus();
          await page.keyboard.press("l");
        }
        await step("layers", () => page.getByRole("tab", { name: T.viewer.layers, exact: true }).click());
        await step("map-data", () => page.getByRole("tab", { name: T.shell.mapData, exact: true }).click());
        await step("view-modes", () => btn(T.viewer.viewMode).click());
        await page.keyboard.press("Escape");
        for (const [id, key] of [
          ["tool-distance", "m"],
          ["tool-path", "Shift+M"],
          ["tool-sight", "i"],
          ["tool-viewshed", "v"],
        ]) {
          await page.locator("body").focus();
          await step(id, () => page.keyboard.press(key));
          await page.keyboard.press("Escape");
        }
        const versions = page.getByTestId("version-picker");
        if (await versions.count()) {
          await step("versions", () => versions.click());
          await page.keyboard.press("Escape");
        }

        // --- Settings and the admin page --------------------------------------------------------
        await step("settings", () => btn(T.viewer.settings).click());
        await step("admin-sign-in", async () => {
          await page.getByRole("button", { name: T.settings.admin, exact: true }).click();
          await page.getByRole("dialog", { name: T.admin.title }).waitFor();
        });
        const pw = page.getByRole("dialog", { name: T.admin.title }).locator("input[type=password]");
        const focusedPw = await pw.evaluate((el) => el === document.activeElement).catch(() => false);
        check(focusedPw, `${run} admin: the password field has the focus`);
        await pw.fill(PASSWORD);
        await page.keyboard.press("Enter");
        await page.getByRole("navigation", { name: T.admin.sections }).waitFor({ timeout: 15000 }).catch(() => {});
        for (const id of ["levels", "basemaps", "storage", "delete", "audit", "password"]) await step(`admin-${id}`, () => page.getByRole("navigation", { name: T.admin.sections }).getByRole("button", { name: T.admin.tabs[id], exact: true }).click());
        await page.locator("body").focus();
        await page.getByRole("dialog", { name: T.admin.title }).getByRole("button").first().focus();
        await tabWalk("admin", 80, T.admin.title);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        check((await page.getByRole("dialog", { name: T.admin.title }).count()) === 0, `${run} admin: Escape closes it`);

        // --- Upload, palette, help ------------------------------------------------------------
        await step("palette", async () => {
          await page.locator("body").focus();
          await page.keyboard.press("Control+k");
        });
        await step("upload", () => page.getByRole("option", { name: T.library.upload }).first().click());
        const upFocus = await focusInfo();
        check(upFocus?.dialog === T.upload.title, `${run} upload: the focus moves into the wizard`, upFocus ? `${upFocus.tag} in ${upFocus.dialog}` : "nothing focused");
        await tabWalk("upload", 60, T.upload.title);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await step("help", () => btn(T.viewer.help).click());
        await page.keyboard.press("Escape");

        check(pageErrors.length === 0, `${run}: no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
        await ctx.close();
      }
  } finally {
    await browser.close();
    stop();
  }
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();
