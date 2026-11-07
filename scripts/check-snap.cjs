// WP 2.3 acceptance (MSR-03): a measurement point placed within 10 px of a corner or an edge
// lands on it, at least 99 times in 100.
//
// The test set is a block model made here: a 60 × 60 m ground slab, tessellated as exporters do,
// and seven buildings, one standing on another's roof. Every box is written as glTF exporters
// write it, four vertices per face, so corners must be found by welding. The model is opened in
// the real web app twice: as a GLB, and tiled into 3D Tiles by the server's own tiler. From five
// views (four oblique, one from above) the check then places the cursor:
//   - near every visible corner, up to 9 px away in a random direction: it must snap to that
//     corner (within 1 cm);
//   - near visible edges, away from the corners, up to 9 px to the side: it must snap onto that
//     edge (within 1 cm of it);
//   - on roofs and on the ground, more than 15 px from any edge: it must not snap.
// The truth is the box geometry itself, put in the world by the model's transforms. A cursor
// that has another corner or edge as near as its target is left out (either answer is right).
// Last, a distance is measured with the mouse in the app: two clicks near two roof corners must
// give the exact corner-to-corner distance, and an Alt+click must not snap.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-snap.cjs
// Set CHROMIUM to a Chromium binary if needed.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "apps/web/dist/samples/_check-snap");
const GLB = path.join(OUT, "blocks.glb");
// One tile: snapping uses the geometry drawn, and a coarser level of detail has its own
// (simplified) corners, so the tiled copy is checked at full detail. (How a measurement gets full
// detail on a tileset with levels is WP 2.4's.)
const TILED = path.join(OUT, "tiled");

// [x0, z0, width (x), depth (z), y0, height]: glTF is y-up.
const BOXES = [
  [-20, -20, 8, 6, 0, 12],
  [-5, -22, 10, 10, 0, 6],
  [10, -18, 6, 14, 0, 20],
  [-22, 5, 12, 8, 0, 4],
  [2, 4, 7, 7, 0, 9],
  [15, 10, 10, 6, 0, 3],
  [4, 6, 3, 3, 9, 3],
];
const GROUND = 60;

function writeGlb(file) {
  const nodes = [];
  const meshes = [];
  const accessors = [];
  const views = [];
  const chunks = [];
  let offset = 0;
  const add = (arr, target) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf);
    offset += buf.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    return views.length - 1;
  };
  const mesh = (name, positions, indices) => {
    const pos = Float32Array.from(positions);
    const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)));
    accessors.push({ bufferView: add(pos, 34962), componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    const pi = accessors.length - 1;
    accessors.push({ bufferView: add(Uint32Array.from(indices), 34963), componentType: 5125, count: indices.length, type: "SCALAR" });
    meshes.push({ name, primitives: [{ attributes: { POSITION: pi }, indices: accessors.length - 1, material: 0 }] });
    nodes.push({ name, mesh: meshes.length - 1 });
  };
  // The ground: a 12 × 12 grid of quads.
  {
    const n = 12;
    const p = [];
    const ix = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) p.push(-GROUND / 2 + (i / n) * GROUND, 0, -GROUND / 2 + (j / n) * GROUND);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        ix.push(a, a + n + 1, a + n + 2, a, a + n + 2, a + 1);
      }
    mesh("Ground", p, ix);
  }
  BOXES.forEach(([x0, z0, w, d, y0, h], b) => {
    const c = (i) => [i & 1 ? x0 + w : x0, i & 2 ? y0 + h : y0, i & 4 ? z0 + d : z0];
    // Outward faces, counter-clockwise seen from outside.
    const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    const p = [];
    const ix = [];
    for (const f of faces) {
      const base = p.length / 3;
      for (const v of f) p.push(...c(v));
      ix.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    mesh(`Building ${b + 1}`, p, ix);
  });
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "check-snap" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.78, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunk = (buf, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(buf.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, buf]);
  };
  fs.writeFileSync(file, Buffer.concat([header, chunk(jsonBuf, 0x4e4f534a), chunk(bin, 0x004e4942)]));
}

/** Corners and edges of the test set, in glTF coordinates, by node. */
function truth() {
  const corners = [];
  const edges = [];
  BOXES.forEach(([x0, z0, w, d, y0, h], b) => {
    const node = b + 1;
    const c = (i) => [i & 1 ? x0 + w : x0, i & 2 ? y0 + h : y0, i & 4 ? z0 + d : z0];
    for (let i = 0; i < 8; i++) corners.push({ node, p: c(i) });
    for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) edges.push({ node, a: c(i), b: c(i | bit) });
  });
  const g = GROUND / 2;
  const gc = [[-g, 0, -g], [g, 0, -g], [g, 0, g], [-g, 0, g]];
  gc.forEach((p, i) => {
    corners.push({ node: 0, p });
    edges.push({ node: 0, a: p, b: gc[(i + 1) % 4] });
  });
  // Roofs and open ground, for the cursor that must not snap.
  const flats = BOXES.map(([x0, z0, w, d, y0, h], b) => ({ node: b + 1, p: [x0 + w / 2, y0 + h, z0 + d / 2] }));
  flats.push({ node: 0, p: [0, 0, 25] }, { node: 0, p: [-25, 0, -5] }, { node: 0, p: [25, 0, -25] });
  return { corners, edges, flats };
}

fs.mkdirSync(OUT, { recursive: true });
writeGlb(GLB);
if (!fs.existsSync(path.join(TILED, "tileset.json"))) {
  const tiler = path.join(ROOT, "apps/server/src/tiler.ts");
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { tileModel } from ${JSON.stringify(tiler)}; await tileModel(${JSON.stringify(GLB)}, ${JSON.stringify(TILED)}, { leafTriangles: 100000 });`], { stdio: "inherit", cwd: path.join(ROOT, "apps/server") });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const T = truth();
  let worldTruth = null;

  for (const kind of ["GLB", "3D Tiles"]) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.text().startsWith("[snap]") && console.log("  " + m.text()));
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    // A render error stops Cesium's render loop without a page error: count it as one.
    await page.evaluate(() => window.viewerEngine.widget.scene.renderError.addEventListener((_, err) => console.log(`[snap] render error: ${err?.stack ?? err}`)));
    page.on("console", (m) => m.text().startsWith("[snap] render error") && errors.push(m.text()));
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
    await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    await page.evaluate(async (kind) => {
      const e = window.viewerEngine;
      const s = e.current.get();
      const placement = { lat: s.centre.lat, lon: s.centre.lon, height: 0, headingDeg: 0, scale: 1, upAxis: "y" };
      const source =
        kind === "GLB"
          ? { kind: "glb", url: "samples/_check-snap/blocks.glb" }
          : { kind: "3dtiles", url: "samples/_check-snap/tiled/tileset.json", localFrame: true };
      await e.open({ ...s, id: `check-snap-${kind}`, name: "Blocks", placement, source }, { fly: false });
      e.widget.scene.shadowMap.enabled = false;
      e.shadowsWanted = false;
      // Drawn on a timer, as in check-layers: software rendering flat out starves the page.
      e.widget.useDefaultRenderLoop = false;
      window.__renderTimer = setInterval(() => e.widget.render(), 100);
    }, kind);
    if (kind === "3D Tiles") await page.waitForFunction(() => window.viewerEngine.tileset?.tilesLoaded, null, { timeout: 180000 });
    check(!(await page.evaluate(() => window.viewerEngine.error.get())), `${kind}: the block model opens`);

    if (kind === "GLB") {
      // glTF coordinates to the world, through the model's own transforms.
      worldTruth = await page.evaluate((T) => {
        const m = window.viewerEngine.model;
        const sg = m.sceneGraph;
        const mul = (M, p) => [0, 1, 2].map((r) => M[r] * p[0] + M[r + 4] * p[1] + M[r + 8] * p[2] + M[r + 12]);
        const world = (node, p) => mul(sg.computedModelMatrix, mul(sg._runtimeNodes[node].computedTransform, p));
        return {
          corners: T.corners.map((c) => world(c.node, c.p)),
          edges: T.edges.map((e) => [world(e.node, e.a), world(e.node, e.b)]),
          flats: T.flats.map((f) => world(f.node, f.p)),
        };
      }, T);
    }

    // The views: four oblique, one from above. Each returns the samples and what they snapped to.
    const views = [[30, -35], [120, -40], [210, -30], [300, -45], [0, -89]].slice(0, Number(process.env.SNAP_VIEWS || 5));
    let hits = 0, total = 0, vHits = 0, vTotal = 0, eHits = 0, eTotal = 0, falseSnaps = 0, flatTotal = 0;
    const misses = [];
    for (const [heading, pitch] of views) {
      console.log(`  ${kind}: view ${heading}°, ${pitch}°`);
      const r = await page.evaluate(
        async ({ W, heading, pitch, seed }) => {
                    const e = window.viewerEngine;
          const scene = e.widget.scene;
          const cam = scene.camera;
          // Look at the middle of the blocks from 110 m.
          const C3 = cam.position.constructor;
          const centre = new C3(...W.corners.reduce((s, p) => s.map((v, k) => v + p[k] / W.corners.length), [0, 0, 0]));
          const toRad = (d) => (d * Math.PI) / 180;
          cam.lookAt(centre, { heading: toRad(heading), pitch: toRad(pitch), range: 110 });
          cam.lookAtTransform(cam.transform.constructor.IDENTITY);
          for (let i = 0; i < 4; i++) {
            e.widget.render();
            await new Promise((r) => setTimeout(r, 50));
          }
          // Loaded for a second of frames in a row: a tile unloaded while out of view is asked for
          // again only by the next frame, so a single check can pass before it is.
          for (let i = 0, settled = 0; i < 600 && e.tileset && settled < 5; i++) {
            e.widget.render();
            await new Promise((r) => setTimeout(r, 200));
            settled = e.tileset.tilesLoaded ? settled + 1 : 0;
          }
          e.widget.render();
          // Indexes built in the worker: ask once, wait, then measure.
          e.measurePoint({ x: 600, y: 400 });
          await e.snapper.whenIdle();
          e.widget.render();

          let rnd = seed;
          const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648), rnd / 2147483648);
          const width = scene.canvas.clientWidth, height = scene.canvas.clientHeight;
          const eye = cam.positionWC;
          const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          const screen = (p) => {
            const s = scene.cartesianToCanvasCoordinates(new C3(...p));
            return s && s.x > 15 && s.y > 15 && s.x < width - 15 && s.y < height - 15 ? [s.x, s.y] : null;
          };
          // In view: nothing drawn in front of it.
          const visible = (p) => {
            const s = scene.cartesianToCanvasCoordinates(new C3(...p));
            if (!s) return false;
            const q = scene.pickPosition(s);
            if (!q) return true;
            const dp = dist([eye.x, eye.y, eye.z], p);
            return Math.hypot(q.x - eye.x, q.y - eye.y, q.z - eye.z) >= dp - Math.max(dp * 0.003, 0.05);
          };
          const segDist2 = (p, a, b) => {
            const ux = b[0] - a[0], uy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / (ux * ux + uy * uy || 1)));
            return Math.hypot(p[0] - a[0] - t * ux, p[1] - a[1] - t * uy);
          };
          const segDist3 = (p, a, b) => {
            const u = [0, 1, 2].map((k) => b[k] - a[k]);
            const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
            const t = Math.max(0, Math.min(1, [0, 1, 2].reduce((s, k) => s + (p[k] - a[k]) * u[k], 0) / uu));
            return dist(p, [0, 1, 2].map((k) => a[k] + t * u[k]));
          };
          // Corners and edges on screen, for ambiguity: a corner hidden behind a wall still counts
          // as visible on screen if any part near it is, so all are kept here.
          const sc = W.corners.map((p) => ({ p, s: screen(p), vis: visible(p) }));
          const se = W.edges.map(([a, b]) => ({ a, b, sa: scene.cartesianToCanvasCoordinates(new C3(...a)), sb: scene.cartesianToCanvasCoordinates(new C3(...b)) }));
          const snapAt = (x, y) => {
            const s = e.measurePoint({ x, y });
            return s ? { kind: s.kind, p: [s.position.x, s.position.y, s.position.z], px: s.pixels } : null;
          };
          const out = { vertex: [], edge: [], flat: [] };
          // Corners.
          for (const c of sc) {
            if (!c.s || !c.vis) continue;
            if (sc.some((o) => o !== c && o.s && o.vis && Math.hypot(o.s[0] - c.s[0], o.s[1] - c.s[1]) < 20)) continue;
            for (let k = 0; k < 2; k++) {
              const a = random() * Math.PI * 2, rr = random() * 9;
              const x = c.s[0] + Math.cos(a) * rr, y = c.s[1] + Math.sin(a) * rr;
              const got = snapAt(x, y);
              out.vertex.push({ ok: !!got && got.kind === "vertex" && dist(got.p, c.p) <= 0.01, got, want: c.p, at: [x, y] });
            }
          }
          // Edges, away from corners and from other edges.
          for (const ed of se) {
            if (!ed.sa || !ed.sb) continue;
            for (const t of [0.3, 0.5, 0.7]) {
              const P = [0, 1, 2].map((k) => ed.a[k] + t * (ed.b[k] - ed.a[k]));
              const s = screen(P);
              if (!s || !visible(P)) continue;
              const dirx = ed.sb.x - ed.sa.x, diry = ed.sb.y - ed.sa.y;
              const len = Math.hypot(dirx, diry);
              if (len < 40) continue;
              const off = (random() * 2 - 1) * 9;
              const x = s[0] - (diry / len) * off, y = s[1] + (dirx / len) * off;
              if (sc.some((o) => o.s && Math.hypot(o.s[0] - x, o.s[1] - y) < 14)) continue;
              const others = se.filter((o) => o !== ed && o.sa && o.sb && segDist2([x, y], [o.sa.x, o.sa.y], [o.sb.x, o.sb.y]) < Math.abs(off) + 4);
              // An edge that lies on this one on screen (a roof edge over a wall foot) is the same answer.
              if (others.some((o) => segDist3(o.a, ed.a, ed.b) > 0.01 || segDist3(o.b, ed.a, ed.b) > 0.01)) continue;
              const got = snapAt(x, y);
              out.edge.push({ ok: !!got && got.kind === "edge" && segDist3(got.p, ed.a, ed.b) <= 0.01, got, want: [ed.a, ed.b], at: [x, y] });
            }
          }
          // Flat places, far from any edge.
          for (const f of W.flats) {
            const s = screen(f);
            if (!s || !visible(f)) continue;
            for (let k = 0; k < 3; k++) {
              const x = s[0] + (random() * 2 - 1) * 6, y = s[1] + (random() * 2 - 1) * 6;
              if (se.some((o) => o.sa && o.sb && segDist2([x, y], [o.sa.x, o.sa.y], [o.sb.x, o.sb.y]) < 15)) continue;
              const got = snapAt(x, y);
              out.flat.push({ ok: !!got && got.kind === "surface", got, at: [x, y] });
            }
          }
          return out;
        },
        { W: worldTruth, heading, pitch, seed: heading + 7 },
      );
      for (const s of r.vertex) {
        vTotal++;
        if (s.ok) vHits++;
        else misses.push({ view: [heading, pitch], ...s });
      }
      for (const s of r.edge) {
        eTotal++;
        if (s.ok) eHits++;
        else misses.push({ view: [heading, pitch], ...s });
      }
      for (const s of r.flat) {
        flatTotal++;
        if (!s.ok) falseSnaps++;
      }
    }
    hits = vHits + eHits;
    total = vTotal + eTotal;
    check(vTotal >= 60, `${kind}: enough corner samples`, vTotal);
    check(eTotal >= 60, `${kind}: enough edge samples`, eTotal);
    check(total > 0 && hits / total >= 0.99, `${kind}: snap hit rate within 10 px is at least 99 %`, `${hits} of ${total}: corners ${vHits}/${vTotal}, edges ${eHits}/${eTotal}`);
    check(flatTotal >= 20 && falseSnaps / flatTotal <= 0.01, `${kind}: no snapping far from edges`, `${falseSnaps} of ${flatTotal} snapped`);
    for (const m of misses.slice(0, 5)) console.log("  miss", JSON.stringify(m));

    if (kind === "GLB") {
      // With the mouse, in the app: two roof corners of the tallest building.
      const [a, b] = await page.evaluate(
        async ({ W, roof }) => {
          const e = window.viewerEngine;
          const cam = e.widget.scene.camera;
          const C3 = cam.position.constructor;
          const toRad = (d) => (d * Math.PI) / 180;
          cam.lookAt(new C3(...W.flats[2]), { heading: toRad(200), pitch: toRad(-50), range: 70 });
          cam.lookAtTransform(cam.transform.constructor.IDENTITY);
          e.widget.useDefaultRenderLoop = true;
          await new Promise((r) => setTimeout(r, 500));
          return roof.map((i) => {
            const s = e.widget.scene.cartesianToCanvasCoordinates(new C3(...W.corners[i]));
            return [s.x, s.y];
          });
        },
        { W: worldTruth, roof: [2 * 8 + 6, 2 * 8 + 7] },
      );
      await page.keyboard.press("m");
      const canvas = page.locator("canvas").first();
      const box = await canvas.boundingBox();
      for (const [x, y] of [a, b]) {
        await page.mouse.move(box.x + x + 6, box.y + y - 5, { steps: 4 });
        await page.waitForTimeout(400);
        await page.mouse.click(box.x + x + 6, box.y + y - 5);
        await page.waitForTimeout(300);
      }
      const m = await page.evaluate(() => window.viewerEngine.measure.measurements.get().map((x) => ({ total: x.result.total3d, points: x.points.map((p) => [p.x, p.y, p.z]) })));
      const wa = worldTruth.corners[2 * 8 + 6], wb = worldTruth.corners[2 * 8 + 7];
      const exact = Math.hypot(wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]);
      check(m.length === 1 && Math.abs(m[0].total - exact) <= 0.001, "mouse: two clicks near roof corners measure corner to corner", m[0] ? `${m[0].total.toFixed(4)} m, exact ${exact.toFixed(4)} m` : "no measurement");
      // Alt: placed where the cursor is, not on the corner.
      await page.keyboard.down("Alt");
      await page.mouse.click(box.x + a[0] + 6, box.y + a[1] + 5);
      await page.mouse.click(box.x + b[0] + 6, box.y + b[1] + 5);
      await page.keyboard.up("Alt");
      await page.waitForTimeout(300);
      const m2 = await page.evaluate(() => window.viewerEngine.measure.measurements.get().map((x) => x.points.map((p) => [p.x, p.y, p.z])));
      const free = m2[1];
      check(!!free && Math.hypot(free[0][0] - wa[0], free[0][1] - wa[1], free[0][2] - wa[2]) > 0.05, "mouse: Alt+click places the point without snapping");
      await page.keyboard.press("Escape");
    }
    check(errors.length === 0, `${kind}: no page errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All snapping checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
