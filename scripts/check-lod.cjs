// WP 2.10 LOD inspector check (VWR-LOD-01), in the web app, on a 3D Tiles set with three levels
// (CesiumGS's TilesetWithDiscreteLOD: a dragon at low, medium and high detail).
//
//   - The panel's numbers are Cesium's own statistics for the same frame: tiles drawn (selected),
//     tiles loaded (content ready), triangles drawn and GPU memory (totalMemoryUsageInBytes),
//     and the tiles per depth add up to the tiles drawn.
//   - The detail slider changes refinement live: at low detail only the root is drawn, at full
//     detail the deepest level, without reopening anything.
//   - Colour by depth paints each drawn tile with its depth's colour, and off gives the colours back.
//   - Bounding volumes show and hide.
//   - Freeze keeps the selection while the detail changes, and unfreezing lets it change again.
//   - A frozen selection does not carry over to the next model opened.
//
// Usage: build apps/web, start `vite preview` on :4173, then node scripts/check-lod.cjs
// (CHROMIUM may point at a Chromium binary).
const { chromium } = require("playwright");

const URL_TILES = "samples/3dtiles/TilesetWithDiscreteLOD/tileset.json";
const RAMP = ["#FFE8A3", "#FFC66B", "#FF9F4A"];

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
  await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
  await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });

  const open = () =>
    page.evaluate(async (url) => {
      const e = window.viewerEngine;
      const s = e.current.get();
      await e.open({ ...s, id: "check-lod", name: "Dragon, three levels", placement: undefined, source: { kind: "3dtiles", url } });
    }, URL_TILES);
  /** Renders until the tiles for the current settings are in, then one more frame past the panel's throttle. */
  const settle = () =>
    page.evaluate(async () => {
      const e = window.viewerEngine;
      for (let i = 0, n = 0; i < 300 && n < 4; i++) {
        e.widget.scene.requestRender();
        e.widget.render();
        await new Promise((r) => setTimeout(r, 50));
        n = e.tileset?.tilesLoaded ? n + 1 : 0;
      }
      await new Promise((r) => setTimeout(r, 450));
      e.widget.render();
    });
  /** The inspector's numbers and Cesium's, read right after the same frame. */
  const read = () =>
    page.evaluate(() => {
      const e = window.viewerEngine;
      const t = e.tileset;
      const st = t.statistics;
      const s = e.lod.stats.get();
      return {
        ui: s,
        cesium: { selected: st.selected, loaded: st.numberOfTilesWithContentReady, triangles: st.numberOfTrianglesSelected, memory: t.totalMemoryUsageInBytes },
      };
    });

  await open();
  await page.waitForFunction(() => !!window.viewerEngine.tileset, null, { timeout: 60000 });
  await settle();
  // The side panel, as a user opens it (the "." key), on its Properties tab.
  if (!(await page.getByRole("tab", { name: "Properties" }).isVisible().catch(() => false))) await page.keyboard.press(".");
  await page.getByRole("tab", { name: "Properties" }).click();
  const panel = page.getByTestId("lod-inspector");
  await panel.waitFor({ timeout: 20000 });

  // ---- The numbers are Cesium's ----
  let r = await read();
  check(r.ui.drawn === r.cesium.selected && r.ui.drawn > 0, "tiles drawn are Cesium's selected tiles", `${r.ui.drawn} and ${r.cesium.selected}`);
  check(r.ui.loaded === r.cesium.loaded, "tiles loaded are Cesium's tiles with content ready", `${r.ui.loaded} and ${r.cesium.loaded}`);
  check(r.ui.triangles === r.cesium.triangles && r.ui.triangles > 0, "triangles are Cesium's triangles drawn", `${r.ui.triangles} and ${r.cesium.triangles}`);
  check(r.ui.memory === r.cesium.memory && r.ui.memory > 0, "memory is Cesium's total for the tileset", `${r.ui.memory} and ${r.cesium.memory} bytes`);
  check(r.ui.perDepth.reduce((a, b) => a + b, 0) === r.ui.drawn, "tiles per depth add up to tiles drawn", JSON.stringify(r.ui.perDepth));
  await page.waitForTimeout(300);
  const shown = await panel.locator("[data-stat=drawn]").innerText();
  const shownTri = Number(await panel.locator("[data-stat=triangles]").getAttribute("data-value"));
  const now = await page.evaluate(() => window.viewerEngine.lod.stats.get());
  check(Number(shown) === now.drawn && shownTri === now.triangles, "the panel shows them", `${shown} tiles, ${shownTri} triangles`);

  // ---- The detail slider, live ----
  const slider = panel.getByRole("slider", { name: "Detail" });
  // The panel's numbers refresh several times a second, and on a slow runner Playwright never
  // finds the row still enough to click: the checkbox is clicked in place instead.
  const toggle = (label) => panel.getByRole("checkbox", { name: label }).dispatchEvent("click");
  await slider.fill("1000"); // the coarse end: 64 px
  await settle();
  const coarse = await read();
  await toggle("Full detail: every triangle");
  await settle();
  const full = await read();
  check(coarse.ui.maxDepth === 0 && coarse.ui.drawn === 1, "at low detail only the root is drawn", `deepest ${coarse.ui.maxDepth}, ${coarse.ui.drawn} tile`);
  check(full.ui.maxDepth === 2, "at full detail the deepest level is drawn", `deepest ${full.ui.maxDepth}`);
  check(full.ui.triangles > 2 * coarse.ui.triangles, "full detail draws many more triangles", `${coarse.ui.triangles} to ${full.ui.triangles}`);
  check(full.ui.triangles === full.cesium.triangles && full.ui.drawn === full.cesium.selected, "and the numbers still are Cesium's");
  const sse = await page.evaluate(() => window.viewerEngine.tileset.maximumScreenSpaceError);
  check(sse === 0, "full detail sets the screen-space error to 0", `${sse}`);

  // ---- Colour by depth ----
  await toggle("Colour tiles by depth");
  await settle();
  const colours = await page.evaluate(() => {
    const t = window.viewerEngine.tileset;
    const out = [];
    for (const tile of t._selectedTiles) {
      let d = 0;
      for (let p = tile.parent; p; p = p.parent) d++;
      const c = tile.content;
      const col = c.featuresLength > 0 ? c.getFeature(0).color : c._model?.color;
      out.push({ d, css: col ? col.toCssHexString().toUpperCase() : null });
    }
    return out;
  });
  check(colours.length > 0 && colours.every((c) => c.css === RAMP[c.d]), "each drawn tile has its depth's colour", JSON.stringify(colours));
  await toggle("Colour tiles by depth");
  await settle();
  const back = await page.evaluate(() => {
    const c = window.viewerEngine.tileset._selectedTiles[0].content;
    const col = c.featuresLength > 0 ? c.getFeature(0).color : c._model?.color;
    return col ? col.toCssHexString().toUpperCase() : "none";
  });
  check(back === "#FFFFFF" || back === "none", "turning it off gives the tiles their own colours back", back);

  // ---- Bounding volumes ----
  await toggle("Show tile bounding boxes");
  const bounds = await page.evaluate(() => window.viewerEngine.tileset.debugShowBoundingVolume);
  await toggle("Show tile bounding boxes");
  const boundsOff = await page.evaluate(() => window.viewerEngine.tileset.debugShowBoundingVolume);
  check(bounds === true && boundsOff === false, "bounding volumes show and hide");

  // ---- Freeze ----
  await toggle("Freeze the selection (fly around it)");
  await toggle("Full detail: every triangle"); // back to the slider's 8 px
  await slider.fill("1000");
  await settle();
  const frozen = await read();
  check(frozen.ui.maxDepth === 2 && frozen.ui.drawn === full.ui.drawn, "frozen, the selection stays while the detail changes", `deepest ${frozen.ui.maxDepth}, ${frozen.ui.drawn} tiles`);
  await toggle("Freeze the selection (fly around it)");
  await settle();
  const thawed = await read();
  check(thawed.ui.maxDepth === 0, "unfrozen, it follows the detail again", `deepest ${thawed.ui.maxDepth}`);

  // ---- A frozen selection does not carry over ----
  await toggle("Freeze the selection (fly around it)");
  await open();
  await page.waitForFunction(() => !!window.viewerEngine.tileset, null, { timeout: 60000 });
  await settle();
  const next = await page.evaluate(() => ({ freeze: window.viewerEngine.tileset.debugFreezeFrame, setting: window.viewerEngine.lod.settings.get().freeze, drawn: window.viewerEngine.lod.stats.get()?.drawn ?? 0 }));
  check(!next.freeze && !next.setting && next.drawn > 0, "the next model opened is not frozen, and draws", JSON.stringify(next));

  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All LOD inspector checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
