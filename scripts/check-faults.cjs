// Production gap 4: a fault while drawing one part of the interface shows what failed, with
// Try again and Reload, and the 3D view and the rest of the app keep working.
//
// In ?test mode, window.__viewerFault = "<part>" makes that part throw while it renders. For
// English and Hebrew, the check breaks the toolbar and the library in turn and checks that:
//   - an alert names the part that failed, in the interface language;
//   - the 3D view still draws frames, and the other parts are still there;
//   - Try again, once the fault is gone, brings the part back.
//
// Usage: build apps/web, start `vite preview` on :4173, then node scripts/check-faults.cjs
const { chromium } = require("playwright");

const TEXT = {
  en: { dock: "The toolbar could not be shown", library: "The library could not be shown", retry: "Try again" },
  he: { dock: "לא ניתן להציג את סרגל הכלים", library: "לא ניתן להציג את הספרייה", retry: "נסו שוב" },
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) {
      failed++;
      if (detail !== undefined) console.log(`     ${detail}`);
    }
  };

  for (const lang of ["en", "he"])
    for (const part of ["dock", "library"]) {
      const T = TEXT[lang];
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(([l, p]) => {
        localStorage.setItem("viewer.lang", l);
        localStorage.setItem("viewer.fadeTools", "false");
        window.__viewerFault = p;
      }, [lang, part]);
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.goto("http://localhost:4173/?test", { waitUntil: "load" });
      await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
      await page.waitForTimeout(1000);
      const run = `${lang} ${part}`;

      const alerts = await page.locator("[data-testid=fault]").allInnerTexts();
      check(alerts.length === 1 && alerts[0].includes(T[part]), `${run}: one alert names the part that failed`, JSON.stringify(alerts));
      check(alerts.length === 1 && alerts[0].includes(T.retry), `${run}: the alert offers Try again`);
      // The 3D view still draws.
      const frames = await page.evaluate(async () => {
        const scene = window.viewerEngine.widget.scene;
        let n = 0;
        const off = scene.postRender.addEventListener(() => n++);
        // A frame of the whole globe can take most of a second in software rendering: wait up to 10 s for one.
        for (let i = 0; i < 100 && n < 2; i++) (scene.requestRender(), await new Promise((r) => setTimeout(r, 100)));
        off();
        return n;
      });
      check(frames > 0, `${run}: the 3D view keeps drawing (${frames} frames)`);
      // The other part is untouched.
      const other = part === "dock" ? "input[type=search], input[role=combobox], input" : "[data-testid=dock], nav, [role=toolbar]";
      check((await page.locator(other).count()) > 0, `${run}: the rest of the interface is still there`);
      check(pageErrors.length === 0, `${run}: no uncaught error reaches the page`, pageErrors.join(" | "));

      // Try again, with the fault gone, brings the part back.
      await page.evaluate(() => (window.__viewerFault = undefined));
      const box = await page.getByRole("button", { name: T.retry }).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(500);
      check((await page.locator("[data-testid=fault]").count()) === 0, `${run}: Try again brings the part back`);
      await ctx.close();
    }

  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
