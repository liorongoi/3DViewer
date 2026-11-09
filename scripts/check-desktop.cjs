// WP 5.1, 5.3 and 5.4 check: the desktop app (built) in Electron, against the real server.
//
//   - The address IT configured (here VIEWER_SERVER_URL) is reached through viewer-server://:
//     the status pill says online, a model sent from the desktop is uploaded (tus), published
//     and streams back from the server, and a signed-in admin request (a cross-origin
//     preflight) goes through.
//   - Nothing else is reachable: an internet address is blocked.
//   - A model the app was started with (Explorer's "Open with") opens the upload wizard, and
//     "Keep on this computer only" opens it from viewer-file:// without sending it.
//   - The folder dialog opens a 3D Tiles folder, which streams from disk in place.
//   - An FBX is converted on this computer with the server's converter and opens offline.
//   - A dropped file is read in place by path, not copied into memory.
//   - The server stops: the pill turns offline and local files still open; it comes back: the
//     pill turns online again and the library returns, with no restart.
//
// Usage: build apps/web, apps/server and apps/desktop, fetch the Electron binary
// (node apps/desktop/node_modules/electron/install.js), then
//   xvfb-run -a node scripts/check-desktop.cjs
const { _electron } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, API } = require("./lib/test-server.cjs");

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "apps/desktop");
const SAMPLES = path.join(ROOT, "apps/web/public/samples");

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };

  // Files on "this computer": a model to start with, and a tileset folder with a space in its name.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-desktop-"));
  const glb = path.join(home, "Water bottle.glb");
  fs.copyFileSync(path.join(SAMPLES, "khronos/WaterBottle.glb"), glb);
  const tiles = path.join(home, "Discrete LOD");
  fs.cpSync(path.join(SAMPLES, "3dtiles/TilesetWithDiscreteLOD"), tiles, { recursive: true });
  const fbx = path.join(home, "stanford bunny.fbx");
  fs.copyFileSync(path.join(SAMPLES, "fbx/stanford-bunny.fbx"), fbx);
  const dropped = path.join(home, "Lantern.glb");
  fs.copyFileSync(path.join(SAMPLES, "khronos/Lantern.glb"), dropped);

  let server = await startServer({ workers: true });
  const electronPath = require(path.join(DESKTOP, "node_modules/electron"));
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [DESKTOP, "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", glb],
    env: { ...process.env, VIEWER_SERVER_URL: API, VIEWER_QUERY: "" },
    timeout: 120000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = new Set();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`  [page] ${m.text().slice(0, 200)}`));
  page.on("response", (r) => r.status() >= 400 && !bad.has(r.url()) && bad.size < 20 && (bad.add(r.url()), console.log(`  [${r.status()}] ${r.url().slice(0, 160)}`)));
  const pill = () => page.getByTestId("server-state").first().getAttribute("data-state").catch(() => null);
  const waitPill = async (state, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await pill()) === state) return Date.now() - t0;
      await page.waitForTimeout(500);
    }
    return null;
  };
  const engineReady = (id) =>
    page.waitForFunction((want) => {
      const e = window.viewerEngine;
      const cur = e?.current.get();
      return !!cur && (!want || cur.id === want || cur.source.url.startsWith(want)) && !e.loading.get() && (e.model ? e.model.ready : !!e.tileset);
    }, id, { timeout: 120000 });

  /** Steps through the wizard with files already in it, keeping the model on this computer or not. */
  const publish = async (name, keep = true) => {
    const dlg = page.getByRole("dialog");
    await dlg.getByTestId("upload-report").waitFor();
    for (let i = 0; i < 3; i++) await dlg.getByRole("button", { name: "Next" }).click();
    await dlg.locator("select[aria-required=true]").selectOption({ index: 1 });
    const box = dlg.getByTestId("keep-local");
    if ((await box.count()) && (await box.isChecked()) !== keep) await (keep ? box.check() : box.uncheck());
    await dlg.locator("input.input").first().fill(name);
    await dlg.getByRole("button", { name: "Publish" }).click();
    await dlg.waitFor({ state: "detached", timeout: 300000 });
  };

  try {
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });

    // The file the app was started with is waiting in the wizard.
    const wizard = page.getByRole("dialog");
    await wizard.getByTestId("upload-report").waitFor({ timeout: 60000 });
    check(/Water bottle\.glb/.test(await wizard.innerText()), "a model the app was started with opens in the upload wizard");
    check((await wizard.getByTestId("upload-report").innerText()).includes("glTF"), "its check report is shown");

    // Online: the pill, the server's library, a server model through viewer-server://.
    check((await waitPill("online", 30000)) !== null, "the status pill says the server is online");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();
    check(await wizard.getByTestId("keep-local").isChecked(), "a file opened from Explorer is kept on this computer by default");
    await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
    await publish("Water bottle");
    await engineReady("viewer-file://");
    let cur = await page.evaluate(() => window.viewerEngine.current.get().source.url);
    check(cur.startsWith("viewer-file://") && cur.endsWith("/Water%20bottle.glb"), "kept on this computer, it opens in place from viewer-file://", cur);

    const fromServer = await page.evaluate(async () => {
      const r = await fetch("viewer-server://library/api/models");
      return { status: r.status, n: (await r.json()).length };
    });
    check(fromServer.status === 200 && fromServer.n > 0, "the page reaches the configured server through viewer-server://", `${fromServer.n} models`);
    const admin = await page.evaluate(async () => {
      const login = await fetch("viewer-server://library/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "check-server-only-0123" }) });
      const { token } = await login.json();
      const r = await fetch("viewer-server://library/api/audit?limit=1", { headers: { authorization: `Bearer ${token}` } });
      return { login: login.status, audit: r.status };
    });
    check(admin.login === 200 && admin.audit === 200, "a signed-in admin request goes through (cross-origin preflight answered by the bridge)", JSON.stringify(admin));
    const outbound = await page.evaluate(() => fetch("https://example.com/").then(() => "reached", () => "blocked"));
    check(outbound === "blocked", "an internet address is blocked", outbound);
    const direct = await page.evaluate((api) => fetch(`${api}/api/health`).then(() => "reached", () => "blocked"), API);
    check(direct === "blocked", "the server is reachable only through the bridge, not directly", direct);

    // Sent to the server through the bridge (tus upload, ingest), it opens from the server.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, dropped);
    await page.locator('button[data-tip="Earth"]').first().click();
    await page.getByRole("button", { name: "Upload" }).first().click();
    await page.getByTestId("desktop-open-files").click();
    await publish("Lantern from the desktop", false);
    await engineReady("viewer-server://");
    cur = await page.evaluate(() => window.viewerEngine.current.get().source.url);
    check(cur.startsWith("viewer-server://library/files/"), "a model sent from the desktop is uploaded, published and streams back from the server", cur);

    // A folder from the system dialog: a 3D Tiles set, read in place.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, tiles);
    await page.locator('button[data-tip="Earth"]').first().click();
    await page.getByRole("button", { name: "Upload" }).first().click();
    await page.getByTestId("desktop-open-folder").click();
    await page.getByRole("dialog").getByTestId("upload-report").waitFor();
    check(/tileset\.json/.test(await page.getByRole("dialog").innerText()), "the folder dialog opens a tileset folder");
    await publish("Discrete LOD");
    await engineReady("viewer-file://");
    await page.waitForFunction(() => (window.viewerEngine.tileset?.statistics.numberOfLoadedTilesTotal ?? 0) > 0, null, { timeout: 120000 }).catch(() => undefined);
    cur = await page.evaluate(() => ({ url: window.viewerEngine.current.get().source.url, tiles: window.viewerEngine.tileset?.statistics.numberOfLoadedTilesTotal ?? 0 }));
    check(cur.url.startsWith("viewer-file://") && cur.url.endsWith("/tileset.json") && cur.tiles > 0, "the tileset streams from disk in place", `${cur.tiles} tiles loaded`);

    // An FBX, converted on this computer with the server's converter (WP 5.2), opens offline.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fbx);
    await page.locator('button[data-tip="Earth"]').first().click();
    await page.getByRole("button", { name: "Upload" }).first().click();
    const t0 = Date.now();
    await page.getByTestId("desktop-open-files").click();
    await page.getByRole("dialog").getByTestId("upload-report").waitFor();
    const fbxReport = await page.getByRole("dialog").getByTestId("upload-report").innerText();
    check(/Converted to glTF on this computer/.test(fbxReport), "an FBX is converted to glTF on this computer", `${((Date.now() - t0) / 1000).toFixed(1)} s with the check`);
    await publish("Bunny from FBX");
    await engineReady("viewer-file://");
    cur = await page.evaluate(() => ({ url: window.viewerEngine.current.get().source.url, format: window.viewerEngine.current.get().sourceFormat }));
    check(cur.url.startsWith("viewer-file://") && cur.url.endsWith("/stanford%20bunny.glb") && cur.format === "fbx", "the converted model opens in place, marked as from FBX", JSON.stringify(cur));
    const sneaky = await page.evaluate(() => window.viewerDesktop.convertFbx("viewer-file://nope/etc/x.fbx"));
    check(!sneaky.ok && sneaky.reason === "notOpened", "only a file the user opened can be converted", JSON.stringify(sneaky));

    // A dropped file: the preload reads its path, the main process opens it in place.
    const drop = await page.evaluate(async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "drop-probe";
      document.body.append(input);
      return true;
    });
    await page.setInputFiles("#drop-probe", dropped);
    const listed = await page.evaluate(async () => {
      const f = document.getElementById("drop-probe").files;
      const l = await window.viewerDesktop.openDropped([...f]);
      document.getElementById("drop-probe").remove();
      return l;
    });
    check(drop && listed?.length === 1 && listed[0].url.startsWith("viewer-file://") && listed[0].path === "Lantern.glb", "a dropped file is opened in place by its path", JSON.stringify(listed?.[0]));
    const forged = await page.evaluate(async () => window.viewerDesktop.openDropped([new File(["x"], "/etc/passwd")]));
    check(forged === null, "a file made up by the page (no real path) opens nothing", JSON.stringify(forged));

    // The server goes away and comes back: no restart.
    server.stop();
    const off = await waitPill("offline", 60000);
    check(off !== null, "with the server stopped the pill turns offline", off !== null ? `${(off / 1000).toFixed(0)} s` : "never");
    const local = await page.evaluate(async (u) => (await fetch(u)).status, listed?.[0]?.url);
    check(local === 200, "local files still open while offline");
    server = await startServer({ workers: true });
    const on = await waitPill("online", 30000);
    check(on !== null, "with the server back the pill turns online again", on !== null ? `${(on / 1000).toFixed(0)} s` : "never");
    await page.locator('button[data-tip="Earth"]').first().click();
    const back = await page.getByRole("button", { name: /Lantern/ }).first().isVisible();
    check(back, "the server's library returns");

    check(errors.length === 0, "no page errors", errors.join(" | ").slice(0, 300));
  } catch (e) {
    console.log(`FAIL ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(os.tmpdir(), "check-desktop-fail.png") }).catch(() => undefined);
    failed++;
  } finally {
    await app.close().catch(() => undefined);
    server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
