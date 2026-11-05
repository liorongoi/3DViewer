// WP 1.7 acceptance, AC-04: zoom, spin and move with mouse, keyboard and touchpad; use the view
// cube and Home. Each control works as specified; frame rate ≥ 30 fps.
//
// Opens a GLB (the chess set, 49 named parts) and a 3D Tiles set in the real web app and drives
// it only with real input: mouse, wheel, keys, touch and clicks on the on-screen controls.
// After each step it reads the camera back and checks what the control promises (SRS NAV-01 to
// NAV-05):
//   - Wheel, touchpad pinch (ctrl + wheel), touchpad two-finger scroll, touch pinch, + / − keys
//     and the zoom buttons zoom; the wheel and pinches zoom toward the point under the cursor,
//     which stays under the cursor.
//   - Double-click sets the pivot on the model; left-drag (mouse or one finger) spins around it:
//     the pivot stays where it is on screen and at the same distance, and the camera never flips
//     over the top.
//   - Right-drag and middle-drag pan: the point grabbed stays under the cursor. Arrow keys move
//     the camera the way the arrow points.
//   - The view cube's faces, an edge, a corner and ISO look at the model from that side; the
//     compass ring turns with the camera, north up when looking north.
//   - Home (H and the button) fits the whole model. Clicking a part selects it in the layers
//     panel; Focus selection (Z and the button) fits that part; with nothing selected it fits
//     the whole model.
//   - Frame rate while spinning, panning and zooming is measured and reported. This sandbox
//     renders in software, so it is judged (≥ 30 fps) only with JUDGE_FPS=1, on the target PC.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-navigation.cjs [out folder]
// MODELS=m-chess,m-tiles-lod picks models. Set CHROMIUM to a Chromium binary if needed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MODELS = (process.env.MODELS ?? "m-chess,m-tiles-lod").split(",");
// SKIP=zoom,cube leaves those sections out, to re-run the rest faster.
const SKIP = (process.env.SKIP ?? "").split(",");
const on = (section) => !SKIP.includes(section);
const W = 1000;
const H = 640;

(async () => {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const fpsReport = [];

  for (const id of MODELS) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    // Open it the way a user does: its card in the library.
    const label = { "m-chess": "A Beautiful Game", "m-tiles-lod": "Discrete LOD", "m-tiles-city": "City block" }[id] ?? id;
    await page.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    await page.waitForFunction((id) => window.viewerEngine.current.get()?.id === id && (window.viewerEngine.model?.ready || window.viewerEngine.tileset), id, { timeout: 120000 });
    await page.evaluate(() => {
      const e = window.viewerEngine;
      // Shadows off: software rendering is slow enough without them; navigation does not use them.
      e.widget.scene.shadowMap.enabled = false;
      e.shadowsWanted = false;
      // Drawn on a timer rather than flat out: software rendering otherwise starves the input
      // events and the checks crawl. The frame-rate step turns the normal loop back on.
      e.widget.useDefaultRenderLoop = false;
      window.__renderTimer = setInterval(() => e.widget.render(), 100);
    });
    await settle(page, 4000);
    const kind = await page.evaluate(() => (window.viewerEngine.model ? "GLB" : "3D Tiles"));
    console.log(`· ${id} (${kind})`);
    const T = (what) => `${id} ${what}`;
    const canvasBox = await page.locator(".cesium-widget canvas").boundingBox();
    const at = (x, y) => ({ x: canvasBox.x + x, y: canvasBox.y + y });

    // ---- touch-action: the browser must leave touch gestures to the viewer ----
    const touchAction = await page.evaluate(() => getComputedStyle(document.querySelector(".cesium-widget canvas")).touchAction);
    check(touchAction === "none", T("the 3D view keeps touch gestures for itself (touch-action: none)"), touchAction);

    // A point on the model, off centre, for the cursor-anchored checks.
    const spot = await findModelPoint(page, [[0.42, 0.45], [0.55, 0.55], [0.5, 0.5], [0.6, 0.4], [0.45, 0.6]]);
    check(!!spot, T("a point on the model can be picked"));
    if (!spot) {
      await ctx.close();
      continue;
    }

    const cdp = await ctx.newCDPSession(page);
    if (on("zoom")) {
    // ---- NAV-01 zoom toward the cursor ----
    const zoomCheck = async (what, act, wantCloser, wantRatio) => {
      const p = await pickAt(page, spot.x, spot.y);
      if (!p) return check(false, T(`${what}: point under the cursor`));
      const before = await camDist(page, p);
      await act();
      await settle(page, 600);
      const after = await camDist(page, p);
      const s = await screenOf(page, p);
      const drift = s ? Math.hypot(s.x - spot.x, s.y - spot.y) : Infinity;
      const ratio = after / before;
      check(wantCloser ? ratio < 0.95 : ratio > 1.05, T(`${what}: ${wantCloser ? "zooms in" : "zooms out"}`), `distance ×${ratio.toFixed(3)}`);
      check(drift < 3, T(`${what}: the point under the cursor stays under it`), `moved ${drift.toFixed(1)} px`);
      if (wantRatio) check(Math.abs(ratio / wantRatio - 1) < 0.05, T(`${what}: follows the fingers (×${wantRatio.toFixed(3)} for that spread)`), `×${ratio.toFixed(3)}`);
    };
    await page.mouse.move(at(spot.x, spot.y).x, at(spot.x, spot.y).y);
    await zoomCheck("mouse wheel", () => page.mouse.wheel(0, -200), true);
    await zoomCheck("mouse wheel", () => page.mouse.wheel(0, 200), false);
    const wheel = (dy, ctrl, dx = 0) =>
      cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at(spot.x, spot.y).x, y: at(spot.x, spot.y).y, deltaX: dx, deltaY: dy, modifiers: ctrl ? 2 : 0 });
    // A touchpad pinch reaches the browser as a run of small ctrl + wheel events.
    await zoomCheck("touchpad pinch", async () => { for (let i = 0; i < 10; i++) await wheel(-6, true); }, true);
    await zoomCheck("touchpad pinch", async () => { for (let i = 0; i < 10; i++) await wheel(6, true); }, false);
    // Two-finger scroll on a touchpad is a run of small plain wheel events.
    await zoomCheck("touchpad two-finger scroll", async () => { for (let i = 0; i < 8; i++) await wheel(-25, false); }, true);
    await zoomCheck("touchpad two-finger scroll", async () => { for (let i = 0; i < 8; i++) await wheel(25, false); }, false);
    // Touch screen: two fingers spread apart around the point, then pinched together.
    const pinch = async (from, to) => {
      const c = at(spot.x, spot.y);
      const pts = (r) => [{ x: c.x - r, y: c.y, id: 1 }, { x: c.x + r, y: c.y, id: 2 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from) });
      for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(from + ((to - from) * i) / 8) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await zoomCheck("touch pinch", () => pinch(40, 120), true, 1 / 3);
    await zoomCheck("touch pinch", () => pinch(120, 40), false, 3);

    // Keys and buttons zoom toward the centre of the view.
    const centreZoom = async (what, act, wantCloser) => {
      const p = await pickAt(page, W / 2, H / 2);
      const target = p ?? (await page.evaluate(() => xyz(window.viewerEngine.camera.pivot)));
      const before = await camDist(page, target);
      await act();
      await settle(page, 600);
      const ratio = (await camDist(page, target)) / before;
      check(wantCloser ? ratio < 0.95 : ratio > 1.05, T(`${what}: ${wantCloser ? "zooms in" : "zooms out"}`), `distance ×${ratio.toFixed(3)}`);
    };
    await focusView(page);
    await centreZoom("+ key", () => page.keyboard.press("+"), true);
    await centreZoom("− key", () => page.keyboard.press("-"), false);
    await centreZoom("Zoom in button", () => clickCentre(page, page.getByRole("button", { name: /^Zoom in/ })), true);
    await centreZoom("Zoom out button", () => clickCentre(page, page.getByRole("button", { name: /^Zoom out/ })), false);

    }
    // ---- NAV-02 pivot by double-click, orbit by left-drag ----
    await page.keyboard.press("h");
    await settle(page, 2200);
    const dblSpot = (await findModelPoint(page, [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45]])) ?? spot;
    const want = await pickAt(page, dblSpot.x, dblSpot.y);
    // The pivot mark shows for a second; note when it is drawn.
    await page.evaluate(() => {
      const e = window.viewerEngine;
      const show = e.showPivot.bind(e);
      e.showPivot = (p) => {
        show(p);
        window.__pivotMarked = !!e.pivotMarker?.show;
      };
    });
    await page.mouse.dblclick(at(dblSpot.x, dblSpot.y).x, at(dblSpot.x, dblSpot.y).y);
    await settle(page, 400);
    const pivot = await page.evaluate(() => xyz(window.viewerEngine.camera.pivot));
    const pivotErr = want ? dist(pivot, want) : Infinity;
    const scale = await camDist(page, pivot);
    check(pivotErr < Math.max(0.02, scale * 0.002), T("double-click sets the pivot on the model where clicked"), `${pivotErr.toFixed(3)} m off at ${scale.toFixed(1)} m`);
    check(await page.evaluate(() => !!window.__pivotMarked), T("the pivot is marked in the view"));

    const orbitCheck = async (what, drag, expect) => {
      const p0 = await screenOf(page, pivot);
      const d0 = await camDist(page, pivot);
      const c0 = await camInfo(page);
      await drag();
      await settle(page, 500);
      const p1 = await screenOf(page, pivot);
      const d1 = await camDist(page, pivot);
      const c1 = await camInfo(page);
      const dh = wrapDeg(c1.heading - c0.heading);
      const dp = c1.pitch - c0.pitch;
      const moved = p0 && p1 ? Math.hypot(p1.x - p0.x, p1.y - p0.y) : Infinity;
      check(expect(dh, dp), T(`${what}: spins the camera`), `heading ${dh.toFixed(1)}°, pitch ${dp.toFixed(1)}°`);
      check(moved < 2, T(`${what}: the pivot stays put on screen`), `moved ${moved.toFixed(1)} px`);
      check(Math.abs(d1 / d0 - 1) < 0.002, T(`${what}: the camera stays at the same distance from the pivot`), `×${(d1 / d0).toFixed(4)}`);
      return c1;
    };
    const mouseDrag = async (button, dx, dy, steps = 12, from = { x: W * 0.6, y: H * 0.5 }) => {
      const a = at(from.x, from.y);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down({ button });
      for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + (dx * i) / steps, a.y + (dy * i) / steps);
      await page.mouse.up({ button });
    };
    // 150 px sideways is 150 · π / height of the view in heading.
    const kOrbit = (180 / Math.max(400, H)) * 1;
    await orbitCheck("left-drag sideways", () => mouseDrag("left", 150, 0), (dh) => Math.abs(Math.abs(dh) - 150 * kOrbit) < 1.5);
    await orbitCheck("left-drag up and down", () => mouseDrag("left", 0, 80, 12, { x: W * 0.6, y: H * 0.4 }), (dh, dp) => Math.abs(dp) > 3 && Math.abs(dh) < 1.5);
    // Dragging far down never takes the camera past straight down or over the top.
    // (in strokes that stay inside the window; the layers panel covers the left side)
    // The globe is hidden meanwhile: looking along the ground to the horizon takes software
    // rendering minutes per frame. The camera limits do not depend on it.
    await page.evaluate(() => (window.viewerEngine.widget.scene.globe.show = false));
    for (let i = 0; i < 6; i++) await mouseDrag("left", 0, -400, 20, { x: W * 0.6, y: H * 0.8 });
    await settle(page, 400);
    const a1 = await camInfo(page);
    for (let i = 0; i < 8; i++) await mouseDrag("left", 0, 400, 20, { x: W * 0.6, y: H * 0.15 });
    await settle(page, 400);
    const a2 = await camInfo(page);
    await page.evaluate(() => (window.viewerEngine.widget.scene.globe.show = true));
    const top = a1.pitch < a2.pitch ? a1 : a2;
    const low = a1.pitch < a2.pitch ? a2 : a1;
    check(top.pitch >= -90.01 && top.pitch < -85 && low.pitch <= 11, T("spinning stops at straight down and a little above the horizon, never flipping"), `${top.pitch.toFixed(1)}° to ${low.pitch.toFixed(1)}°`);
    // Touch: one finger spins too.
    await page.keyboard.press("h");
    await settle(page, 2200);
    await page.mouse.dblclick(at(dblSpot.x, dblSpot.y).x, at(dblSpot.x, dblSpot.y).y);
    await settle(page, 300);
    const pivot2 = await page.evaluate(() => xyz(window.viewerEngine.camera.pivot));
    pivot.x = pivot2.x; pivot.y = pivot2.y; pivot.z = pivot2.z;
    await orbitCheck(
      "one-finger drag",
      async () => {
        const a = at(W * 0.6, H * 0.5);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
        for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + i * 12, y: a.y, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      },
      (dh) => Math.abs(Math.abs(dh) - 120 * kOrbit) < 1.5,
    );

    // ---- NAV-03 pan: right / middle drag keeps the grabbed point under the cursor; arrows ----
    const panCheck = async (what, button, dx, dy) => {
      const s0 = await screenOf(page, pivot);
      const c0 = await camInfo(page);
      await mouseDrag(button, dx, dy, 10, s0);
      await settle(page, 500);
      const s1 = await screenOf(page, pivot);
      const c1 = await camInfo(page);
      const err = Math.hypot(s1.x - (s0.x + dx), s1.y - (s0.y + dy));
      check(err < 2, T(`${what}: the grabbed point follows the cursor`), `${err.toFixed(1)} px off`);
      check(Math.abs(wrapDeg(c1.heading - c0.heading)) < 0.05 && Math.abs(c1.pitch - c0.pitch) < 0.05, T(`${what}: the view does not turn`));
    };
    await page.keyboard.press("h");
    await settle(page, 2200);
    await page.mouse.dblclick(at(dblSpot.x, dblSpot.y).x, at(dblSpot.x, dblSpot.y).y);
    await settle(page, 300);
    Object.assign(pivot, await page.evaluate(() => xyz(window.viewerEngine.camera.pivot)));
    await panCheck("right-drag", "right", 120, -60);
    await panCheck("middle-drag", "middle", -90, 70);
    // An arrow moves the camera that way, so the view's content slides the other way.
    await focusView(page);
    for (const [key, sx, sy] of [["ArrowLeft", 1, 0], ["ArrowRight", -1, 0], ["ArrowUp", 0, 1], ["ArrowDown", 0, -1]]) {
      const s0 = await screenOf(page, pivot);
      await page.keyboard.press(key);
      await settle(page, 400);
      const s1 = await screenOf(page, pivot);
      const mx = s1.x - s0.x;
      const my = s1.y - s0.y;
      const ok = (sx ? Math.sign(mx) === sx && Math.abs(mx) > 20 : Math.abs(mx) < 3) && (sy ? Math.sign(my) === sy && Math.abs(my) > 20 : Math.abs(my) < 3);
      check(ok, T(`${key} moves the camera ${key.slice(5).toLowerCase()}`), `content moved ${mx.toFixed(0)}, ${my.toFixed(0)} px`);
    }

    if (on("cube")) {
    // ---- NAV-04 view cube and compass ----
    // Each is clicked where the user sees it, starting from Home (looking north-east, so the
    // top, south and west faces show); a hidden face cannot be clicked.
    const cube = async (label) => {
      await page.keyboard.press("h");
      await settle(page, 2000);
      const hit = await page.evaluate((label) => {
        for (const b of document.querySelectorAll(`button[aria-label="${label}"]`)) {
          const r = b.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          if (r.width > 2 && r.height > 2 && document.elementFromPoint(x, y) === b) return { x, y, dir: b.dataset.dir.split(",").map(Number) };
        }
        return null;
      }, label);
      if (!hit) return check(false, T(`view cube "${label}" can be clicked from Home`));
      await page.mouse.click(hit.x, hit.y);
      await settle(page, 1500);
      const r = await page.evaluate((dir) => {
        const e = window.viewerEngine;
        const bs = e.boundingSphere();
        const c = bs.center;
        const up = norm({ x: c.x / 6378137 ** 2, y: c.y / 6378137 ** 2, z: c.z / 6356752.314245 ** 2 });
        const east = norm({ x: -c.y, y: c.x, z: 0 });
        const north = cross(up, east);
        const d = e.widget.camera.directionWC;
        const enu = [dot(d, east), dot(d, north), dot(d, up)];
        const n = Math.hypot(...dir);
        // Looking along the opposite of the direction; a side view looks 5° down so the ground
        // does not fill the view edge-on (as the viewer flies it).
        const t = (5 * Math.PI) / 180;
        const wantDir = dir[2] === 0 ? [(-dir[0] / n) * Math.cos(t), (-dir[1] / n) * Math.cos(t), -Math.sin(t)] : dir.map((v) => -v / n);
        const ang = (Math.acos(Math.min(1, enu.reduce((s, v, i) => s + v * wantDir[i], 0))) * 180) / Math.PI;
        const s = e.widget.scene.cartesianToCanvasCoordinates(c);
        return { ang, centre: s ? Math.hypot(s.x - e.widget.canvas.clientWidth / 2, s.y - e.widget.canvas.clientHeight / 2) : Infinity };
      }, hit.dir);
      // Straight down is flown at 89.9°, so allow a little.
      check(r.ang < 1 && r.centre < 5, T(`view cube "${label}" (${hit.dir.join(", ")}) looks at the model from that side`), `${r.ang.toFixed(2)}° off, model centre ${r.centre.toFixed(1)} px from the middle`);
    };
    for (const label of ["TOP view", "S view", "W view", "S edge view", "W corner view", "TOP corner view"]) await cube(label);
    // ISO: from the south-west, 35° down.
    await clickCentre(page, page.getByRole("button", { name: /^ISO/ }));
    await settle(page, 1500);
    const iso = await camInfo(page);
    check(Math.abs(wrapDeg(iso.heading - 45)) < 1 && Math.abs(iso.pitch + 35) < 1, T("ISO looks from 45° heading, 35° down"), `${iso.heading.toFixed(1)}°, ${iso.pitch.toFixed(1)}°`);
    // The compass ring turns with the camera: north at the top when looking north.
    for (const turn of [0, 90, 200]) {
      // A turn of `turn` degrees, in strokes of at most 300 px from the right half of the view.
      for (let px = (turn * Math.max(400, H)) / 180; px > 0.5; px -= 300) await mouseDrag("left", Math.min(300, px), 0, 15, { x: W * 0.55, y: H * 0.5 });
      await settle(page, 400);
      const c = await camInfo(page);
      const ring = await page.evaluate(() => {
        const el = [...document.querySelectorAll("div")].find((d) => /rotate\(/.test(d.style.transform) && d.querySelector("span")?.textContent === "N");
        return el ? Number(/rotate\((-?[\d.e-]+)deg\)/.exec(el.style.transform)[1]) : NaN;
      });
      check(Math.abs(wrapDeg(ring + c.heading)) < 0.5, T(`the compass ring shows north (camera heading ${c.heading.toFixed(0)}°)`), `ring turned ${ring.toFixed(1)}°`);
    }

    }
    // ---- NAV-05 Home and Focus selection ----
    const fitsWhole = async (what) => {
      await settle(page, 2000);
      const f = await fit(page, null);
      check(f.centre < 0.05 && f.fill > 0.2 && f.fill < 0.75, T(`${what} fits the whole model`), `centre ${(f.centre * 100).toFixed(1)}% off, fills ${(f.fill * 100).toFixed(0)}% of the view`);
    };
    await mouseDrag("right", 300, 150);
    await page.keyboard.press("h");
    await fitsWhole("H");
    await mouseDrag("right", -250, 120);
    await clickCentre(page, page.getByRole("button", { name: /^Home/ }));
    await fitsWhole("the Home button");

    if (kind === "GLB") {
      // The root layer's extent, worked out from the file, matches what Cesium draws.
      const agree = await page.evaluate(() => {
        const e = window.viewerEngine;
        const root = e.layers.get();
        const all = root.map((l) => e.layerSphere(l.id)).filter(Boolean);
        const bs = e.boundingSphere();
        const far = Math.max(...all.map((s) => dist(s.center, bs.center) + s.radius));
        return { far, r: bs.radius };
      });
      check(agree.far <= agree.r * 1.15 && agree.far >= agree.r * 0.85, T("the parts' extents match the model's drawn extent"), `${agree.far.toFixed(2)} m vs ${agree.r.toFixed(2)} m`);
    }
    // Click a part of the model: it is selected in the layers panel.
    await page.keyboard.press("h");
    await settle(page, 2000);
    if (!(await page.locator('[role="tree"]').count())) await page.keyboard.press("l");
    const partSpot = (await findModelPoint(page, [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45], [0.5, 0.55]])) ?? spot;
    await page.mouse.click(at(partSpot.x, partSpot.y).x, at(partSpot.x, partSpot.y).y);
    await settle(page, 400);
    const sel = await page.evaluate(() => window.viewerEngine.selectedLayer.get());
    const row = sel ? await page.locator(`[role="treeitem"][data-layer="${sel}"]`).getAttribute("aria-selected").catch(() => null) : null;
    check(!!sel && row === "true", T("clicking the model selects the part in the layers panel"), sel ?? "nothing selected");
    if (sel) {
      await mouseDrag("right", 200, 100);
      await page.keyboard.press("z");
      await settle(page, 1800);
      const f = await fit(page, sel);
      check(f.centre < 0.05 && f.fill > 0.2 && f.fill < 0.75, T(`Z fits the selected part (${sel})`), `centre ${(f.centre * 100).toFixed(1)}% off, fills ${(f.fill * 100).toFixed(0)}%`);
      await mouseDrag("right", -200, 100);
      await clickCentre(page, page.getByRole("button", { name: /^Focus selection/ }).last());
      await settle(page, 1800);
      const g = await fit(page, sel);
      check(g.centre < 0.05 && g.fill > 0.2 && g.fill < 0.75, T("the Focus selection button fits it too"), `centre ${(g.centre * 100).toFixed(1)}% off`);
      if (out) await shot(page, path.join(out, `${id}-focus.png`));
    }
    // Click the empty sky: the selection clears, and Z fits the whole model.
    await page.evaluate(() => window.viewerEngine.widget.camera.setView({ orientation: { heading: 0, pitch: 0.3, roll: 0 } }));
    await settle(page, 300);
    await page.mouse.click(at(W * 0.5, 40).x, at(W * 0.5, 40).y + 40);
    await settle(page, 300);
    check((await page.evaluate(() => window.viewerEngine.selectedLayer.get())) === null, T("clicking empty space clears the selection"));
    await page.keyboard.press("z");
    await fitsWhole("Z with nothing selected");

    // ---- NFR-03 frame rate while navigating ----
    await page.keyboard.press("h");
    await settle(page, 2000);
    await page.evaluate(() => {
      clearInterval(window.__renderTimer);
      window.viewerEngine.widget.useDefaultRenderLoop = true;
    });
    const fps = await measureFps(page, async () => {
      await mouseDrag("left", 300, 30, 20);
      await mouseDrag("right", -200, 80, 12);
      for (let i = 0; i < 8; i++) await page.mouse.wheel(0, i < 4 ? -60 : 60);
    });
    fpsReport.push(`${id}: ${fps.avg.toFixed(1)} fps average, slowest frame ${fps.worst.toFixed(0)} ms`);
    if (process.env.JUDGE_FPS) check(fps.avg >= 30 && fps.worst < 1000 / 30 * 2, T("frame rate stays ≥ 30 fps while navigating"), `${fps.avg.toFixed(1)} fps`);
    else console.log(`INFO ${T("frame rate while navigating")}: ${fps.avg.toFixed(1)} fps average, slowest frame ${fps.worst.toFixed(0)} ms (software rendering, not judged)`);

    if (out) await shot(page, path.join(out, `${id}.png`));
    check(errors.length === 0, T("no page errors"), errors[0]);
    await ctx.close();
  }
  await browser.close();
  if (fpsReport.length) console.log(`\nFrame rate (software rendering): ${fpsReport.join("; ")}`);
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();

// ---------- helpers (run in Node; the page side is injected by inPage) ----------

const PAGE_HELPERS = `
  window.xyz = (p) => ({ x: p.x, y: p.y, z: p.z });
  window.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  window.norm = (v) => { const n = Math.hypot(v.x, v.y, v.z); return { x: v.x / n, y: v.y / n, z: v.z / n }; };
  window.dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  window.cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
`;

async function helpers(page) {
  await page.evaluate((src) => {
    if (!window.xyz) new Function(src)();
  }, PAGE_HELPERS);
}

/** Lets the view draw a few frames, then waits a moment. */
async function settle(page, ms) {
  await page.waitForTimeout(ms);
  await helpers(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A screenshot, allowed to fail: a slow software-rendered frame can outlast Playwright's wait. */
async function shot(page, file) {
  await page.screenshot({ path: file, timeout: 120000 }).catch((e) => console.log(`(screenshot skipped: ${e.message.split("\n")[0]})`));
}

/** Clicks the middle of an element with the mouse, as a user would, without waiting for the page to idle. */
async function clickCentre(page, locator) {
  const b = await locator.first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function pickAt(page, x, y) {
  return page.evaluate(([x, y]) => {
    const e = window.viewerEngine;
    e.widget.render();
    const p = e.pick({ x, y });
    return p ? xyz(p) : null;
  }, [x, y]);
}

/** The first candidate (fractions of the view) that lands on the model rather than the ground. */
async function findModelPoint(page, candidates) {
  const vp = page.viewportSize();
  for (const [fx, fy] of candidates) {
    const x = Math.round(vp.width * fx);
    const y = Math.round(vp.height * fy);
    const onModel = await page.evaluate(([x, y]) => {
      const e = window.viewerEngine;
      e.widget.render();
      const o = e.widget.scene.pick({ x, y });
      return !!o && (o.primitive === e.model || o.primitive === e.tileset || o.content?.tileset === e.tileset);
    }, [x, y]);
    if (onModel) return { x, y };
  }
  return null;
}

async function screenOf(page, p) {
  return page.evaluate((p) => {
    const s = window.viewerEngine.widget.scene.cartesianToCanvasCoordinates(p);
    return s ? { x: s.x, y: s.y } : null;
  }, p);
}

async function camDist(page, p) {
  return page.evaluate((p) => dist(window.viewerEngine.widget.camera.positionWC, p), p);
}

async function camInfo(page) {
  return page.evaluate(() => {
    const c = window.viewerEngine.widget.camera;
    return { heading: (c.heading * 180) / Math.PI, pitch: (c.pitch * 180) / Math.PI };
  });
}

/** How well a sphere (a layer's, or the whole model's) sits in the view: centre offset and size, as fractions of the view. */
async function fit(page, layerId) {
  return page.evaluate((layerId) => {
    const e = window.viewerEngine;
    const bs = layerId && layerId !== "tileset" ? e.layerSphere(layerId) : e.boundingSphere();
    const cam = e.widget.camera;
    const d = dist(cam.positionWC, bs.center);
    const fovy = cam.frustum.fovy;
    // Apparent diameter over the view's height.
    const fill = (2 * Math.asin(Math.min(1, bs.radius / d))) / fovy;
    // How far off the middle of the view the centre is, as an angle over the view's height
    // (worked out directly: Cesium's own projection gives nothing for points this close).
    const to = norm({ x: bs.center.x - cam.positionWC.x, y: bs.center.y - cam.positionWC.y, z: bs.center.z - cam.positionWC.z });
    const off = Math.acos(Math.min(1, dot(to, cam.directionWC)));
    return { centre: off / fovy, fill };
  }, layerId);
}

/** Keyboard focus on the page body, not a text box, so the view's keys reach it. */
async function focusView(page) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
}

function wrapDeg(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function measureFps(page, act) {
  await page.evaluate(() => {
    window.__frames = [];
    const e = window.viewerEngine;
    window.__offFrames = e.widget.scene.postRender.addEventListener(() => window.__frames.push(performance.now()));
  });
  await act();
  return page.evaluate(() => {
    window.__offFrames();
    const t = window.__frames;
    const gaps = t.slice(1).map((v, i) => v - t[i]);
    return { avg: gaps.length ? 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0, worst: gaps.length ? Math.max(...gaps) : 0 };
  });
}
