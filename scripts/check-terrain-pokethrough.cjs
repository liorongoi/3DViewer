// WP 1.6 acceptance: no terrain poke-through on 3 test sites.
//
// Opens three models in the real viewer on the offline demo terrain and checks that the
// terrain never shows through them:
//   1. Lyon 1st district, a textured city (3D Tiles mesh, fitted by its streets)
//   2. Tarn gorges, a lidar point cloud on steep ground (3D Tiles points, fitted by its surface)
//   3. A chess set 20 m across placed on a hillside in Jerusalem (a GLB on a slope)
//
// Each site is looked at from straight above, from a low angle and from close by. In each view:
//   - Heights. On a grid over the model, the model's top surface as drawn (globe hidden)
//     against the terrain as drawn (model hidden). Terrain above the surface is terrain showing
//     through it. Fails at any point more than 5 cm above.
//   - Pixels. The globe is painted magenta with no imagery; magenta pixels inside the model's
//     outline (found by drawing the model alone) are terrain in front of the model. From
//     straight above that is terrain over the model: fails over 1%. From an angle it also
//     counts the ground in front of the foot of a wall, which is right, so those views are
//     reported, not judged. The screenshots are saved.
// NO_CUT=1 runs the same with the viewer's ground cut switched off, for comparison.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-terrain-pokethrough.cjs <out folder>
// SITES=pt-lyon,pt-tarn,pt-chess picks sites (all by default).
// VIEWS=above,low,close picks views; POKE_DEBUG=1 logs every point where terrain is above the
// model, with what the viewer's ground capture holds there, and saves the capture.
// Set CHROMIUM to a Chromium binary if Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SITES = [
  {
    name: "Lyon 1st district (city mesh)",
    summary: { id: "pt-lyon", name: "Lyon", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "3dtiles", centre: { lat: 45.77, lon: 4.8261 }, source: { kind: "3dtiles", url: "samples/3dtiles/lyon1/tileset.json", groundFit: "street" } },
  },
  {
    name: "Tarn gorges (lidar points)",
    summary: { id: "pt-tarn", name: "Tarn", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "3dtiles", centre: { lat: 44.3336, lon: 3.3825 }, source: { kind: "3dtiles", url: "samples/3dtiles/tarn-lidar/tileset.json", groundFit: "surface" } },
    // 486 MB of points: drawn coarser, in a smaller window and sampled on a smaller grid, or
    // software rendering takes hours.
    light: true,
  },
  {
    name: "Chess set on a Jerusalem hillside (GLB)",
    summary: { id: "pt-chess", name: "Chess", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "glb", centre: { lat: 31.7745, lon: 35.2405 }, source: { kind: "glb", url: "samples/khronos/ABeautifulGame.glb" }, placement: { lat: 31.7745, lon: 35.2405, height: 0, aboveGround: 0, scale: 40 } },
  },
];

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node scripts/check-terrain-pokethrough.cjs <out folder>");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const T0 = Date.now();
  page.on("console", (m) => m.text().startsWith("[poke]") && console.log(`  ${process.env.POKE_DEBUG ? `[${((Date.now() - T0) / 1000).toFixed(0)} s] ` : ""}${m.text().slice(7)}`));
  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  if (process.env.POKE_DEBUG) await page.evaluate(() => (window.POKE_DEBUG = true));
  if (process.env.POKE_DEBUG)
    await page.evaluate(() => {
      const e = window.viewerEngine;
      const orig = e.setCut.bind(e);
      e.setCut = (u, off) => {
        let n = 0;
        for (const v of u.dist) if (Number.isFinite(v)) n++;
        console.log(`[poke] debug new cut: ${n} px, from ${new Error().stack.split("\n")[2].trim().replace(/\(.*\)/, "")}`);
        return orig(u, off);
      };
    });
  if (process.env.VIEWS) await page.evaluate((v) => (window.POKE_VIEWS = v.split(",")), process.env.VIEWS);
  await page.evaluate(async () => {
    const e = window.viewerEngine;
    // Rendered by hand, on a timer: Playwright stalls while software rendering runs flat out,
    // and height sampling only finishes on rendered frames.
    e.widget.useDefaultRenderLoop = false;
    setInterval(() => e.widget.render(), 100);
    await e.setTerrain("local");
  });

  let failed = 0;
  const only = process.env.SITES ? process.env.SITES.split(",") : null;
  for (const site of SITES.filter((s) => !only || only.includes(s.summary.id))) {
    await page.setViewportSize(site.light ? { width: 640, height: 448 } : { width: 1000, height: 700 });
    const r = await page.evaluate(async ([summary, noCut, light]) => {
      const e = window.viewerEngine;
      const w = e.widget;
      const scene = w.scene;
      // For a before/after comparison: the viewer without its ground cut.
      if (noCut) {
        e.updateGroundCut = async () => {};
        e.scheduleGroundCutRefine = () => {};
      }
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Waits for the terrain and the model's tiles. Software rendering of the large point cloud
      // is so slow that the terrain would take an age to load beside it, so the terrain loads
      // with the model hidden, then the model's tiles (for at most 90 s: what has loaded by then
      // is what gets checked), then the terrain again in case the cut reloaded it.
      const settle = async (min = 10) => {
        const t0 = Date.now();
        const prim = e.tileset ?? e.model;
        const until = async (done, ms, n) => {
          const s0 = Date.now();
          for (let i = 0; i < 1200 && Date.now() - s0 < ms; i++) {
            w.render();
            if (i > n && done()) return;
            await wait(50);
          }
        };
        const globeIn = async () => {
          if (!prim || !scene.globe.show) return;
          prim.show = false;
          await until(() => scene.globe.tilesLoaded, 300000, 2);
          prim.show = true;
        };
        await globeIn();
        await until(() => scene.globe.tilesLoaded && (!e.tileset || e.tileset.tilesLoaded), 90000, min);
        await globeIn();
        if (window.POKE_DEBUG) console.log(`[poke] debug settled in ${((Date.now() - t0) / 1000).toFixed(0)} s, terrain loaded: ${scene.globe.tilesLoaded}`);
      };
      console.log("[poke] opening");
      await e.open(summary, { fly: false });
      if (light && e.tileset) e.tileset.maximumScreenSpaceError = 48;
      await settle();
      // The fit and the cut run after the model is added; wait for them.
      await wait(1500);
      await e.placeOnGround();
      await settle();

      const C = scene.globe.baseColor.constructor;
      const Carto = scene.globe.ellipsoid.cartesianToCartographic(scene.camera.position).constructor;
      const HPR = e.widget.camera.constructor.DEFAULT_OFFSET.constructor;
      const prim = e.tileset ?? e.model;
      const bs = prim.boundingSphere;
      const c = Carto.fromCartesian(bs.center);
      // A 25 × 25 grid (13 × 13 for a light site) over the model's footprint, within 60% of its radius.
      const R = bs.radius * 0.6, N = light ? 13 : 25;
      const dLat = R / 6371000, dLon = dLat / Math.cos(c.latitude);
      const pts = [];
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) pts.push(new Carto(c.longitude + dLon * ((2 * i) / (N - 1) - 1), c.latitude + dLat * ((2 * j) / (N - 1) - 1)));

      // Magenta globe, no imagery, black sky: terrain is the only magenta in the frame.
      const layersShown = [];
      for (let i = 0; i < scene.imageryLayers.length; i++) (layersShown.push(scene.imageryLayers.get(i).show), (scene.imageryLayers.get(i).show = false));
      const saved = [scene.globe.baseColor, scene.backgroundColor, scene.skyBox?.show, scene.skyAtmosphere?.show, scene.globe.showGroundAtmosphere, scene.fog.enabled];
      scene.globe.baseColor = new C(1, 0, 1, 1);
      scene.backgroundColor = new C(0, 0, 0, 1);
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.globe.showGroundAtmosphere = false;
      scene.fog.enabled = false;

      const grab = () => {
        w.render();
        const cv = scene.canvas;
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.canvas.width = cv.width;
        ctx.canvas.height = cv.height;
        ctx.drawImage(cv, 0, 0);
        return { data: ctx.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height, url: cv.toDataURL("image/png") };
      };
      const views = {};
      const look = async (name, pitchDeg, range) => {
        console.log(`[poke] view from ${name}`);
        scene.camera.lookAt(bs.center, new HPR(0.6, (pitchDeg * Math.PI) / 180, range));
        await settle(20);
        // Tiles for this view are in; give the viewer time to refine the cut and reload the terrain.
        await wait(3000);
        await settle(20);

        // Heights, from the tiles this view draws: the model's top surface (globe hidden)
        // against the terrain as drawn (model hidden).
        scene.globe.show = false;
        w.render();
        if (window.POKE_DEBUG) console.log("[poke] debug sampling heights");
        // Points are a few metres apart, so a point cloud is sampled 2 m wide or most samples miss.
        const surf = pts.map((p) => scene.sampleHeight(p, e.widget.entities.values, light ? 2 : undefined));
        if (window.POKE_DEBUG) console.log("[poke] debug sampled");
        scene.globe.show = true;
        prim.show = false;
        w.render();
        const ground = pts.map((p) => scene.globe.getHeight(p));
        prim.show = true;
        const excess = [];
        surf.forEach((s, k) => {
          const g = ground[k];
          if (s !== undefined && g !== undefined && Math.abs(s - g) < 500) excess.push(g - s);
        });
        excess.sort((a, b) => a - b);
        if (window.POKE_DEBUG && e.cut) {
          const u = e.cut.u, C3 = u.camPos.constructor;
          {
            const cv = document.createElement("canvas"); cv.width = u.width; cv.height = u.height;
            const cx = cv.getContext("2d"), id = cx.createImageData(u.width, u.height);
            let n = 0;
            u.dist.forEach((v, i) => id.data.set(Number.isFinite(v) ? (n++, [255, 255, 255, 255]) : [0, 0, 0, 255], i * 4));
            cx.putImageData(id, 0, 0);
            window.POKE_CAPTURE = cv.toDataURL();
            console.log(`[poke] debug capture ${u.width}x${u.height} ${n} px, mpp ${u.mpp.toFixed(2)}`);
          }
          pts.forEach((p, k) => {
            const sh = surf[k], g = ground[k];
            if (!(sh !== undefined && g !== undefined && g - sh > 0.05 && g - sh < 500)) return;
            const q = C3.fromRadians(p.longitude, p.latitude, u.camHeight);
            C3.subtract(q, u.camPos, q);
            const px = Math.floor(C3.dot(q, u.right) / u.mpp + u.width / 2), py = Math.floor(u.height / 2 - C3.dot(q, u.up) / u.mpp);
            let fin = 0, lo = Infinity;
            for (let yy = py - 2; yy <= py + 2; yy++) for (let xx = px - 2; xx <= px + 2; xx++) { const v = u.dist[yy * u.width + xx]; if (Number.isFinite(v)) (fin++, (lo = Math.min(lo, v))); }
            const cutH = u.camHeight + lo + (e.groundOffset.get() - e.cut.offset);
            console.log(`[poke] debug ${name}: ${(p.longitude * 180 / Math.PI).toFixed(6)},${(p.latitude * 180 / Math.PI).toFixed(6)} surface ${sh.toFixed(1)} terrain ${g.toFixed(1)} capture px ${px},${py} (${fin} of 25 there) lowest there ${cutH.toFixed(1)}`);
          });
        }

        // Pixels: the model's own pixels come from drawing it alone. Only pixels with model
        // for 2 px all round count, so the antialiased edges of small buildings do not.
        // The terrain was hidden while the heights were sampled; let it load again first.
        await settle(5);
        const full = grab();
        scene.globe.show = false;
        await settle(5);
        const alone = grab();
        scene.globe.show = true;
        await settle(5);
        const W = full.w, H = full.h;
        const isModel = (x, y) => { const p = (y * W + x) * 4; return alone.data[p] + alone.data[p + 1] + alone.data[p + 2] > 24; };
        let modelPx = 0, through = 0, terrainPx = 0;
        const inside = (x, y) => {
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!isModel(x + dx, y + dy)) return false;
          return true;
        };
        for (let y = 2; y < H - 2; y++)
          for (let x = 2; x < W - 2; x++) {
            if (!inside(x, y)) {
              const p = (y * W + x) * 4;
              if (full.data[p] > 200 && full.data[p + 1] < 60 && full.data[p + 2] > 200) terrainPx++;
              continue;
            }
            modelPx++;
            const p = (y * W + x) * 4;
            if (full.data[p] > 200 && full.data[p + 1] < 60 && full.data[p + 2] > 200) through++;
          }
        const q = (f) => excess[Math.min(excess.length - 1, Math.floor(f * excess.length))];
        views[name] = {
          modelPx, through, terrainPx, image: full.url, aloneImage: window.POKE_DEBUG ? alone.url : null,
          samples: excess.length, above: excess.filter((d) => d > 0.05).length, p95: q(0.95), max: excess[excess.length - 1],
        };
      };
      const VIEWS = { above: [-89.9, 2.6], low: [-12, 1.8], close: [-25, 0.5] };
      for (const [name, [pitch, k]] of Object.entries(VIEWS)) if (!window.POKE_VIEWS || window.POKE_VIEWS.includes(name)) await look(name, pitch, bs.radius * k);

      [scene.globe.baseColor, scene.backgroundColor] = saved;
      if (scene.skyBox) scene.skyBox.show = saved[2];
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = saved[3];
      scene.globe.showGroundAtmosphere = saved[4];
      scene.fog.enabled = saved[5];
      layersShown.forEach((s, i) => (scene.imageryLayers.get(i).show = s));
      return { offset: e.groundOffset.get(), cut: !!e.cut, views, capture: window.POKE_CAPTURE };
    }, [site.summary, !!process.env.NO_CUT, !!site.light]);

    console.log(`\n${site.name}`);
    console.log(`  height shift applied: ${r.offset.toFixed(1)} m; terrain lowered under the model: ${r.cut ? "yes" : "no"}`);
    if (r.capture) fs.writeFileSync(path.join(out, `${site.summary.id}-capture.png`), Buffer.from(r.capture.split(",")[1], "base64"));
    for (const [name, v] of Object.entries(r.views)) {
      const file = path.join(out, `${site.summary.id}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(v.image.split(",")[1], "base64"));
      if (v.aloneImage) fs.writeFileSync(file.replace(".png", "-alone.png"), Buffer.from(v.aloneImage.split(",")[1], "base64"));
      const pct = (100 * v.through) / Math.max(1, v.modelPx);
      console.log(`  from ${name}: terrain shows through ${v.through} of ${v.modelPx} model pixels (${pct.toFixed(2)}%); terrain above the model's surface at ${v.above} of ${v.samples} points${v.above ? ` (p95 ${v.p95.toFixed(2)} m, worst ${v.max.toFixed(2)} m)` : ""}  ${file}`);
      if (v.above > 0 || (name === "above" && pct > 1)) failed++;
      // No terrain anywhere in the frame means the check saw nothing, not that it passed.
      if (!v.terrainPx) (console.log(`  from ${name}: FAIL, the terrain was not drawn`), failed++);
    }
  }
  await browser.close();
  console.log(failed ? `\nFAIL: terrain shows through in ${failed} view(s)` : "\nPASS: no terrain shows through on any site");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
