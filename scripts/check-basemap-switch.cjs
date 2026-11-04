// WP 1.6 acceptance: the viewer works with the base map off, and online and internal sources
// switch without a restart.
//
// Opens a model in the real viewer, then, in the same page with no reload:
//   1. base map off, then the globe off as well: the model still draws, nothing fails;
//   2. the built-in online presets (Esri World Imagery and AWS Terrain Tiles);
//   3. internal sources set up by the site's administrator (an XYZ imagery server and a
//      Terrarium terrain server on this machine, as on the internal network);
//   4. back to the online presets, then back to the offline demo sources.
// After each switch it checks the imagery colour on screen, the terrain height under the model,
// that the model is still open and sits on the new ground, and how long the switch took.
//
// This sandbox has no internet, so the online presets' real addresses are answered by the
// test with tiles of a known colour and height: the viewer's code and URLs are the real ones.
// On a machine with internet, ONLINE=1 lets those requests through instead and only checks
// that tiles arrive.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-basemap-switch.cjs
// BM_DEBUG=1 logs each step as it starts and the frames while waiting for tiles.
const http = require("http");
const zlib = require("zlib");
const { chromium } = require("playwright");

/** A solid-colour 256 × 256 PNG. */
function solidPng([r, g, b]) {
  const size = 256;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** Terrarium encodes height as R × 256 + G + B / 256 − 32768. */
const terrarium = (h) => {
  const v = h + 32768;
  return solidPng([Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)]);
};

const ONLINE_COLOUR = [30, 60, 220]; // blue
const ONLINE_HEIGHT = 500;
const INTERNAL_COLOUR = [220, 40, 30]; // red
const INTERNAL_HEIGHT = 1200;

(async () => {
  // The internal map servers: imagery on one port, terrain on another.
  const served = { imagery: 0, terrain: 0 };
  const serve = (kind, png) =>
    new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        served[kind]++;
        res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
        res.end(png);
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
  const imagerySrv = await serve("imagery", solidPng(INTERNAL_COLOUR));
  const terrainSrv = await serve("terrain", terrarium(INTERNAL_HEIGHT));
  const cfg = {
    sources: [
      { id: "int-imagery", label: "Internal imagery", kind: "imagery", type: "xyz", url: `http://127.0.0.1:${imagerySrv.address().port}/{z}/{x}/{y}.png` },
      { id: "int-terrain", label: "Internal terrain", kind: "terrain", type: "terrarium", url: `http://127.0.0.1:${terrainSrv.address().port}/{z}/{x}/{y}.png`, maxZoom: 14 },
    ],
  };

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 448 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let loads = 0;
  page.on("load", () => loads++);
  const online = { imagery: 0, terrain: 0 };
  if (!process.env.ONLINE) {
    const blue = solidPng(ONLINE_COLOUR), aws = terrarium(ONLINE_HEIGHT);
    await page.route("https://server.arcgisonline.com/**", (r) => (online.imagery++, r.fulfill({ status: 200, contentType: "image/jpeg", headers: { "access-control-allow-origin": "*" }, body: blue })));
    await page.route("https://s3.amazonaws.com/elevation-tiles-prod/**", (r) => (online.terrain++, r.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: aws })));
  } else {
    page.on("requestfinished", (r) => {
      if (r.url().startsWith("https://server.arcgisonline.com/")) online.imagery++;
      if (r.url().startsWith("https://s3.amazonaws.com/elevation-tiles-prod/")) online.terrain++;
    });
  }
  await page.goto("http://localhost:4173/?render-only", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  if (process.env.BM_DEBUG) await page.evaluate(() => (window.BM_DEBUG = true));
  // Software rendering is slow, and after a terrain swap single frames took up to 10 s, with
  // the occasional stall of many minutes (GPU process busy, page waiting). Shadows and 4×
  // multisampling are not what this checks, so they are off to keep the GPU work small.
  await page.evaluate(() => {
    window.viewerEngine.setShadows(false);
    window.viewerEngine.widget.scene.msaaSamples = 1;
  });
  page.on("console", (m) => m.text().startsWith("[bm]") && console.log("  " + m.text()));

  // Drive the page's render loop by hand (Playwright stalls while software rendering runs flat out).
  await page.evaluate(async () => {
    const e = window.viewerEngine;
    e.widget.useDefaultRenderLoop = false;
    setInterval(() => e.widget.render(), 100);
    window.__settle = async () => {
      const scene = e.widget.scene;
      const t0 = performance.now();
      let tp = scene.terrainProvider, swaps = 0;
      for (let i = 0; i < 600; i++) {
        const f0 = performance.now();
        e.widget.render();
        if (window.BM_DEBUG) {
          scene.context._gl.finish();
          const ms = performance.now() - f0;
          if (ms > 1000) console.log(`[bm] frame ${i} took ${(ms / 1000).toFixed(1)} s`);
        }
        if (scene.terrainProvider !== tp) (swaps++, (tp = scene.terrainProvider));
        const m = e.model;
        if (i > 15 && (!scene.globe.show || scene.globe.tilesLoaded) && (!m || m.ready)) break;
        if (window.BM_DEBUG && i % 50 === 49) console.log(`[bm] frame ${i + 1}, ${((performance.now() - t0) / 1000).toFixed(0)} s, terrain loaded ${scene.globe.tilesLoaded}, terrain rebuilt ${swaps} times, cut ${!!e.cut}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // What is on screen: the colour beside the model, the ground height under it, and whether
    // the model still draws (its pixels differ from the frame with it hidden).
    window.__look = async () => {
      const scene = e.widget.scene;
      // The model moves with the ground when the terrain changes; look at it where it is now.
      const HPR = e.widget.camera.constructor.DEFAULT_OFFSET.constructor;
      const bs = e.model.boundingSphere;
      scene.camera.lookAt(bs.center, new HPR(0.4, -0.5, bs.radius * 4));
      await window.__settle();
      const grab = () => {
        e.widget.render();
        // Read the frame straight from WebGL (a 2D-canvas copy of it sometimes stalls for minutes
        // under software rendering). Rows come bottom first; flip them.
        const gl = scene.context._gl;
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const raw = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const out = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
        return out;
      };
      const full = grab();
      e.model.show = false;
      const without = grab();
      e.model.show = true;
      let modelPx = 0;
      for (let p = 0; p < full.length; p += 4) if (Math.abs(full[p] - without[p]) + Math.abs(full[p + 1] - without[p + 1]) + Math.abs(full[p + 2] - without[p + 2]) > 30) modelPx++;
      // Average colour of a band along the bottom of the frame, which is ground.
      const W = scene.canvas.width, H = scene.canvas.height;
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = H - 40; y < H - 10; y++)
        for (let x = 10; x < W - 10; x += 4) {
          const p = (y * W + x) * 4;
          sum[0] += without[p]; sum[1] += without[p + 1]; sum[2] += without[p + 2];
          n++;
        }
      const Carto = scene.globe.ellipsoid.cartesianToCartographic(scene.camera.position).constructor;
      const c = Carto.fromCartesian(e.model.boundingSphere.center);
      return {
        colour: sum.map((s) => Math.round(s / n)),
        ground: scene.globe.show ? scene.globe.getHeight(c) : null,
        modelBottom: e.model.boundingSphere ? c.height - e.model.boundingSphere.radius : null,
        modelPx,
        baseMap: e.baseMapId.get(),
        terrain: e.terrainId.get(),
        modelId: e.model?.__checkId,
      };
    };
  });

  // A model on the ground: the Khronos chess set, 20 m across.
  await page.evaluate(async () => {
    const e = window.viewerEngine;
    await e.open({ id: "bm-chess", name: "Chess", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "glb", centre: { lat: 31.7745, lon: 35.2405 }, source: { kind: "glb", url: "samples/khronos/ABeautifulGame.glb" }, placement: { lat: 31.7745, lon: 35.2405, height: 0, aboveGround: 0, scale: 40 } }, { fly: false });
    e.model.__checkId = "same-model";
    const HPR = e.widget.camera.constructor.DEFAULT_OFFSET.constructor;
    await window.__settle();
    const bs = e.model.boundingSphere;
    e.widget.scene.camera.lookAt(bs.center, new HPR(0.4, -0.5, bs.radius * 4));
  });

  const steps = [];
  const step = async (name, fn, expect) => {
    const t0 = Date.now();
    if (process.env.BM_DEBUG) console.log(`  ... ${name}`);
    const problems = await page.evaluate(fn, cfg);
    const took = Date.now() - t0;
    if (process.env.BM_DEBUG) console.log(`  ... switched in ${took} ms, looking`);
    const v = await page.evaluate(() => window.__look());
    const fails = [...(problems || [])];
    if (v.modelId !== "same-model") fails.push("the model was closed or reopened");
    if (v.modelPx < 500) fails.push(`the model is not drawn (${v.modelPx} px)`);
    fails.push(...expect(v));
    steps.push({ name, took, v, fails });
    console.log(`${fails.length ? "FAIL" : "ok  "} ${name} (${(took / 1000).toFixed(1)} s): ground colour ${v.colour.join(",")}, terrain ${v.ground === null ? "hidden" : `${v.ground?.toFixed(0)} m`}, model ${v.modelPx} px${fails.length ? `\n     ${fails.join("\n     ")}` : ""}`);
  };
  const near = (v, h, tol = 5) => (v.ground !== undefined && v.ground !== null && Math.abs(v.ground - h) <= tol ? [] : [`terrain should be ${h} m, is ${v.ground}`]);
  const onGround = (v) => (v.ground !== null && v.modelBottom !== null && Math.abs(v.modelBottom - v.ground) > 25 ? [`the model is not on the new ground (bottom ${v.modelBottom.toFixed(0)} m, ground ${v.ground.toFixed(0)} m)`] : []);
  // Lighting and atmosphere change the shade, so a colour is judged by its strongest channel:
  // that channel at least 1.5 times either of the others.
  const looksLike = (got, want) => {
    const k = want.indexOf(Math.max(...want));
    return got.every((c, i) => i === k || got[k] >= 1.5 * c);
  };
  const isColour = (want) => (v) => {
    if (process.env.ONLINE && want === ONLINE_COLOUR) return [];
    return looksLike(v.colour, want) ? [] : [`the ground should look like ${want.join(",")}, it is ${v.colour.join(",")}`];
  };
  const notColour = (want) => (v) => (looksLike(v.colour, want) ? [`the ground still shows ${want.join(",")}`] : []);

  await step("start: offline demo imagery and terrain", () => {}, () => []);
  await step("base map off", () => window.viewerEngine.setBaseImagery(false), (v) => [...notColour(ONLINE_COLOUR)(v), ...notColour(INTERNAL_COLOUR)(v)]);
  await step("globe off as well", () => window.viewerEngine.setGlobe(false), () => []);
  await step("globe and base map back", () => (window.viewerEngine.setGlobe(true), window.viewerEngine.setBaseImagery(true)), () => []);
  await step("online: Esri World Imagery", () => window.viewerEngine.setBaseMap("esri"), isColour(ONLINE_COLOUR));
  await step("online: AWS Terrain Tiles", () => window.viewerEngine.setTerrain("aws"), (v) => [...(process.env.ONLINE ? [] : near(v, ONLINE_HEIGHT)), ...onGround(v)]);
  await step("internal: the site's own imagery and terrain", (cfg) => window.viewerEngine.useSiteBaseMaps({ ...cfg, defaultImagery: "int-imagery", defaultTerrain: "int-terrain" }, "http://localhost:4173/"), (v) => [...isColour(INTERNAL_COLOUR)(v), ...near(v, INTERNAL_HEIGHT), ...onGround(v)]);
  await step("back to online imagery", () => window.viewerEngine.setBaseMap("esri"), isColour(ONLINE_COLOUR));
  await step("back to online terrain", () => window.viewerEngine.setTerrain("aws"), (v) => [...(process.env.ONLINE ? [] : near(v, ONLINE_HEIGHT)), ...onGround(v)]);
  await step("back to the offline demo sources", async () => (await window.viewerEngine.setBaseMap("local-s2"), await window.viewerEngine.setTerrain("local")), (v) => [...notColour(ONLINE_COLOUR)(v), ...notColour(INTERNAL_COLOUR)(v), ...onGround(v)]);

  console.log(`\nTiles fetched: online imagery ${online.imagery}, online terrain ${online.terrain}, internal imagery ${served.imagery}, internal terrain ${served.terrain}; page loads ${loads}`);
  const failed = steps.filter((s) => s.fails.length).length + errors.length + (loads > 1 ? 1 : 0);
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  if (loads > 1) console.log("FAIL: the page reloaded");
  if (!online.imagery || !online.terrain || !served.imagery || !served.terrain) console.log("FAIL: a source was never asked for tiles");
  const none = !online.imagery || !online.terrain || !served.imagery || !served.terrain;
  console.log(failed || none ? `\nFAIL` : `\nPASS: works with the base map and globe off; online and internal sources switch with no restart (slowest switch ${(Math.max(...steps.slice(1).map((s) => s.took)) / 1000).toFixed(1)} s)`);
  await browser.close();
  imagerySrv.close();
  terrainSrv.close();
  process.exit(failed || none ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
