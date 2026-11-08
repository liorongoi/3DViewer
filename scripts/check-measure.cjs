// WP 2.4 acceptance (MSR-01, MSR-02, MSR-06, NFR-07): measurements land on the model's own
// surface to 1 cm, also on a tileset whose coarse levels are drawn, and a model without a
// reliable scale is measured in model units.
//
// The test surface is made here: an 80 × 80 m hilly grid (200 × 200 quads, 80,000 triangles).
// The truth is that mesh itself: the height of the triangle under a point.
//   1. Tiled into levels by the server's own tiler, it is opened with only its coarsest level
//      drawn (a simplified surface). Points measured with the mouse must end on the full-detail
//      surface, within 1 cm, and at least one must have started off it, or the check proves
//      nothing.
//   2. The same grid as a GLB, placed at half scale and marked as having no reliable scale: the
//      panel warns and gives lengths in model units (metres ÷ 0.5); m and ft are not offered.
//   3. A path over three points on the GLB: its total is the sum of its segments, and its points
//      lie on the surface.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-measure.cjs
// Set CHROMIUM to a Chromium binary if needed.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "apps/web/dist/samples/_check-measure");
const GLB = path.join(OUT, "hills.glb");
const TILED = path.join(OUT, "tiled");
const N = 200;
const SIZE = 80;
const height = (x, z) => 3 * Math.sin(x / 6) * Math.cos(z / 8) + 1.5 * Math.sin((x + z) / 4);
const gx = (i) => -SIZE / 2 + (i / N) * SIZE;

function writeGlb(file) {
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  for (let j = 0, k = 0; j <= N; j++)
    for (let i = 0; i <= N; i++, k += 3) {
      pos[k] = gx(i);
      pos[k + 1] = height(gx(i), gx(j));
      pos[k + 2] = gx(j);
    }
  const idx = new Uint32Array(N * N * 6);
  for (let j = 0, k = 0; j < N; j++)
    for (let i = 0; i < N; i++, k += 6) {
      const a = j * (N + 1) + i;
      idx.set([a, a + N + 1, a + N + 2, a, a + N + 2, a + 1], k);
    }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k++) (min[k % 3] = Math.min(min[k % 3], pos[k])), (max[k % 3] = Math.max(max[k % 3], pos[k]));
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: "2.0", generator: "check-measure" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Hills", mesh: 0 }],
    meshes: [{ name: "Hills", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.55, 0.62, 0.45, 1], metallicFactor: 0, roughnessFactor: 0.95 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const chunk = (buf, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(buf.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, buf]);
  };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  fs.writeFileSync(file, Buffer.concat([header, chunk(jsonBuf, 0x4e4f534a), chunk(bin, 0x004e4942)]));
}

/** Height of the mesh (not the formula) at glTF x, z: the triangle under the point, as written. */
function meshHeight(x, z) {
  const fi = ((x + SIZE / 2) / SIZE) * N, fj = ((z + SIZE / 2) / SIZE) * N;
  const i = Math.min(N - 1, Math.max(0, Math.floor(fi))), j = Math.min(N - 1, Math.max(0, Math.floor(fj)));
  const u = fi - i, v = fj - j;
  const h = (a, b) => Math.fround(height(gx(a), gx(b)));
  // Triangles (a, a+N+1, a+N+2) and (a, a+N+2, a+1): split along the diagonal u = v.
  return v >= u ? h(i, j) + u * (h(i + 1, j + 1) - h(i, j + 1)) + v * (h(i, j + 1) - h(i, j)) : h(i, j) + u * (h(i + 1, j) - h(i, j)) + v * (h(i + 1, j + 1) - h(i + 1, j));
}

fs.mkdirSync(OUT, { recursive: true });
writeGlb(GLB);
if (!fs.existsSync(path.join(TILED, "tileset.json"))) {
  const tiler = path.join(ROOT, "apps/server/src/tiler.ts");
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { tileModel } from ${JSON.stringify(tiler)}; await tileModel(${JSON.stringify(GLB)}, ${JSON.stringify(TILED)}, { leafTriangles: 4000 });`], { stdio: "inherit", cwd: path.join(ROOT, "apps/server") });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };

  // Opens the hills in the app, as tiles or as a GLB, with the given placement extras.
  const open = async (kind, extra) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
    await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    await page.evaluate(
      async ({ kind, extra }) => {
        const e = window.viewerEngine;
        const s = e.current.get();
        // 30 m above the terrain: the points must land on the model, not on the ground around it.
        const placement = { lat: s.centre.lat, lon: s.centre.lon, height: 0, aboveGround: 30, headingDeg: 0, scale: 1, upAxis: "y", ...extra };
        const source = kind === "tiles" ? { kind: "3dtiles", url: "samples/_check-measure/tiled/tileset.json", localFrame: true } : { kind: "glb", url: "samples/_check-measure/hills.glb" };
        await e.open({ ...s, id: `check-measure-${kind}`, name: "Hills", placement, source }, { fly: false });
        e.widget.scene.shadowMap.enabled = false;
        e.shadowsWanted = false;
        e.widget.useDefaultRenderLoop = false;
        window.__renderTimer = setInterval(() => e.widget.render(), 100);
      },
      { kind, extra },
    );
    return { ctx, page, errors };
  };

  // Looks down at the hills from 90 m and returns where the given mesh points (glTF x, z) are on
  // screen, so each click is aimed at the model whatever the camera did meanwhile.
  const look = (page, points) =>
    page.evaluate(
      async ({ points, heights }) => {
        const e = window.viewerEngine;
        const scene = e.widget.scene;
        const cam = scene.camera;
        const target = e.tileset ?? e.model;
        const C3 = cam.position.constructor;
        const M = target.modelMatrix;
        const scale = e.current.get().placement?.scale ?? 1;
        // glTF (x, y, z) is the local frame's (x, -z, y), z-up, before the scale.
        const world = ([x, z], i) => M.constructor.multiplyByPoint(M, new C3(x * scale, -z * scale, heights[i] * scale), new C3());
        const centre = M.constructor.multiplyByPoint(M, new C3(0, 0, 0), new C3());
        cam.lookAt(centre, { heading: 0.4, pitch: -1.0, range: 90 * scale });
        cam.lookAtTransform(cam.transform.constructor.IDENTITY);
        // Drawn and settled: for a tileset, loaded through a second of frames in a row.
        for (let i = 0, n = 0; i < 600 && n < 5; i++) {
          e.widget.render();
          await new Promise((r) => setTimeout(r, 200));
          n = !e.tileset || e.tileset.tilesLoaded ? n + 1 : 0;
        }
        return points.map((p, i) => {
          const s = scene.cartesianToCanvasCoordinates(world(p, i));
          return [s.x, s.y];
        });
      },
      { points, heights: points.map(([x, z]) => meshHeight(x, z)) },
    );

  // Each point's distance above (+) or below the mesh, along the local vertical, in metres.
  const offMesh = (page, pts) =>
    page.evaluate((pts) => {
      const e = window.viewerEngine;
      const target = e.tileset ?? e.model;
      const M = target.modelMatrix;
      const Mat = M.constructor;
      const inv = Mat.inverse(M, new Mat());
      const scale = e.current.get().placement?.scale ?? 1;
      return pts.map(([x, y, z]) => {
        const l = Mat.multiplyByPoint(inv, new (e.widget.scene.camera.position.constructor)(x, y, z), new (e.widget.scene.camera.position.constructor)());
        // Local frame is z-up; glTF is y-up: glTF (x, y, z) is local (x, -z, y), before the scale.
        return [l.x / scale, l.z / scale, -l.y / scale];
      });
    }, pts).then((locals) => locals.map(([x, y, z]) => ({ local: [x, y, z], off: y - meshHeight(x, z) })));

  // key: "m" for a distance, "Shift+M" for a path.
  const measureWithMouse = async (page, spots, key) => {
    await page.keyboard.press(key);
    const box = await page.locator("canvas").first().boundingBox();
    for (const [x, y] of spots) {
      await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
      await page.waitForTimeout(300);
      await page.mouse.click(box.x + x, box.y + y);
      await page.waitForTimeout(300);
    }
  };

  // ---- 1. A tileset drawn at its coarsest level ----
  {
    const { ctx, page, errors } = await open("tiles", {});
    await page.waitForFunction(() => window.viewerEngine.tileset?.tilesLoaded, null, { timeout: 180000 });
    const levels = await page.evaluate(() => {
      const t = window.viewerEngine.tileset;
      let depth = 0;
      const walk = (tile, d) => ((depth = Math.max(depth, d)), tile.children.forEach((c) => walk(c, d + 1)));
      walk(t.root, 1);
      // Only the root drawn: an error its children are not needed for. (Not much more: past the
      // tileset's own error Cesium draws nothing at all.)
      t.maximumScreenSpaceError = 50;
      return depth;
    });
    check(levels >= 2, "tiles: the test tileset has levels", `${levels} levels`);
    const spots = await look(page, [[-12.3, 7.9], [9.7, -5.1]]);
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => window.viewerEngine.tileset._selectedTiles.length === 1 && window.viewerEngine.tileset.tilesLoaded)) break;
      await page.waitForTimeout(300);
    }
    // Record each point as first placed, before it is refined.
    await page.evaluate(() => {
      const m = window.viewerEngine.measure;
      window.__placed = [];
      const add = m.addPoint.bind(m);
      m.addPoint = (p) => (window.__placed.push([p.x, p.y, p.z]), add(p));
    });
    await measureWithMouse(page, spots, "m");
    const placed = await page.evaluate(() => window.__placed);
    // The full-detail tiles load in the background; the points then move onto them.
    let final = [];
    for (let i = 0; i < 120; i++) {
      final = await page.evaluate(() => window.viewerEngine.measure.measurements.get()[0]?.points.map((p) => [p.x, p.y, p.z]) ?? []);
      if (final.length === 2 && final.every((p, k) => Math.hypot(p[0] - placed[k][0], p[1] - placed[k][1], p[2] - placed[k][2]) > 1e-4)) break;
      await page.waitForTimeout(500);
    }
    const before = await offMesh(page, placed);
    const after = final.length === 2 ? await offMesh(page, final) : [];
    const cm = (v) => `${(v * 100).toFixed(1)} cm`;
    check(placed.length === 2 && before.some((b) => Math.abs(b.off) > 0.02), "tiles: a point placed on the coarse level is off the full-detail surface (the check has teeth)", before.map((b) => cm(b.off)).join(", "));
    check(after.length === 2 && after.every((a) => Math.abs(a.off) <= 0.01), "tiles: measured points end on the full-detail surface within 1 cm", after.map((a) => cm(a.off)).join(", ") || "no measurement");
    const res = await page.evaluate(() => {
      const m = window.viewerEngine.measure.measurements.get()[0];
      const [a, b] = m.points;
      return { total: m.result.total3d, straight: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) };
    });
    check(Math.abs(res.total - res.straight) < 1e-9, "tiles: the distance is worked out again from the moved points", `${res.total.toFixed(4)} m`);
    check(errors.length === 0, "tiles: no page errors", errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ---- 2 and 3. A GLB of unknown units, at half scale ----
  {
    const { ctx, page, errors } = await open("glb", { scale: 0.5, modelUnit: 0.5 });
    const spots = await look(page, [[-15.2, 3.3], [14.1, 1.7]]);
    await measureWithMouse(page, spots, "m");
    await page.keyboard.press("Escape");
    const chip = page.getByTestId("model-units");
    check(await chip.isVisible().catch(() => false), "model units: the measure panel warns that the model has no reliable scale");
    check(!(await page.getByRole("radio", { name: "Feet" }).isVisible().catch(() => false)) && !(await page.getByRole("button", { name: "Feet" }).isVisible().catch(() => false)), "model units: m and ft are not offered");
    const m = await page.evaluate(() => window.viewerEngine.measure.measurements.get()[0]?.result.total3d);
    const want = m !== undefined ? `${(m / 0.5).toLocaleString("en", { minimumFractionDigits: m / 0.5 < 10 ? 3 : 2, maximumFractionDigits: m / 0.5 < 10 ? 3 : 2 })} model units` : "?";
    const card = page.locator("article").filter({ hasText: want }).first();
    check(m !== undefined && (await card.isVisible().catch(() => false)), "model units: the card gives the length in model units (metres ÷ 0.5)", want);
    const label = await page.evaluate(() => window.viewerEngine.measure.format(window.viewerEngine.measure.measurements.get()[0].result.total3d));
    check(label === want, "model units: the label in the view says the same", label);

    // A path over three points.
    const pathSpots = await look(page, [[-20.4, -10.6], [0.3, 12.2], [18.8, -4.4]]);
    await page.keyboard.press("Escape");
    await measureWithMouse(page, pathSpots, "Shift+M");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => {
      const m = window.viewerEngine.measure.measurements.get().find((x) => x.kind === "path");
      return m && { points: m.points.map((q) => [q.x, q.y, q.z]), total: m.result.total3d, segs: m.result.segments.map((s) => s.distance3d) };
    });
    check(!!p && p.points.length === 3, "path: three clicks and Enter make a path of three points", p ? `${p.points.length} points` : "no path");
    if (p) {
      const sum = p.segs.reduce((s, x) => s + x, 0);
      const legs = p.points.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p.points[i][0], q[1] - p.points[i][1], q[2] - p.points[i][2]), 0);
      check(Math.abs(p.total - sum) < 1e-9 && Math.abs(p.total - legs) < 1e-6, "path: the total is the sum of its segments", `${p.total.toFixed(4)} m`);
      const off = await offMesh(page, p.points);
      // At half scale, 1 cm in the world is 2 cm of the file.
      check(off.every((o) => Math.abs(o.off) * 0.5 <= 0.01), "path: its points lie on the surface within 1 cm", off.map((o) => `${(o.off * 50).toFixed(1)} cm`).join(", "));
    }
    check(errors.length === 0, "GLB: no page errors", errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All measurement checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
