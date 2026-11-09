// WP 1.2 acceptance, the viewer side of "corrupt files show a named reason without crash".
//
// In the real web app (English, then Hebrew):
//   1. A tileset with three tiles, two of them missing (404) and one damaged: the model stays
//      open, and a notice says how many tiles could not be loaded and names them.
//   2. A model that makes drawing fail: the viewer closes it with a message, and the globe keeps
//      drawing (before, Cesium stopped all drawing and showed its own error panel).
//   3. A good model opens after that, so nothing is left broken.
// Screenshots go to the out folder.
//
// Usage: build apps/web, start `vite preview` on :4173, then
//   node scripts/check-load-errors.cjs <out folder>
// Set CHROMIUM to a Chromium binary if Playwright's own is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

/** A GLB with one triangle, about 40 m across. */
function triangleGlb() {
  const pos = new Float32Array([0, 0, 0, 40, 0, 0, 0, 0, 40]);
  const bin = Buffer.from(pos.buffer);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [40, 0, 40] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  return Buffer.concat([head, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}

// Jerusalem, 300 m by 300 m, four tiles: one good, two missing, one damaged.
const r = (d) => (d * Math.PI) / 180;
const region = [r(35.21), r(31.77), r(35.2132), r(31.7727), 0, 50];
const tileset = {
  asset: { version: "1.1" },
  geometricError: 200,
  root: {
    boundingVolume: { region },
    geometricError: 100,
    refine: "ADD",
    children: ["good.glb", "missing-a.glb", "missing-b.glb", "damaged.glb"].map((uri) => ({ boundingVolume: { region }, geometricError: 0, content: { uri: `tiles/${uri}` } })),
  },
};
const FILES = {
  "tileset.json": Buffer.from(JSON.stringify(tileset)),
  "tiles/good.glb": triangleGlb(),
  "tiles/damaged.glb": Buffer.from("glTF this is not a model"),
};

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node scripts/check-load-errors.cjs <out folder>");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = 0;
  const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failed++;
  };

  for (const lang of ["en", "he"]) {
    console.log(`· ${lang}`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((l) => localStorage.setItem("viewer.lang", l), lang);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.route("**/load-errors/**", (route) => {
      const name = new URL(route.request().url()).pathname.replace(/^.*\/load-errors\//, "");
      const body = FILES[name];
      route.fulfill(body ? { status: 200, body } : { status: 404, body: "not found" });
    });
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });

    // 1. Missing and damaged tiles.
    await page.evaluate(async () => {
      const e = window.viewerEngine;
      await e.open({ id: "load-errors", name: "Load errors", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "3dtiles", centre: { lat: 31.771, lon: 35.212 }, source: { kind: "3dtiles", url: "load-errors/tileset.json" } });
    });
    const notice = page.locator('[role="status"]:not(.sr-only)');
    await notice.waitFor({ timeout: 120000 });
    await page.waitForFunction(() => window.viewerEngine.tileProblems.get()?.count === 3, null, { timeout: 60000 }).catch(() => {});
    await notice.locator("summary").click();
    const text = (await notice.innerText()).replace(/[\u2066-\u2069]/g, "");
    const state = await page.evaluate(() => ({ open: !!window.viewerEngine.tileset, error: window.viewerEngine.error.get(), problems: window.viewerEngine.tileProblems.get() }));
    check(state.open && !state.error, "the tileset stays open when tiles fail");
    check(state.problems?.count === 3, `3 tiles are counted as failed (got ${state.problems?.count})`);
    check(["missing-a.glb", "missing-b.glb", "damaged.glb"].every((f) => text.includes(f)), "the notice names each failed tile");
    check(lang === "en" ? text.includes("3 tiles could not be loaded") : text.includes("3 אריחים לא נטענו"), "the notice says how many, in the user's language");
    await page.screenshot({ path: path.join(out, `${lang}-1-tiles.png`) });

    // 2. A model that makes drawing fail.
    await page.evaluate(() => {
      window.viewerEngine.tileset.update = () => {
        throw new Error("check-load-errors: this model cannot be drawn");
      };
    });
    const alert = page.locator('[role="alert"]');
    await alert.waitFor({ timeout: 60000 });
    const after = await page.evaluate(async () => {
      const e = window.viewerEngine;
      const s = e.widget.scene;
      const f0 = s.frameState.frameNumber;
      await new Promise((res) => setTimeout(res, 3000));
      return { frames: s.frameState.frameNumber - f0, open: !!e.tileset, panel: !!document.querySelector(".cesium-widget-errorPanel"), reason: e.error.get()?.reason };
    });
    check(!after.open, "the model that broke drawing is closed");
    check(after.frames > 0, `the view keeps drawing (${after.frames} frames in 3 s)`);
    check(!after.panel, "Cesium's own error panel is not shown");
    check(/could not draw this model/.test(after.reason ?? ""), "the message says what happened");
    await page.screenshot({ path: path.join(out, `${lang}-2-drawing.png`) });

    // 3. A good model afterwards.
    const good = await page.evaluate(async () => {
      const e = window.viewerEngine;
      e.close();
      await e.open({ id: "good", name: "Good", classificationId: "unclassified", status: "current", version: 1, versions: 1, sourceFormat: "glb", centre: { lat: 31.771, lon: 35.212 }, placement: { lat: 31.771, lon: 35.212, height: 0, aboveGround: 0 }, source: { kind: "glb", url: "load-errors/tiles/good.glb" } });
      return { open: !!e.model, error: e.error.get(), problems: e.tileProblems.get() };
    });
    check(good.open && !good.error && !good.problems, "a good model opens afterwards, with no notice left over");
    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
})();
