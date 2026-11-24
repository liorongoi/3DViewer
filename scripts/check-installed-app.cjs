// The installed HOLO for Windows, driven as a user would on a standalone PC (no server):
//
//   - The library has no bundled samples.
//   - Map & data opens with no model open. Online maps start off; the user turns them on there,
//     and then the app can read from the network but still not send (POST blocked).
//   - A model opened from this computer (Explorer's "Open with") gets a delete button that shows
//     without hovering. After a restart it is still in the library and opens again, and the
//     online maps choice is kept. Deleted, it leaves the library and stays gone after a restart.
//   - Zooming keeps the picture at one resolution: adaptive resolution is off unless chosen.
//
// It runs the real HOLO.exe (or any HOLO build) and drives its window over the Chromium
// debugging port, since the packaged app's fuses refuse Node's inspector.
//
//   node scripts/check-installed-app.cjs <HOLO.exe> [app folder, for a development build]
//
// HOLO_DATA is the app's data folder to start from empty (%APPDATA%\HOLO by default on Windows).
// It moves viewer.json next to the exe aside for the run (the installer writes a server address
// there) and puts it back.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const exe = process.argv[2];
const appDir = process.argv[3];
const PORT = 9333;
const DATA = process.env.HOLO_DATA ?? (process.platform === "win32" ? path.join(process.env.APPDATA ?? "", "HOLO") : null);

/** A one-triangle GLB, so the check needs no sample files. */
function tinyGlb() {
  const d = 0.5;
  const pos = new Float32Array([-d, 0, -d, d, 0, -d, 0, d, 0]);
  const bin = Buffer.from(pos.buffer);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Marker", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-d, 0, -d], max: [d, d, 0] }],
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

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  if (!exe || !fs.existsSync(exe)) {
    console.log(`FAIL no HOLO at ${exe}`);
    process.exit(1);
  }
  // A clean start: no kept library or settings from an earlier run, no server address.
  for (const f of ["library.json", "prefs.json"]) if (DATA) fs.rmSync(path.join(DATA, f), { force: true });
  const cfg = path.join(path.dirname(exe), "viewer.json");
  const cfgSaved = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
  if (cfgSaved) fs.rmSync(cfg);

  // A "map server" on this machine: the network the app may read from once online maps are on.
  const tiles = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end(req.method);
  });
  await new Promise((r) => tiles.listen(0, "127.0.0.1", r));
  const NET = `http://127.0.0.1:${tiles.address().port}/tile`;

  const mine = fs.mkdtempSync(path.join(os.tmpdir(), "holo-mine-"));
  const bottle = path.join(mine, "Kept bottle.glb");
  fs.writeFileSync(bottle, tinyGlb());

  let proc = null;
  let browser = null;
  const start = async (...files) => {
    const env = { ...process.env };
    for (const k of ["VIEWER_SERVER_URL", "VIEWER_ONLINE_MAPS", "VIEWER_SAMPLES"]) delete env[k];
    proc = spawn(exe, [...(appDir ? [appDir] : []), `--remote-debugging-port=${PORT}`, "--no-sandbox", "--ignore-gpu-blocklist", ...files], { env, stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!browser) throw new Error("HOLO did not open its window");
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("viewer-app://")) ?? null;
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) throw new Error("no HOLO page");
    page.setDefaultTimeout(60000);
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
    // The kept library and the app's set-up arrive just after the page.
    await page.waitForTimeout(2000);
    return page;
  };
  const stop = async () => {
    await browser?.close().catch(() => undefined);
    browser = null;
    if (proc && proc.exitCode === null) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
      else proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    }
    proc = null;
    await new Promise((r) => setTimeout(r, 1500));
  };
  const cards = (p) => p.locator("[data-model-card] [dir=auto]").allInnerTexts();
  const net = (p, method) => p.evaluate(({ url, method }) => fetch(url, { method, ...(method === "POST" ? { body: "x" } : {}) }).then(() => "reached", () => "blocked"), { url: NET, method });

  try {
    // ---- First start: an empty library, online maps off until turned on ----
    let p = await start();
    await p.evaluate(() => localStorage.setItem("viewer.lang", "en"));
    await p.reload();
    await p.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
    await p.waitForTimeout(2000);
    check((await p.locator("[data-model-card]").count()) === 0, "the library has no bundled samples", (await cards(p)).join(", ") || "empty");
    await p.getByTestId("open-home-map").click();
    await p.getByTestId("home-map-panel").waitFor();
    const osm = p.getByRole("radio", { name: /OpenStreetMap/ }).first();
    check((await osm.count()) === 1 && (await osm.isDisabled()), "Map & data opens with no model; online maps start off");
    check((await net(p, "GET")) === "blocked", "while off, nothing goes to the network");
    await p.getByTestId("online-maps-on").click();
    await p.waitForFunction(() => !document.querySelector('[data-testid="online-maps-on"]'));
    check(!(await osm.isDisabled()), "the user turns online maps on, and online base maps can be chosen");
    check((await net(p, "GET")) === "reached", "then the app reads from the network");
    check((await net(p, "POST")) === "blocked", "but still cannot send to it (POST blocked)");
    await stop();

    // ---- Open a model from Explorer, keep it on this computer ----
    p = await start(bottle);
    const dlg = p.getByRole("dialog");
    await dlg.getByTestId("upload-report").waitFor({ timeout: 120000 });
    const next = dlg.getByRole("button", { name: "Next" });
    while (await next.isVisible().catch(() => false)) await next.click();
    await dlg.locator("select[aria-required=true]").selectOption({ index: 1 }).catch(() => undefined);
    await dlg.locator("input.input").first().fill("Kept bottle");
    await dlg.getByRole("button", { name: "Publish" }).click();
    await dlg.waitFor({ state: "detached", timeout: 120000 });
    await p.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    // Zoom: one resolution all the way through.
    const zoom = await p.evaluate(async () => {
      const e = window.viewerEngine;
      const seen = new Set();
      const off = e.widget.scene.postRender.addEventListener(() => seen.add(e.widget.resolutionScale.toFixed(3)));
      const c = e.widget.canvas;
      const r = c.getBoundingClientRect();
      for (let i = 0; i < 12; i++) {
        c.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.55, bubbles: true, cancelable: true }));
        await new Promise((res) => setTimeout(res, 150));
      }
      await new Promise((res) => setTimeout(res, 2500));
      off();
      return { adaptive: e.adaptiveResolution, scales: [...seen] };
    });
    check(!zoom.adaptive && zoom.scales.length === 1, "zooming keeps one resolution (adaptive resolution off by default)", `${zoom.scales.join(", ")}`);
    await p.locator('button[data-tip="Earth"]').first().click();
    const bin = p.locator("div.group\\/card", { has: p.getByText("Kept bottle", { exact: true }) }).getByTestId("delete-model-open");
    await bin.waitFor();
    check((await bin.evaluate((el) => getComputedStyle(el).opacity)) === "1", "its delete button shows without hovering");
    await p.waitForTimeout(1000);
    await stop();

    // ---- Restart: still there, opens again; then delete it ----
    p = await start();
    check((await cards(p)).includes("Kept bottle"), "after a restart the model is still in the library", (await cards(p)).join(", "));
    check((await p.evaluate(() => window.viewerDesktop.info())).onlineMaps === true, "and online maps are still on");
    await p.getByText("Kept bottle", { exact: true }).first().click();
    await p.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    check(true, "it opens again from the file on this computer");
    await p.getByTestId("delete-model-header").click();
    const del = p.getByTestId("delete-model");
    await del.waitFor();
    await del.getByTestId("delete-model-go").click();
    await del.waitFor({ state: "detached" });
    check(!(await cards(p)).includes("Kept bottle"), "deleted, it leaves the library");
    check(fs.existsSync(bottle), "and its file stays on this computer");
    await p.waitForTimeout(1000);
    await stop();

    p = await start();
    check(!(await cards(p)).includes("Kept bottle"), "after another restart it is still gone");
    await stop();
  } catch (e) {
    console.log(`FAIL ${e.message.split("\n")[0]}`);
    failed++;
  } finally {
    await stop().catch(() => undefined);
    tiles.close();
    if (cfgSaved) fs.writeFileSync(cfg, cfgSaved);
    fs.rmSync(mine, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
