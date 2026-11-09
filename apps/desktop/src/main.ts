import { BrowserWindow, app, dialog, ipcMain, protocol, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { machineSources, readConfig } from "./config.js";
import { Roots, SCHEME, listFiles, listFolder, serveLocal, type ListedFile } from "./local-files.js";
import { SERVER_BASE, SERVER_SCHEME, proxyServer } from "./server-proxy.js";
import { convertFbx, findConverter, stopAll } from "./fbx.js";

/**
 * VIEWER desktop app (plan WP 5.1, 5.3, 5.4). It loads the same web build as the portal from a
 * private viewer-app:// origin. Local files are reached only through viewer-file://, for what
 * the user opened; the library server only through viewer-server://, forwarded to the one
 * address IT configured (config.ts). Hardened: context isolation, sandbox, no Node in the page,
 * a narrow preload API, no other network, no navigation away, every permission refused.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = "viewer-app";
// Web build: next to the app when packaged, the web app's dist folder in development.
const webDir = process.env.VIEWER_WEB_DIR ?? (app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(here, "../../web/dist"));
const exeDir = app.isPackaged ? path.dirname(process.execPath) : path.resolve(here, "..");
const config = readConfig(machineSources(exeDir));
for (const p of config.problems) console.warn(`VIEWER configuration: ${p}`);

protocol.registerSchemesAsPrivileged([
  { scheme: APP, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: SERVER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const roots = new Roots();
const CSP = [
  "default-src 'self'",
  `connect-src 'self' ${SCHEME}: ${SERVER_SCHEME}: data: blob:`,
  `img-src 'self' ${SCHEME}: ${SERVER_SCHEME}: data: blob:`,
  // Cesium compiles styles and some shaders helpers with new Function, as in the web build.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
].join("; ");

// Files the app was started with (Explorer's "Open with", a file association), or that a second
// start passed on, wait here until the page asks for them.
const MODEL_FILE = /\.(glb|gltf|fbx|zip|json)$/i;
const pendingPaths: string[] = [];
const fromArgv = (argv: string[]) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && MODEL_FILE.test(a) && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  pendingPaths.push(...fromArgv(process.argv));
  app.on("second-instance", (_e, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    const paths = fromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (paths.length) win.webContents.send("viewer:opened", paths.length);
    }
    pendingPaths.push(...paths);
  });
  void app.whenReady().then(start);
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    backgroundColor: "#0E0F12",
    title: "VIEWER",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${APP}://`)) e.preventDefault();
  });
  if (process.env.VIEWER_SMOKE) {
    win.webContents.on("console-message", (e) => console.log(`[page ${e.level}] ${e.message.slice(0, 300)}`));
    win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[load fail] ${code} ${desc} ${url}`));
    console.log("[smoke] loading", webDir);
  }
  await win.loadURL(`${APP}://app/index.html${process.env.VIEWER_QUERY ?? ""}`);
  return win;
}

async function start(): Promise<void> {
  roots.add(webDir, "app");
  protocol.handle(APP, async (req) => {
    const res = await serveLocal(roots, req);
    if (process.env.VIEWER_SMOKE && res.status >= 400) console.log("[viewer-app]", res.status, req.url);
    res.headers.set("Content-Security-Policy", CSP);
    return res;
  });
  protocol.handle(SCHEME, (req) => serveLocal(roots, req));
  const server = config.serverUrl;
  // The bridge's own session: the page's session refuses every network request (below), and
  // this one is used only by the main process, for the one configured address.
  const bridge = session.fromPartition("viewer-server-bridge");
  bridge.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  protocol.handle(SERVER_SCHEME, (req) =>
    server ? proxyServer(server, req, (url, init) => bridge.fetch(url, init as RequestInit)) : Promise.resolve(new Response(null, { status: 404 })),
  );
  // Air gap: the page may only talk to its own schemes; the server goes through viewer-server://.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(viewer-app|viewer-file|viewer-server|data|blob|devtools|chrome-extension):/.test(d.url);
    if (process.env.VIEWER_SMOKE && !ok) console.log("[blocked]", d.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  ipcMain.handle("viewer:info", () => ({ server: server ? SERVER_BASE : null, serverAddress: server, configuredBy: config.source, problems: config.problems, version: app.getVersion() }));
  ipcMain.handle("viewer:openFiles", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "3D models", extensions: ["glb", "gltf", "fbx", "zip", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled ? null : await listFiles(roots, r.filePaths);
  });
  ipcMain.handle("viewer:openFolder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return (await listFolder(roots, r.filePaths[0])).files;
  });
  // Paths of files or folders dropped on the page (the preload reads them from the File objects).
  ipcMain.handle("viewer:openPaths", async (_e, paths: unknown) => listPaths(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []));
  // Local FBX (WP 5.2): converts a file the user opened, never a path the page names.
  const converter = findConverter({ env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, here });
  const fbxRoot = path.join(app.getPath("temp"), "VIEWER-fbx");
  // Only one copy of the app runs, so what is left here is from an earlier run.
  fs.rmSync(fbxRoot, { recursive: true, force: true });
  app.on("will-quit", () => {
    stopAll();
    fs.rmSync(fbxRoot, { recursive: true, force: true });
  });
  let conversions = 0;
  ipcMain.handle("viewer:convertFbx", async (_e, url: unknown) => {
    if (!converter) return { ok: false, reason: "unavailable" };
    let input: string | null = null;
    try {
      const u = new URL(String(url));
      if (u.protocol === `${SCHEME}:`) input = roots.resolve(u.hostname, u.pathname.slice(1));
    } catch {
      /* not a URL */
    }
    if (!input || !/\.fbx$/i.test(input)) return { ok: false, reason: "notOpened" };
    const r = await convertFbx(converter, input, { workDir: path.join(fbxRoot, String(++conversions)) });
    if (!r.ok) return r;
    const [file] = await listFiles(roots, [r.glb]);
    return file ? { ok: true, file, ms: r.ms } : { ok: false, reason: "failed", detail: "" };
  });
  // What the app was started with, once.
  ipcMain.handle("viewer:takeOpened", async () => listPaths(pendingPaths.splice(0)));

  const win = await createWindow();
  if (process.env.VIEWER_SMOKE) console.log("[smoke] page loaded");
  if (process.env.VIEWER_SMOKE) await smoke(win, process.env.VIEWER_SMOKE);
}

app.on("window-all-closed", () => app.quit());

/** Files and folders by path: each folder listed whole, the files one by one. */
async function listPaths(paths: string[]): Promise<ListedFile[] | null> {
  if (!paths.length) return null;
  const out: ListedFile[] = [];
  const files: string[] = [];
  for (const p of paths) {
    const st = await fs.promises.stat(p).catch(() => null);
    if (st?.isDirectory()) out.push(...(await listFolder(roots, p)).files);
    else if (st?.isFile()) files.push(p);
  }
  out.push(...(await listFiles(roots, files)));
  return out;
}

/**
 * Smoke test (VIEWER_SMOKE=<folder with tileset.json>): range request, sandbox escape, then
 * stream the tileset in the real app and report frames per second.
 */
async function smoke(win: BrowserWindow, dir: string): Promise<void> {
  const listed = await listFolder(roots, dir);
  const tileset = listed.files.find((f) => f.path.endsWith("/tileset.json"))?.url ?? "";
  const base = tileset.slice(0, tileset.lastIndexOf("/") + 1);
  const js = `(async () => {
    const out = {};
    const r = await fetch(${JSON.stringify(tileset)}, { headers: { Range: "bytes=0-15" } });
    out.range = r.status + " " + r.headers.get("content-range") + " " + (await r.text()).length + " bytes";
    out.escape = (await fetch(${JSON.stringify(base)} + "..%2F..%2F..%2Fetc%2Fpasswd")).status;
    out.outbound = await fetch("https://example.com/").then(() => "reached", () => "blocked");
    out.desktopApi = typeof window.viewerDesktop?.openFolder;
    for (let i = 0; i < 300 && !(window.viewerEngine && window.Cesium); i++) await new Promise((r) => setTimeout(r, 100));
    const C = window.Cesium, e = window.viewerEngine;
    const t0 = performance.now();
    const ts = await C.Cesium3DTileset.fromUrl(${JSON.stringify(tileset)});
    e.widget.scene.primitives.add(ts);
    e.widget.camera.flyToBoundingSphere(ts.boundingSphere, { duration: 0 });
    await new Promise((res) => { const off = ts.allTilesLoaded.addEventListener(() => { off(); res(); }); setTimeout(res, 60000); });
    out.firstViewMs = Math.round(performance.now() - t0);
    out.tilesLoaded = ts.statistics.numberOfLoadedTilesTotal;
    let frames = 0; const off = e.widget.scene.postRender.addEventListener(() => frames++);
    const s = performance.now();
    await new Promise((res) => { const step = () => { e.widget.camera.rotateRight(0.01); e.widget.scene.requestRender(); if (performance.now() - s < 5000) requestAnimationFrame(step); else res(); }; step(); });
    off(); out.fps = Math.round(frames / 5);
    return out;
  })()`;
  try {
    console.log("SMOKE " + JSON.stringify(await win.webContents.executeJavaScript(js)));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.VIEWER_SMOKE_SHOT ?? "smoke.png", img.toPNG());
  } catch (e) {
    console.log("SMOKE-FAIL " + String(e));
  }
  app.quit();
}
