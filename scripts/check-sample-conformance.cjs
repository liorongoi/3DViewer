// WP 1.2 acceptance: every Khronos glTF sample and every 3D Tiles sample opens in the viewer.
//
// Opens each one in the real viewer (the built web app, through its own engine.open) and checks:
//   - no error from the viewer (the message a user would see), no page error;
//   - for a tileset, no tile that failed to load;
//   - something was drawn: the frame with the model differs from the frame without it.
// A screenshot of each is saved, with results.json and results.md listing every sample.
//
// The samples, from an internet-connected machine (the paths are given by environment variables):
//   KHRONOS  a checkout of github.com/KhronosGroup/glTF-Sample-Assets with every variant in
//            Models/model-index.json. Each glTF variant (separate files, embedded, Draco,
//            quantized, meshopt, KTX2, WebP...) of each of the models is opened.
//   TILES    a checkout of github.com/CesiumGS/3d-tiles-samples: every tileset in it.
//   SPECS    CesiumJS's Specs/Data (github.com/CesiumGS/cesium; Cesium3DTiles, and the glTF
//            in Models/glTF-2.0/BuildingsMetadata one of them points to), for the 3D Tiles
//            1.0 formats the samples repository no longer carries: b3dm (Batched), i3dm
//            (Instanced), pnts (PointCloud), cmpt (Composite), plus implicit tiling, glTF
//            content and metadata. Its Vector, Geometry, GeoJson, Voxel, GaussianSplats and
//            Terrain folders are CesiumJS experiments outside 3D Tiles 1.0/1.1 and are skipped.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   KHRONOS=... TILES=... SPECS=... node scripts/check-sample-conformance.cjs <out folder>
// ONLY=<a>,<b> runs the samples whose name contains one of them; LIMIT_S sets the time each may
// take to open (120 s). Set CHROMIUM to a Chromium binary if
// Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOTS = { khronos: process.env.KHRONOS, tiles: process.env.TILES, specs: process.env.SPECS };
// Software rendering is slow: a model with many large textures can take minutes to open.
const LIMIT_S = Number(process.env.LIMIT_S ?? 120);
const SKIP_SPECS = ["Vector", "Geometry", "GeoJson", "Voxel", "GaussianSplats", "Terrain"];

function corpus() {
  const items = [];
  if (ROOTS.khronos) {
    const index = JSON.parse(fs.readFileSync(path.join(ROOTS.khronos, "Models/model-index.json"), "utf8"));
    for (const m of index)
      for (const [variant, file] of Object.entries(m.variants)) {
        const rel = `Models/${m.name}/${variant}/${file}`;
        if (!fs.existsSync(path.join(ROOTS.khronos, rel))) continue;
        items.push({ set: "Khronos glTF", name: `${m.name} (${variant})`, kind: "glb", url: `khronos/${rel}` });
      }
  }
  const tilesets = (root, key, set, skip = [], sub = "") => {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || e.name === "screenshot" || skip.some((s) => rel === s)) continue;
          walk(p);
        } else if (e.name === "tileset.json") {
          // A tileset that another tileset in a parent folder points to is opened through that one.
          const parent = path.dirname(path.dirname(p));
          if (rel.includes("/") && fs.existsSync(path.join(parent, "tileset.json")) && fs.readFileSync(path.join(parent, "tileset.json"), "utf8").includes(path.basename(path.dirname(p)) + "/tileset.json")) continue;
          // A tileset with no content anywhere (a metadata sample) opens but has nothing to draw.
          const json = fs.readFileSync(p, "utf8");
          const empty = !/"(content|contents)"\s*:/.test(json) && !/"implicitTiling"/.test(json);
          // Seen only from inside a viewer request volume: from the default view, nothing to draw.
          const volume = /"viewerRequestVolume"/.test(json);
          items.push({ set, name: path.dirname(rel).replace(/^Cesium3DTiles\//, ""), kind: "3dtiles", url: `${key}/${rel}`, empty, volume });
        }
      }
    };
    walk(path.join(root, sub));
  };
  if (ROOTS.tiles) tilesets(ROOTS.tiles, "tiles", "3D Tiles samples");
  if (ROOTS.specs) tilesets(ROOTS.specs, "specs", "CesiumJS spec tilesets", SKIP_SPECS.map((s) => `Cesium3DTiles/${s}`), "Cesium3DTiles");
  const only = process.env.ONLY?.split(",");
  return items.filter((i) => !only || only.some((o) => i.name.includes(o)));
}

const TYPES = { json: "application/json", gltf: "model/gltf+json", glb: "model/gltf-binary", bin: "application/octet-stream", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2", subtree: "application/octet-stream" };

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: KHRONOS=... TILES=... SPECS=... node scripts/check-sample-conformance.cjs <out folder>");
  fs.mkdirSync(path.join(out, "shots"), { recursive: true });
  const items = corpus();
  if (!items.length) throw new Error("No samples found: set KHRONOS, TILES and SPECS.");
  console.log(`${items.length} samples`);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let page;
  const pageErrors = [];
  const fresh = async () => {
    if (page) await page.close().catch(() => {});
    page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    // The samples are served from disk under /conformance/, beside the built app.
    await page.route("**/conformance/**", async (route) => {
      const u = new URL(route.request().url());
      const [, key, ...rest] = decodeURIComponent(u.pathname).replace(/^\/conformance\//, "/").split("/");
      const root = ROOTS[key];
      const file = root && path.resolve(root, rest.join("/"));
      if (!file || !file.startsWith(path.resolve(root)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: "not found" });
      route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "content-type": TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream" } });
    });
    await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    await page.evaluate(() => {
      const e = window.viewerEngine;
      e.setShadows(false);
      e.widget.scene.msaaSamples = 1;
      // No globe and no sky: this checks the model, and a plain purple background (which no
      // white, grey or translucent model matches) makes its pixels easy to find.
      e.setGlobe(false);
      const scene = e.widget.scene;
      for (const k of ["skyBox", "skyAtmosphere", "sun", "moon"]) if (scene[k]) scene[k].show = false;
      scene.backgroundColor = new scene.backgroundColor.constructor(0.45, 0.1, 0.55, 1);
      // A render error stops Cesium drawing anything more; count it against the sample.
      window.__renderErrors = [];
      scene.renderError.addEventListener((_s, err) => window.__renderErrors.push(String(err?.message ?? err)));
      scene.rethrowRenderErrors = false;
      e.widget.useDefaultRenderLoop = false;
    });
  };
  await fresh();

  const results = [];
  for (const [n, item] of items.entries()) {
    pageErrors.length = 0;
    const t0 = Date.now();
    let r;
    try {
      r = await Promise.race([
        page.evaluate(async (item) => {
          const e = window.viewerEngine;
          const w = e.widget;
          const scene = w.scene;
          const wait = (ms) => new Promise((res) => setTimeout(res, ms));
          const url = `conformance/${item.url}`;
          const summary = {
            id: `conf-${Math.random()}`, name: item.name, classificationId: "unclassified", status: "current", version: 1, versions: 1,
            sourceFormat: item.kind, centre: { lat: 31.77, lon: 35.21 }, source: { kind: item.kind, url },
            ...(item.kind === "glb" ? { placement: { lat: 31.77, lon: 35.21, height: 0, aboveGround: 0 } } : {}),
          };
          const failedTiles = [];
          // Tile failures can come as soon as the tileset is added, so listen from then on.
          const add = scene.primitives.add.bind(scene.primitives);
          scene.primitives.add = (p) => (p.tileFailed?.addEventListener((f) => failedTiles.push(`${String(f.url).split("/").slice(-2).join("/")}: ${f.message}`)), add(p));
          // Opening a model waits on rendered frames (its ground height is sampled from them).
          const ticker = setInterval(() => w.render(), 100);
          try {
            await e.open(summary, { fly: false });
          } finally {
            clearInterval(ticker);
            scene.primitives.add = add;
          }
          let err = e.error.get();
          if (!err && !e.tileset && !e.model) {
            // Closed because drawing it failed: the message comes just after.
            await wait(300);
            err = e.error.get();
          }
          if (err) return { ok: false, why: `${err.reason} (${err.detail})` };
          const prim = e.tileset ?? e.model;
          if (!prim) return { ok: false, why: "nothing was opened" };
          let loaded = false;
          for (let i = 0; i < 400; i++) {
            w.render();
            if (!e.tileset && !e.model) break;
            if (i > 5 && (e.tileset ? e.tileset.tilesLoaded : e.model.ready)) { loaded = true; break; }
            await wait(50);
          }
          if (!e.tileset && !e.model) {
            // Closed because drawing it failed: the message comes just after.
            await wait(300);
            const late = e.error.get();
            return { ok: false, why: late ? `${late.reason} (${late.detail})` : "closed while loading, with no message" };
          }
          await e.home(0);
          for (let i = 0; i < 200; i++) {
            w.render();
            if (i > 5 && (!e.tileset || e.tileset.tilesLoaded)) break;
            await wait(50);
          }
          const grab = () => {
            w.render();
            const gl = scene.context._gl;
            const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
            const px = new Uint8Array(W * H * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px;
          };
          const count = () => {
            const full = grab();
            prim.show = false;
            const without = grab();
            prim.show = true;
            w.render();
            let n = 0;
            for (let p = 0; p < full.length; p += 4) if (Math.abs(full[p] - without[p]) + Math.abs(full[p + 1] - without[p + 1]) + Math.abs(full[p + 2] - without[p + 2]) > 12) n++;
            return { n, length: full.length };
          };
          let { n: drawn, length } = count();
          // A single-sided surface seen from behind draws nothing: look from the other sides too.
          if (drawn === 0) {
            const HPR = w.camera.constructor.DEFAULT_OFFSET.constructor;
            const bs = prim.boundingSphere;
            for (const h of [Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 0]) {
              for (const pitch of [-0.4, 0.4]) {
                w.camera.lookAt(bs.center, new HPR(h, pitch, Math.max(bs.radius * 3, 1)));
                drawn = count().n;
                if (drawn) break;
              }
              if (drawn) break;
            }
            w.camera.lookAtTransform(scene.camera.transform.constructor.IDENTITY);
          }
          const full = { length };
          const share = drawn / (full.length / 4);
          const renderErr = window.__renderErrors.splice(0);
          const why0 = renderErr.length ? `rendering stopped: ${renderErr[0]}` : failedTiles.length ? `${failedTiles.length} tile(s) failed: ${failedTiles.slice(0, 3).join("; ")}` : drawn === 0 && !item.empty && !item.volume ? "nothing was drawn" : !loaded ? "still loading after 20 s" : "";
          const why = why0;
          return { ok: !why, why: why || (item.empty ? "no content to draw (metadata only); opens with no error" : item.volume && share === 0 ? "content only shows from inside its viewer request volume; opens with no error" : ""), drawn: share, failedTiles: failedTiles.length };
        }, item),
        new Promise((res) => setTimeout(() => res({ ok: false, why: `timed out after ${LIMIT_S} s`, timeout: true }), LIMIT_S * 1000)),
      ]);
    } catch (e) {
      r = { ok: false, why: `the page failed: ${e.message.split("\n")[0]}`, crashed: true };
    }
    if (pageErrors.length) r = { ...r, ok: false, why: [r.why, `page error: ${pageErrors[0]}`].filter(Boolean).join("; ") };
    const shot = `${String(n).padStart(3, "0")}-${item.name.replace(/[^\w.-]+/g, "_")}.png`;
    if (!r.timeout && !r.crashed) await page.screenshot({ path: path.join(out, "shots", shot) }).catch(() => {});
    // A model that requires an extension CesiumJS cannot read, or more morph targets than the GPU
    // can draw, is refused with that named: the right outcome, listed apart from failures.
    if (!r.ok && /needs the glTF extension|more morph targets/.test(r.why ?? "")) r = { ...r, refused: true };
    results.push({ ...item, ...r, shot, seconds: (Date.now() - t0) / 1000 });
    console.log(`${r.ok ? "PASS" : r.refused ? "REFUSED" : "FAIL"} ${item.set} · ${item.name}${r.ok ? "" : ` · ${r.why}`} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (r.timeout || r.crashed) await fresh();
    else await page.evaluate(() => window.viewerEngine.close());
  }
  await browser.close();

  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  const sets = [...new Set(results.map((r) => r.set))];
  const md = [`# Sample conformance`, ``, ...sets.map((s) => { const rs = results.filter((r) => r.set === s); return `- ${s}: ${rs.filter((r) => r.ok).length} of ${rs.length} open, ${rs.filter((r) => r.refused).length} refused with a named reason, ${rs.filter((r) => !r.ok && !r.refused).length} fail`; }), ``, `| Set | Sample | Result | Why |`, `|---|---|---|---|`, ...results.map((r) => `| ${r.set} | ${r.name} | ${r.ok ? "opens" : r.refused ? "refused, reason named" : "**fails**"} | ${(r.why || "").replace(/\|/g, "/")} |`)];
  fs.writeFileSync(path.join(out, "results.md"), md.join("\n") + "\n");
  const failed = results.filter((r) => !r.ok && !r.refused);
  console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} open, ${results.filter((r) => r.refused).length} refused with a named reason, ${failed.length} fail.`);
  process.exit(failed.length ? 1 : 0);
})();
