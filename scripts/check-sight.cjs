// WP 2.8 line-of-sight check (VWR-ANL-01, VWR-ANL-02): 20 observer / target pairs over a DEM,
// against a reference built with GDAL.
//
// The reference (scripts/fixtures/sight-reference.json, from scripts/sight-reference.py) is a
// 4 × 4 km DEM in UTM 36N with 10 m cells (scripts/fixtures/sight-dem.tif) and 20 pairs, 10 seen
// and 10 blocked, each with the first sample where the ground rises 5 cm above the sight line
// and the worst deficit along it. gdal_viewshed agrees with every one of the 20.
//
// In the web app the DEM is added as terrain the way a user adds it (Map tab, GeoTIFF, "use as
// terrain"), the 20 pairs are placed through the tool's own click handler, and:
//   - every pair is seen or blocked as in the reference;
//   - a blocked pair's first obstruction is within one sample spacing of the reference's;
//   - the worst deficit (or smallest clearance) is within 5 cm;
//   - the ground at each end is the DEM's own height, within 1 cm;
//   - 20 pairs are computed in reasonable time and the view stays interactive with all of them;
//   - the panel lists 20 pairs, exports 20 CSV rows, renames, hides and deletes a pair, and
//     Ctrl+Z brings a deleted pair back;
//   - a pair placed with the mouse is computed too;
//   - a 60 m tower opened where a clear line runs lowest blocks it, at the tower, at its roof height.
//
// Usage: build apps/web, start `vite preview` on :4173, then node scripts/check-sight.cjs
// (CHROMIUM may point at a Chromium binary).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const REF = require("./fixtures/sight-reference.json");
const OUT = path.join(ROOT, "apps/web/dist/samples/_check-sight");
const DEM_URL = "samples/_check-sight/sight-dem.tif";
const TOWER_URL = "samples/_check-sight/tower.glb";
const TOWER = { w: 12, h: 60 };

/** A closed box TOWER.w wide and TOWER.h tall, standing on the origin (glTF, y up). */
function writeTower(file) {
  const { w, h } = TOWER;
  const v = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([x, z]) => [[(x * w) / 2, 0, (z * w) / 2]]);
  const corners = [...v, ...v.map(([x, , z]) => [x, h, z])];
  const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  const pos = [];
  const idx = [];
  for (const q of quads) {
    const base = pos.length / 3;
    for (const i of q) pos.push(...corners[i]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const p32 = new Float32Array(pos);
  const i16 = new Uint16Array(idx);
  const pad = Buffer.alloc((4 - (i16.byteLength % 4)) % 4);
  const bin = Buffer.concat([Buffer.from(p32.buffer), Buffer.from(i16.buffer), pad]);
  const json = {
    asset: { version: "2.0", generator: "check-sight" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Tower", mesh: 0 }],
    meshes: [{ name: "Tower", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.75, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: p32.length / 3, type: "VEC3", min: [-w / 2, 0, -w / 2], max: [w / 2, h, w / 2] },
      { bufferView: 1, componentType: 5123, count: i16.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: p32.byteLength, target: 34962 },
      { buffer: 0, byteOffset: p32.byteLength, byteLength: i16.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const chunk = (buf, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(buf.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, buf]);
  };
  const body = Buffer.concat([chunk(jsonBuf, 0x4e4f534a), chunk(bin, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures/sight-dem.tif"), path.join(OUT, "sight-dem.tif"));
  writeTower(path.join(OUT, "tower.glb"));
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (process.env.SHOT) page.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 600)));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
  await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
  await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });

  // ---- The DEM as terrain, and the view over it ----
  const center = REF.pairs.reduce((s, p) => [s[0] + (p.a.lon + p.b.lon) / 40, s[1] + (p.a.lat + p.b.lat) / 40], [0, 0]);
  await page.evaluate(
    async ({ url, center }) => {
      const e = window.viewerEngine;
      const layer = await e.userLayers.addGeoTiff(url, "sight-dem");
      await e.userLayers.setAsTerrain(layer.id, true);
      if (e.model) e.model.show = false;
      const C3 = e.widget.camera.position.constructor;
      e.widget.camera.setView({ destination: C3.fromDegrees(center[0], center[1] - 0.035, 3500), orientation: { heading: 0, pitch: -0.6, roll: 0 } });
      e.widget.scene.requestRender();
    },
    { url: DEM_URL, center },
  );
  await page.waitForTimeout(3000);

  // The ground under each end, as the tool samples it: the DEM's own cells.
  const ends = REF.pairs.flatMap((p) => [p.a, p.b]);
  const ground = await page.evaluate(async (pts) => {
    const e = window.viewerEngine;
    const Carto = e.widget.camera.positionCartographic.constructor;
    const out = await e.sampleGround(pts.map((p) => Carto.fromDegrees(p.lon, p.lat)));
    return out.map((c) => c.height);
  }, ends);
  const worstEnd = Math.max(...ends.map((p, i) => Math.abs(ground[i] - p.h)));
  check(worstEnd <= 0.01, "the ground at all 40 ends is the DEM's own height, within 1 cm", `worst ${(worstEnd * 100).toFixed(2)} cm`);

  // ---- The 20 pairs, through the tool's click handler ----
  await page.keyboard.press("i");
  await page.waitForFunction(() => window.viewerEngine.sight.active.get(), null, { timeout: 10000 });
  const t0 = Date.now();
  await page.evaluate((pairs) => {
    const e = window.viewerEngine;
    const C3 = e.widget.camera.position.constructor;
    for (const p of pairs) {
      e.sight.addPoint(C3.fromDegrees(p.a.lon, p.a.lat, p.a.h));
      e.sight.addPoint(C3.fromDegrees(p.b.lon, p.b.lat, p.b.h));
    }
  }, REF.pairs);
  await page.waitForFunction(() => {
    const l = window.viewerEngine.sight.pairs.get();
    return l.length === 20 && l.every((p) => !p.computing);
  }, null, { timeout: 300000 });
  const computeS = (Date.now() - t0) / 1000;
  check(computeS < 20, "20 pairs computed in under 20 s in software rendering", `${computeS.toFixed(1)} s`);

  const got = await page.evaluate(() =>
    window.viewerEngine.sight.pairs.get().map((p) => ({ name: p.name, visible: p.visible, block: p.block?.d ?? null, worstDeficit: p.worstDeficit, distance: p.distance, samples: p.profile.length - 1 })),
  );
  let agree = 0;
  REF.pairs.forEach((r, i) => {
    const g = got[i];
    const tag = `pair ${i + 1} (${r.visible ? "seen" : "blocked"}, ${Math.round(r.distance)} m)`;
    if (g.visible === r.visible) agree++;
    check(g.visible === r.visible, `${tag}: ${r.visible ? "seen" : "blocked"} as in the reference and gdal_viewshed`, g.visible ? "app: seen" : `app: blocked at ${g.block?.toFixed(1)} m`);
    check(g.samples === r.samples && Math.abs(g.distance - r.distance) < 0.01, `${tag}: same distance and samples`, `${g.distance.toFixed(3)} m in ${g.samples}, reference ${r.distance.toFixed(3)} m in ${r.samples}`);
    if (!r.visible && g.block !== null) {
      const spacing = r.distance / r.samples;
      check(Math.abs(g.block - r.block.d) <= spacing + 1e-6, `${tag}: first obstruction within one sample spacing (${spacing.toFixed(1)} m)`, `${g.block.toFixed(1)} m, reference ${r.block.d.toFixed(1)} m`);
    }
    check(Math.abs(g.worstDeficit - r.worstDeficit) <= 0.05, `${tag}: ${r.visible ? "smallest clearance" : "worst obstruction"} within 5 cm`, `${g.worstDeficit.toFixed(3)} m, reference ${r.worstDeficit.toFixed(3)} m`);
  });
  check(agree === 20, "all 20 pairs agree with the reference", `${agree} of 20`);
  check(got[1].name === "Line of sight 2", "pairs are named in the interface language", got[1].name);

  // ---- Still interactive with 20 pairs drawn ----
  const frame = await page.evaluate(async () => {
    const e = window.viewerEngine;
    const cam = e.widget.camera;
    const times = [];
    for (let i = 0; i < 12; i++) {
      cam.rotateRight(0.01);
      const t = performance.now();
      e.widget.render();
      times.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 30));
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  });
  check(frame < 250, "a frame with 20 pairs drawn renders in under 250 ms in software rendering", `median ${frame.toFixed(0)} ms`);

  // ---- The panel ----
  const cards = page.locator("li[data-pair]");
  check((await cards.count()) === 20, "the Analysis panel lists 20 pairs", `${await cards.count()}`);
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const csv = fs.readFileSync(await (await dl).path(), "utf8").replace(/^﻿/, "").trim().split("\n");
  const rows = csv.slice(1);
  check(rows.length === 20, "the CSV has a header and 20 rows", `${rows.length}`);
  const visCol = csv[0].split(",").indexOf("visible");
  const csvSeen = rows.filter((r) => r.split(",")[visCol] === "yes").length;
  check(csvSeen === 10, "the CSV marks 10 pairs seen", `${csvSeen}`);

  // The newest pair is listed first; cards are found by the pair they show.
  const ids = await page.evaluate(() => window.viewerEngine.sight.pairs.get().map((p) => p.id));
  const card = (id) => page.locator(`li[data-pair="${id}"]`);
  check((await cards.first().getAttribute("data-pair")) === ids[19], "the newest pair is listed first");

  // Rename pair 1.
  await card(ids[0]).locator("button[aria-expanded]").click();
  const rename = card(ids[0]).getByRole("textbox", { name: "Rename" });
  await rename.fill("North ridge");
  await rename.press("Enter");
  const renamed = await page.evaluate(() => window.viewerEngine.sight.pairs.get()[0].name);
  check(renamed === "North ridge", "a pair can be renamed", renamed);
  check((await card(ids[0]).getAttribute("aria-label")) === "North ridge", "the card shows the new name");
  check((await card(ids[0]).locator("button[aria-expanded]").innerText()).includes("A1–B1"), "a renamed pair keeps its A1 and B1 points");

  // Hide pair 2, then delete pair 3 and take it back.
  await card(ids[1]).getByRole("button", { name: "Hide on map" }).click();
  const hidden = await page.evaluate(() => window.viewerEngine.sight.pairs.get()[1].shown);
  check(hidden === false, "a pair can be hidden on the map");
  await card(ids[2]).getByRole("button", { name: "Delete pair" }).click();
  check((await cards.count()) === 19, "a pair can be deleted", `${await cards.count()} left`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => window.viewerEngine.sight.pairs.get().map((p) => p.id));
  check(back.length === 20 && back[2] === ids[2], "Ctrl+Z brings the deleted pair back in its place", `${back.length} pairs, third is ${back[2]}`);

  // ---- A pair placed with the mouse, looking down on the DEM ----
  await page.evaluate((center) => {
    const e = window.viewerEngine;
    const C3 = e.widget.camera.position.constructor;
    e.widget.camera.setView({ destination: C3.fromDegrees(center[0], center[1], 6000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    e.widget.scene.requestRender();
  }, center);
  await page.waitForTimeout(2000);
  if (!(await page.evaluate(() => window.viewerEngine.sight.active.get()))) await page.keyboard.press("i");
  await page.waitForFunction(() => window.viewerEngine.sight.active.get(), null, { timeout: 10000 });
  const box = await page.locator("canvas").first().boundingBox();
  const before = await page.evaluate(() => window.viewerEngine.sight.pairs.get().length);
  for (const [fx, fy] of [[0.35, 0.6], [0.45, 0.35]]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 });
    await page.waitForTimeout(300);
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(500);
  }
  await page.waitForFunction((n) => {
    const l = window.viewerEngine.sight.pairs.get();
    return l.length === n + 1 && !l[n].computing;
  }, before, { timeout: 120000 }).catch(() => {});
  const mouse = await page.evaluate(() => window.viewerEngine.sight.pairs.get().at(-1));
  check(!!mouse && mouse.visible !== null && mouse.profile.length > 30, "a pair placed with the mouse is computed", mouse ? `${mouse.name}: ${mouse.visible ? "seen" : "blocked"}, ${Math.round(mouse.distance)} m` : "none");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // ---- A building on a clear line blocks it ----
  // A 60 m tower is opened on the first clear pair, where its line passes closest to the ground
  // (but not within a tenth of either end).
  const ci = REF.pairs.findIndex((p) => p.visible);
  const clear = REF.pairs[ci];
  const spot = await page.evaluate((i) => {
    const p = window.viewerEngine.sight.pairs.get()[i];
    let best = null;
    for (const q of p.profile) if (q.d > p.distance * 0.1 && q.d < p.distance * 0.9 && (!best || q.sight - q.ground < best.sight - best.ground)) best = q;
    return { lon: best.lon, lat: best.lat, d: best.d, clearance: best.sight - best.ground };
  }, ci);
  const mid = spot;
  const tower = await page.evaluate(
    async ({ url, mid, clear }) => {
      const e = window.viewerEngine;
      const Carto = e.widget.camera.positionCartographic.constructor;
      const [g] = await e.sampleGround([Carto.fromDegrees(mid.lon, mid.lat)]);
      const s = e.current.get();
      await e.open({ ...s, id: "check-sight-tower", name: "Tower", placement: { lat: mid.lat, lon: mid.lon, height: g.height }, source: { kind: "glb", url } }, { fly: false });
      const t0 = performance.now();
      while (!e.model?.ready && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
      e.sight.clear();
      e.sight.start();
      const C3 = e.widget.camera.position.constructor;
      e.sight.addPoint(C3.fromDegrees(clear.a.lon, clear.a.lat, clear.a.h));
      e.sight.addPoint(C3.fromDegrees(clear.b.lon, clear.b.lat, clear.b.h));
      while (e.sight.pairs.get()[0]?.computing && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200));
      const p = e.sight.pairs.get()[0];
      return p && { visible: p.visible, block: p.block?.d ?? null, surface: p.block?.surface ?? null, ground: g.height, distance: p.distance };
    },
    { url: TOWER_URL, mid, clear },
  );
  const half = spot.d;
  check(!!tower && tower.visible === false, "a tower on a clear line blocks it", tower ? (tower.visible ? "still seen" : `blocked at ${tower.block.toFixed(1)} m`) : "no pair");
  if (tower?.block !== null && tower?.block !== undefined) {
    // The first sample inside the tower's footprint: within half its width plus one sample of the middle.
    const spacing = clear.distance / clear.samples;
    check(Math.abs(tower.block - half) <= TOWER.w / 2 + spacing, "the tower is where the line is first blocked", `${tower.block.toFixed(1)} m, tower at ${half.toFixed(1)} m where the line clears the ground by ${spot.clearance.toFixed(1)} m`);
    check(Math.abs(tower.surface - (tower.ground + TOWER.h)) <= 0.5, "the obstruction is the tower's roof", `${tower.surface.toFixed(2)} m, roof at ${(tower.ground + TOWER.h).toFixed(2)} m`);
  }

  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All line-of-sight checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
