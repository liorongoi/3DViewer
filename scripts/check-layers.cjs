// WP 2.1 / 2.2 acceptance, AC-05: the Layers panel mirrors the model's parts, and what it shows
// is what the 3D view draws, in every case.
//
// Opens the chess set (49 named parts) twice in the real web app: as a single GLB, and tiled
// into 3D Tiles by the server's own tiler (as a model over 1.5 M triangles would be). Each is
// driven only through the panel, with real clicks, keys and drags (SRS LYR-01 to LYR-05):
//   - The tree mirrors the glTF node hierarchy; the tiled copy has the same tree.
//   - A part's eye hides and shows it; a parent's eye hides and shows all its parts, and they
//     keep their own toggles.
//   - Show all and Hide all; search keeps matching parts and their parents, with the match
//     marked; Isolate and Undo isolate (back to how it was, not to all shown); Alt+click on an
//     eye isolates too; dragging down the eyes turns each part the drag passes over.
//   - Pointing at a row outlines that part in 3D; clicking a part in 3D selects its row.
// After each step every part's state in the renderer is compared with the panel: its row is
// shown (eye on, every parent's eye on) exactly when the renderer draws the part. Hide all is
// also checked by picking: the model can no longer be hit. Last, a saved layer manifest (WP 2.1)
// is applied: renamed, merged, nested and ordered layers, with the same check.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-layers.cjs
// Set CHROMIUM to a Chromium binary if needed.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { describeFailure, watchConsole } = require("./lib/page-diagnostics.cjs");

const ROOT = path.join(__dirname, "..");
const TILED = path.join(ROOT, "apps/web/dist/samples/_check-layers-tiled");

// The tiled copy, made by the server's tiler with small tiles so it has several levels.
if (!fs.existsSync(path.join(TILED, "tileset.json"))) {
  const tiler = path.join(ROOT, "apps/server/src/tiler.ts");
  const src = path.join(ROOT, "apps/web/public/samples/khronos/ABeautifulGame.glb");
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { tileModel } from ${JSON.stringify(tiler)}; await tileModel(${JSON.stringify(src)}, ${JSON.stringify(TILED)}, { leafTriangles: 50000 });`], { stdio: "inherit", cwd: path.join(ROOT, "apps/server") });
}

let current = null;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  let glbTree = null;

  for (const kind of ["GLB", "3D Tiles"]) {
    const T = (what) => `${kind}: ${what}`;
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The page's console errors (the viewer logs why it closed a model) and, if a step throws,
    // the viewer's state and a screenshot: a failure on CI then names its cause.
    watchConsole(page, kind);
    current = { page, kind };
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    // A render error stops Cesium drawing without a page error: keep it for the report.
    await page.evaluate(() => window.viewerEngine.widget.scene.renderError.addEventListener((_, err) => (window.__renderError = String(err?.stack ?? err).slice(0, 400))));
    // Open it as a user would: the chess set's card. The tiled copy is then opened in its place,
    // as the app opens a model the server tiled.
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
    await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    if (kind === "3D Tiles") {
      // The first tiles arrive slowly, after the viewer has stopped waiting for them to draw
      // the ground cut: its captures once cancelled every tile download, so the model never
      // loaded (seen in CI, where the tiles were slow).
      const slow = /_check-layers-tiled\/tiles\/.*\.glb$/;
      const delay = async (route) => {
        await new Promise((r) => setTimeout(r, 9000));
        await route.continue().catch(() => undefined);
      };
      await page.route(slow, delay);
      await page.evaluate(async () => {
        const e = window.viewerEngine;
        const s = e.current.get();
        await e.open({ ...s, id: "check-layers-tiled", source: { kind: "3dtiles", url: "samples/_check-layers-tiled/tileset.json", localFrame: true } });
      });
      const arrived = await page
        .waitForFunction(() => { const t = window.viewerEngine.tileset; return t?.tilesLoaded && t._selectedTiles.length > 0; }, null, { timeout: 120000, polling: 500 })
        .then(() => true, () => false);
      await page.unroute(slow, delay);
      check(arrived, T("tiles that arrive slowly still load and are drawn"));
      await page.waitForFunction(() => window.viewerEngine.tileset?.tilesLoaded, null, { timeout: 180000 });
    }
    await page.evaluate(() => {
      const e = window.viewerEngine;
      e.widget.scene.shadowMap.enabled = false;
      e.shadowsWanted = false;
      // Drawn on a timer: software rendering flat out starves the input events.
      e.widget.useDefaultRenderLoop = false;
      window.__renderTimer = setInterval(() => e.widget.render(), 100);
    });
    if (!(await page.getByRole("tree", { name: "Layers" }).isVisible())) await page.keyboard.press("l");
    const tree = page.getByRole("tree", { name: "Layers" });
    await tree.waitFor();

    // Every layer: id, name, depth, own toggle and parent, from the engine.
    const engineLayers = () =>
      page.evaluate(() => {
        const out = [];
        const rec = (ls, depth, parent) => ls.forEach((l) => (out.push({ id: l.id, name: l.name, depth, visible: l.visible, parent, node: l.node }), rec(l.children, depth + 1, l.id)));
        rec(window.viewerEngine.layers.get(), 0, null);
        return out;
      });
    // What the renderer draws, per layer.
    const drawn = () =>
      page.evaluate(() => {
        const e = window.viewerEngine;
        const out = {};
        const rec = (ls) =>
          ls.forEach((l) => {
            // A layer merged from several parts is drawn when all of them are.
            const nodes = l.nodes ?? (l.node !== undefined ? [l.node] : []);
            if (e.model) out[l.id] = nodes.every((n) => e.model.sceneGraph._runtimeNodes[n]?.show !== false);
            else {
              const show = e.tileset.style?.show;
              out[l.id] = nodes.every((n) => !show || !!show.evaluate({ getProperty: (p) => (p === "node" ? n : undefined) }));
            }
            rec(l.children);
          });
        rec(e.layers.get());
        return out;
      });
    // What the panel shows: the rows in order, each with its depth, eye and dimmed name.
    const panel = () =>
      tree.evaluate((ul) => {
        const rows = [];
        const rec = (list, depth, parentOn) => {
          for (const li of list.querySelectorAll(":scope > li")) {
            const eye = li.querySelector(":scope > div > button:nth-of-type(2)");
            const own = eye.getAttribute("aria-label") === "Hide";
            const name = li.querySelector(":scope > div > span[data-content]");
            rows.push({ id: li.dataset.layer, name: name.textContent, depth, own, shown: parentOn && own, marked: name.querySelector("mark")?.textContent ?? null });
            const kids = li.querySelector(":scope > ul");
            if (kids) rec(kids, depth + 1, parentOn && own);
          }
        };
        rec(ul, 0, true);
        return rows;
      });
    const matches = async (what) => {
      const [rows, d] = await Promise.all([panel(), drawn()]);
      const wrong = rows.filter((r) => r.shown !== d[r.id]);
      check(wrong.length === 0 && rows.length > 0, T(`${what}: the 3D view draws exactly the parts the panel shows`), wrong.length ? `${wrong.length} differ, e.g. ${wrong[0].name}: panel ${wrong[0].shown ? "shown" : "hidden"}` : `${rows.length} parts`);
      return rows;
    };
    const row = (id) => tree.locator(`li[data-layer="${id}"]`).first();
    const eye = (id) => row(id).locator(":scope > div > button").nth(1);
    const clickEye = async (id, modifiers) => {
      await eye(id).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      const b = await eye(id).boundingBox();
      for (const m of modifiers ?? []) await page.keyboard.down(m);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      for (const m of modifiers ?? []) await page.keyboard.up(m);
      await page.waitForTimeout(150);
    };
    // Clicks at the element's centre. Playwright's own click waits for the page to be "stable",
    // which software rendering can hold off for longer than its timeout.
    const clickCentre = async (loc) => {
      await loc.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      const b = await loc.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const button = (name) => ({ click: () => clickCentre(page.getByRole("button", { name, exact: true })) });
    // A tileset's tiles loaded for a second of frames in a row: a tile unloaded while out of view
    // is asked for again only by the next frame, so a single check can pass before it is back.
    const settled = () =>
      page.evaluate(async () => {
        const e = window.viewerEngine;
        for (let i = 0, n = 0; i < 600 && e.tileset && n < 5; i++) {
          e.widget.render();
          await new Promise((r) => setTimeout(r, 200));
          n = e.tileset.tilesLoaded ? n + 1 : 0;
        }
      });
    const modelHit = () =>
      settled().then(() => page.evaluate(() => {
        const e = window.viewerEngine;
        // What the last drawn frame chose, before the picks below run their own passes.
        const t = e.tileset;
        window.__drawn = t
          ? { selected: t._selectedTiles.length, memSse: Math.round(t.memoryAdjustedScreenSpaceError * 100) / 100, maxSse: t.maximumScreenSpaceError, rootSseTileset: Math.round(t.root.getScreenSpaceError(e.widget.scene.frameState, true) * 100) / 100, rootVisible: t.root._visible, memory: t.totalMemoryUsageInBytes, cache: t.cacheBytes, overflow: t.maximumCacheOverflowBytes, gError: t._geometricError }
          : null;
        const c = e.widget.scene.canvas;
        // A grid of points over the view: does any of them hit the model?
        for (let y = 0.2; y <= 0.8; y += 0.05)
          for (let x = 0.2; x <= 0.8; x += 0.05) {
            const p = e.widget.scene.pick({ x: c.clientWidth * x, y: c.clientHeight * y });
            if (p && (p.primitive === e.model || p.primitive === e.tileset)) return true;
          }
        return false;
      }));

    // When a click misses: what the view holds, for the check's detail.
    const viewState = () =>
      page.evaluate(() => {
        const e = window.viewerEngine;
        const scene = e.widget.scene;
        const target = e.tileset ?? e.model;
        const bs = target?.boundingSphere;
        const at = bs && scene.cartesianToCanvasCoordinates(bs.center);
        const kinds = {};
        const c = scene.canvas;
        for (let y = 0.2; y <= 0.8; y += 0.15)
          for (let x = 0.2; x <= 0.8; x += 0.15) {
            const p = scene.pick({ x: c.clientWidth * x, y: c.clientHeight * y });
            const k = !p ? "nothing" : p.primitive === e.tileset ? "tileset" : p.primitive === e.model ? "model" : p.primitive?.constructor?.name ?? p.constructor?.name ?? "other";
            kinds[k] = (kinds[k] ?? 0) + 1;
          }
        const t = e.tileset;
        return JSON.stringify({
          picks: kinds,
          centreOnScreen: at ? [Math.round(at.x), Math.round(at.y)] : null,
          radius: bs ? Math.round(bs.radius * 100) / 100 : null,
          camHeight: Math.round(scene.camera.positionCartographic.height),
          tiles: t ? { loaded: t.tilesLoaded, selected: t._selectedTiles.length, commands: t.statistics.numberOfCommands, visited: t.statistics.visited, show: t.show, freeze: t.debugFreezeFrame, style: !!t.style } : null,
          root: t
            ? {
                contentReady: t.root.contentReady,
                state: t.root._contentState,
                planeMask: t.root._visibilityPlaneMask,
                visited: t.root._visitedFrame,
                selected: t.root._selectedFrame,
                frame: scene.frameState.frameNumber,
                sse: Math.round(t.root._screenSpaceError * 100) / 100,
                children: t.root.children.map((c) => [c.contentReady, c._visibilityPlaneMask, c._visitedFrame]),
                distance: bs ? Math.round(Math.hypot(bs.center.x - scene.camera.positionWC.x, bs.center.y - scene.camera.positionWC.y, bs.center.z - scene.camera.positionWC.z) * 100) / 100 : null,
              }
            : null,
          near: scene.camera.frustum.near,
          drawn: window.__drawn ?? null,
          renderError: window.__renderError ?? null,
        });
      });

    // ---- LYR-01: the tree mirrors the hierarchy ----
    const layers = await engineLayers();
    let rows = await matches("as opened");
    check(JSON.stringify(rows.map((r) => [r.id, r.name, r.depth])) === JSON.stringify(layers.map((l) => [l.id, l.name, l.depth])), T("the panel lists every part in the model's own order and nesting"), `${rows.length} rows, ${layers.filter((l) => l.depth > 0).length} nested`);
    if (kind === "GLB") {
      const names = await page.evaluate(() => window.viewerEngine.gltfNodes.map((n) => n.name));
      check(layers.every((l) => names[l.node] === l.name), T("each row is named after its glTF node"));
      glbTree = layers.map((l) => [l.id, l.name, l.depth]);
    } else check(JSON.stringify(layers.map((l) => [l.id, l.name, l.depth])) === JSON.stringify(glbTree), T("the tiled copy has the same tree as the GLB"));

    const leaf = layers.find((l) => l.depth > 0 && !layers.some((c) => c.parent === l.id)) ?? layers.find((l) => !layers.some((c) => c.parent === l.id));
    const parent = layers.find((l) => layers.some((c) => c.parent === l.id));

    // ---- LYR-02: one part, and a parent with its children ----
    await clickEye(leaf.id);
    rows = await matches(`${leaf.name} hidden`);
    check(rows.filter((r) => !r.shown).map((r) => r.id).join() === leaf.id, T("hiding one part hides only that part"));
    await clickEye(leaf.id);
    rows = await matches(`${leaf.name} shown again`);
    check(rows.every((r) => r.shown), T("showing it again brings it back"));
    if (parent) {
      const kids = layers.filter((l) => l.parent === parent.id).map((l) => l.id);
      await clickEye(parent.id);
      rows = await matches(`${parent.name} (a parent) hidden`);
      check(kids.every((k) => !rows.find((r) => r.id === k).shown && rows.find((r) => r.id === k).own), T("hiding a parent hides its parts, which keep their own toggles"), `${kids.length} parts`);
      await clickEye(parent.id);
      rows = await matches(`${parent.name} shown again`);
      check(rows.every((r) => r.shown), T("showing the parent brings its parts back"));
    } else console.log(`INFO ${kind}: no part has children`);

    // ---- LYR-03: show all / hide all ----
    {
      const hit = await modelHit();
      check(hit, T("the model can be clicked before Hide all"), hit ? undefined : await viewState());
    }
    await button("Hide all").click();
    await page.waitForTimeout(400);
    rows = await matches("Hide all");
    check(rows.every((r) => !r.shown), T("Hide all hides every part"));
    check(!(await modelHit()), T("after Hide all nothing of the model can be clicked in 3D"));
    await button("Show all").click();
    await page.waitForTimeout(400);
    rows = await matches("Show all");
    {
      const hit = await modelHit();
      check(rows.every((r) => r.shown) && hit, T("Show all shows every part again"), hit ? undefined : await viewState());
    }

    // ---- LYR-04: search ----
    const search = page.getByRole("textbox", { name: "Search layers" });
    await search.fill("pawn");
    await page.waitForTimeout(200);
    rows = await panel();
    const want = new Set();
    for (const l of layers) if (l.name.toLowerCase().includes("pawn")) for (let p = l; p; p = layers.find((x) => x.id === p.parent)) want.add(p.id);
    check(rows.length === want.size && rows.every((r) => want.has(r.id)), T("search keeps the matching parts and their parents"), `${rows.length} rows for "pawn"`);
    const hits = rows.filter((r) => r.name.toLowerCase().includes("pawn"));
    check(hits.length > 0 && hits.every((r) => r.marked?.toLowerCase() === "pawn"), T("the matching text is marked in each name"), `${hits.length} marked`);
    await search.fill("");
    await page.waitForTimeout(200);
    check((await panel()).length === layers.length, T("clearing the search lists every part again"));

    // ---- LYR-05: isolate and undo, Alt+click ----
    const other = layers.find((l) => l.id !== leaf.id && !layers.some((c) => c.parent === l.id) && l.parent !== leaf.parent) ?? layers.find((l) => l.id !== leaf.id && l.depth === leaf.depth);
    await clickEye(other.id); // a part hidden before isolating: undo must bring back exactly this
    const target = parent ?? leaf;
    const tb = await row(target.id).locator(":scope > div").boundingBox();
    await page.mouse.move(tb.x + tb.width * 0.5, tb.y + tb.height / 2);
    await clickCentre(row(target.id).locator(":scope > div").getByRole("button", { name: "Isolate" }));
    await page.waitForTimeout(300);
    rows = await matches(`isolate ${target.name}`);
    const keep = new Set([target.id]);
    for (const l of layers) for (let p = l; p; p = layers.find((x) => x.id === p.parent)) if (p.id === target.id) keep.add(l.id);
    for (let p = target; p; p = layers.find((x) => x.id === p.parent)) keep.add(p.id);
    check(rows.every((r) => r.shown === keep.has(r.id)), T("Isolate shows only that part, its parents and its own parts"), `${rows.filter((r) => r.shown).length} shown`);
    await button("Undo isolate").click();
    await page.waitForTimeout(300);
    rows = await matches("undo isolate");
    check(rows.every((r) => r.shown === (r.id !== other.id)), T("Undo isolate goes back to how it was, the hidden part still hidden"));
    await clickEye(other.id);
    await clickEye(leaf.id, ["Alt"]);
    rows = await matches(`Alt+click on ${leaf.name}`);
    const leafKeep = new Set([leaf.id]);
    for (let p = leaf; p; p = layers.find((x) => x.id === p.parent)) leafKeep.add(p.id);
    check(rows.every((r) => r.shown === leafKeep.has(r.id)), T("Alt+click on an eye isolates that part"));
    await button("Undo isolate").click();
    await page.waitForTimeout(300);
    check((await matches("undo")).every((r) => r.shown), T("and Undo isolate shows everything again"));

    // ---- drag-paint: press on one eye and drag down over the next ----
    rows = await panel();
    const run = rows.slice(1, 6);
    await eye(run[0].id).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const boxes = [];
    for (const r of run) boxes.push(await eye(r.id).boundingBox());
    await page.mouse.move(boxes[0].x + boxes[0].width / 2, boxes[0].y + boxes[0].height / 2);
    await page.mouse.down();
    for (const b of boxes.slice(1)) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    rows = await matches("drag over five eyes");
    const painted = new Set(run.map((r) => r.id));
    check(rows.filter((r) => !r.own).every((r) => painted.has(r.id)) && run.every((r) => !rows.find((x) => x.id === r.id).own), T("dragging down the eyes hides each part the drag passes over, and only those"), `${rows.filter((r) => !r.own).length} hidden`);
    await button("Show all").click();
    await page.waitForTimeout(300);

    // ---- pointing at a row outlines the part; clicking the part selects the row ----
    const listed = await panel();
    if (!listed.some((r) => r.id === leaf.id)) console.log(`INFO ${kind}: ${leaf.name} is not listed now (rows: ${listed.length}); pointing at ${listed[1].name}`);
    const pointAt = listed.some((r) => r.id === leaf.id) ? leaf.id : listed[1].id;
    await row(pointAt).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const rb = await row(pointAt).locator(":scope > div").boundingBox();
    await page.mouse.move(rb.x + rb.width * 0.6, rb.y + rb.height / 2, { steps: 3 });
    await page.waitForTimeout(300);
    const outline = await page.evaluate(() => {
      const e = window.viewerEngine;
      return { id: e.hoveredLayer.get(), shown: !!e.hoverBox && e.widget.entities.contains(e.hoverBox) };
    });
    check(outline.id === pointAt && outline.shown, T("pointing at a row outlines that part in 3D"), outline.id);
    await page.mouse.move(5, 400);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.viewerEngine.hoveredLayer.get())) === null, T("the outline goes when the pointer leaves the list"));
    // Click the part in 3D: the centre of its box on screen.
    await settled();
    const spot = await page.evaluate((id) => {
      const e = window.viewerEngine;
      const s = e.layerSphere(id);
      const p = s && e.widget.scene.cartesianToCanvasCoordinates(s.center);
      return p && { x: p.x, y: p.y };
    }, (layers.find((l) => l.name === "Chessboard") ?? leaf).id);
    if (spot) {
      const cb = await page.locator(".cesium-widget canvas").boundingBox();
      await page.mouse.click(cb.x + spot.x, cb.y + spot.y);
      await page.waitForTimeout(400);
      const sel = await page.evaluate(() => window.viewerEngine.selectedLayer.get());
      const selRow = sel ? await row(sel).getAttribute("aria-selected") : null;
      check(!!sel && selRow === "true", T("clicking a part in 3D selects its row"), sel ? layers.find((l) => l.id === sel)?.name : `nothing picked at ${Math.round(spot.x)},${Math.round(spot.y)}: ${await viewState()}`);
    }

    // ---- WP 2.1: a saved manifest renames, merges, nests and orders the layers ----
    const nodeOf = (name) => layers.find((l) => l.name === name).node;
    const manifest = {
      layers: [
        { name: "Board", nodes: [nodeOf("Chessboard")] },
        { name: "Pieces", children: [{ name: "Kings", nodes: [nodeOf("King_W"), nodeOf("King_B")] }, { name: "Queens", nodes: [nodeOf("Queen_W"), nodeOf("Queen_B")] }] },
      ],
    };
    await page.evaluate((m) => window.viewerEngine.setLayerManifest(m), manifest);
    await page.waitForTimeout(400);
    rows = await matches("with the saved manifest");
    check(JSON.stringify(rows.slice(0, 4).map((r) => [r.name, r.depth])) === JSON.stringify([["Board", 0], ["Pieces", 0], ["Kings", 1], ["Queens", 1]]), T("the manifest's names, nesting and order come first"), rows.slice(0, 4).map((r) => r.name).join(", "));
    check(rows.length === layers.length - 5 + 4 && !rows.some((r) => ["Chessboard", "King_W", "King_B", "Queen_W", "Queen_B"].includes(r.name)), T("the other parts follow in the file's own order, the arranged ones not repeated"), `${rows.length} rows`);
    const kings = rows.find((r) => r.name === "Kings").id;
    await clickEye(kings);
    rows = await matches("Kings (two merged parts) hidden");
    const kd = await page.evaluate((ns) => ns.map((n) => {
      const e = window.viewerEngine;
      if (e.model) return e.model.sceneGraph._runtimeNodes[n].show;
      return !!e.tileset.style?.show.evaluate({ getProperty: () => n }) ;
    }), [nodeOf("King_W"), nodeOf("King_B")]);
    check(kd.every((x) => x === false) && rows.filter((r) => !r.shown).length === 1, T("hiding a merged layer hides each of its parts in 3D, and nothing else"));
    await page.evaluate(() => window.viewerEngine.setLayerManifest(null));
    await page.waitForTimeout(300);
    rows = await matches("manifest cleared");
    check(JSON.stringify(rows.map((r) => [r.id, r.name, r.depth])) === JSON.stringify(layers.map((l) => [l.id, l.name, l.depth])) && rows.every((r) => r.shown), T("clearing the manifest goes back to the file's own tree, all shown"));

    check(errors.length === 0, T("no page errors"), errors[0]);
    await ctx.close();
  }

  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  if (current) await describeFailure(current.page, `layers-${current.kind.replace(/\s/g, "")}`);
  process.exit(1);
});
