import { BrowserWindow, app, dialog, ipcMain, protocol, session, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { machineSources, readConfig } from "./config.js";
import { Roots, SCHEME, listFiles, listFolder, serveLocal, type ListedFile } from "./local-files.js";
import { SERVER_BASE, SERVER_SCHEME, proxyServer } from "./server-proxy.js";
import { convertFbx, findConverter, stopAll } from "./fbx.js";
import { CAPTURE_PHOTO, CAPTURE_VIDEO, buildFolderOf, cleanRequest, currentAddon, installAddon, nvidiaSmi, startBuild, type BuildRequest } from "./local-build.js";

/**
 * HOLO desktop app (plan WP 5.1, 5.3, 5.4). It loads the same web build as the portal from a
 * private viewer-app:// origin. Local files are reached only through viewer-file://, for what
 * the user opened; the library server only through viewer-server://, forwarded to the one
 * address IT configured (config.ts). Hardened: context isolation, sandbox, no Node in the page,
 * a narrow preload API, no other network, no navigation away, every permission refused.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// Development and test switches; an installed app ignores them (WP 5.5).
const dev: Record<string, string | undefined> = app.isPackaged ? {} : process.env;
const APP = "viewer-app";
// Web build: next to the app when packaged, the web app's dist folder in development.
const webDir = dev.VIEWER_WEB_DIR ?? (app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(here, "../../web/dist"));
const exeDir = app.isPackaged ? path.dirname(process.execPath) : path.resolve(here, "..");
const config = readConfig(machineSources(exeDir));
for (const p of config.problems) console.warn(`HOLO configuration: ${p}`);

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
const MODEL_FILE = /\.(glb|gltf|fbx|spz|ply|zip|json)$/i;
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
    title: "HOLO",
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
  if (dev.VIEWER_SMOKE) {
    win.webContents.on("console-message", (e) => console.log(`[page ${e.level}] ${e.message.slice(0, 300)}`));
    win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[load fail] ${code} ${desc} ${url}`));
    console.log("[smoke] loading", webDir);
  }
  await win.loadURL(`${APP}://app/index.html${dev.VIEWER_QUERY ?? ""}`);
  return win;
}

async function start(): Promise<void> {
  roots.add(webDir, "app");
  protocol.handle(APP, async (req) => {
    const res = await serveLocal(roots, req);
    if (dev.VIEWER_SMOKE && res.status >= 400) console.log("[viewer-app]", res.status, req.url);
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
    if (dev.VIEWER_SMOKE && !ok) console.log("[blocked]", d.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  ipcMain.handle("viewer:info", () => ({ server: server ? SERVER_BASE : null, serverAddress: server, configuredBy: config.source, problems: config.problems, version: app.getVersion() }));
  // "Check this computer" (Help): what the operating system says; the page adds the graphics card.
  ipcMain.handle("viewer:computer", async () => {
    let freeDiskGb: number | null = null;
    try {
      const st = await fs.promises.statfs(app.getPath("userData"));
      freeDiskGb = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
    } catch {
      freeDiskGb = null;
    }
    return { cpuModel: os.cpus()[0]?.model ?? null, cores: os.availableParallelism(), ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, freeDiskGb, os: `${os.type()} ${os.release()}` };
  });
  ipcMain.handle("viewer:openFiles", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "3D models", extensions: ["glb", "gltf", "fbx", "spz", "ply", "zip", "json"] },
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
  const converter = findConverter({ env: dev, packaged: app.isPackaged, resourcesPath: process.resourcesPath, here });
  const fbxRoot = path.join(app.getPath("temp"), "HOLO-fbx");
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

  // "Build on this PC": Gaussian splats on this computer's graphics card with the building add-on.
  const dataDir = app.getPath("userData");
  const addonDir = path.join(dataDir, "building");
  const buildWork = path.join(app.getPath("temp"), "HOLO-build");
  fs.rmSync(buildWork, { recursive: true, force: true });
  let building: { stop: () => void } | null = null;
  let installing = false;
  let lastFolder: string | null = null;
  const outRoot = path.join(app.getPath("documents"), "HOLO builds");
  app.on("will-quit", () => {
    building?.stop();
    fs.rmSync(buildWork, { recursive: true, force: true });
  });
  ipcMain.handle("viewer:buildStatus", async () => {
    const addon = currentAddon(dataDir);
    return { addon: addon ? { version: addon.version } : null, nvidiaSmi: await nvidiaSmi(), building: !!building };
  });
  ipcMain.handle("viewer:installBuildAddon", async (e) => {
    if (building || installing) return { ok: false, reason: "busy" };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "HOLO building add-on", extensions: ["zip"] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    installing = true;
    try {
      const done = await installAddon(r.filePaths[0], addonDir, dataDir);
      return done.ok ? { ok: true, version: done.addon.version } : { ok: false, reason: done.reason };
    } finally {
      installing = false;
    }
  });
  ipcMain.handle("viewer:pickCapture", async (e, kind: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const photos = kind === "photos";
    const r = await dialog.showOpenDialog(win!, {
      properties: photos ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [photos ? { name: "Photos", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp"] } : { name: "Video", extensions: ["mp4", "mov", "m4v", "lrv", "ts", "mts", "avi", "mkv", "webm"] }],
    });
    return r.canceled || !r.filePaths.length ? null : await listFiles(roots, r.filePaths);
  });
  ipcMain.handle("viewer:build", async (e, request: unknown, urls: unknown) => {
    if (building || installing) return { ok: false, reason: "busy" };
    const addon = currentAddon(dataDir);
    if (!addon) return { ok: false, reason: "noAddon" };
    const req = (request && typeof request === "object" ? request : {}) as Partial<BuildRequest>;
    // Only files the user opened in HOLO, and only videos or photos.
    const files: string[] = [];
    for (const u of Array.isArray(urls) ? urls.slice(0, 5000) : []) {
      let file: string | null = null;
      try {
        const url = new URL(String(u));
        if (url.protocol === `${SCHEME}:`) file = roots.resolve(url.hostname, url.pathname.slice(1));
      } catch {
        file = null;
      }
      if (file && (CAPTURE_VIDEO.test(file) || CAPTURE_PHOTO.test(file))) files.push(file);
    }
    if (!files.length) return { ok: false, reason: "noFiles" };
    const clean = cleanRequest(req, files);
    await fs.promises.mkdir(buildWork, { recursive: true });
    // Frames, poses and the build's own files need room: about three times the capture, at least 5 GB.
    let size = 0;
    for (const f of files) size += (await fs.promises.stat(f).catch(() => null))?.size ?? 0;
    try {
      const st = await fs.promises.statfs(buildWork);
      const needGb = Math.max(5, (3 * size) / 1024 ** 3);
      const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
      if (freeGb < needGb) return { ok: false, reason: "disk", needGb: Math.ceil(needGb), freeGb: Math.floor(freeGb) };
    } catch {
      /* unknown: go ahead */
    }
    const sender = e.sender;
    const run = startBuild(addon, clean, buildWork, outRoot, (p) => {
      if (!sender.isDestroyed()) sender.send("viewer:buildProgress", p);
    });
    building = run;
    try {
      const r = await run.done;
      if (!r.ok) return r.stopped ? { ok: false, reason: "stopped" } : { ok: false, reason: "failed", detail: r.reason ?? "" };
      if (clean.checkOnly) return { ok: true, report: r.report };
      lastFolder = r.folder ?? null;
      const [file] = await listFiles(roots, [r.file!]);
      return file ? { ok: true, file, name: clean.name } : { ok: false, reason: "failed", detail: "" };
    } finally {
      building = null;
    }
  });
  ipcMain.handle("viewer:stopBuild", () => {
    building?.stop();
    return true;
  });
  // The folder of the last finished build, in Explorer (never a path the page names).
  ipcMain.handle("viewer:showBuildFolder", () => {
    if (lastFolder) shell.showItemInFolder(path.join(lastFolder, "splats.ply"));
    return !!lastFolder;
  });

  // Deleting a built model: the build folder its files are in (by the viewer-file:// URLs of files
  // the user opened), its name to show, and moving it to the Recycle Bin (Trash on a Mac).
  const buildFolderFor = (urls: unknown): string | null => {
    const files: string[] = [];
    for (const u of Array.isArray(urls) ? urls.slice(0, 5000) : []) {
      let file: string | null = null;
      try {
        const url = new URL(String(u));
        if (url.protocol === `${SCHEME}:`) file = roots.resolve(url.hostname, url.pathname.slice(1));
      } catch {
        file = null;
      }
      if (!file) return null;
      files.push(file);
    }
    return files.length ? buildFolderOf(files, outRoot) : null;
  };
  ipcMain.handle("viewer:buildFolderOf", (_e, urls: unknown) => {
    const folder = buildFolderFor(urls);
    return folder ? path.basename(folder) : null;
  });
  ipcMain.handle("viewer:trashBuild", async (_e, urls: unknown) => {
    const folder = buildFolderFor(urls);
    if (!folder) return false;
    try {
      await shell.trashItem(folder);
      if (lastFolder && path.resolve(lastFolder) === path.resolve(folder)) lastFolder = null;
      return true;
    } catch {
      return false;
    }
  });

  const win = await createWindow();
  if (dev.VIEWER_SMOKE) console.log("[smoke] page loaded");
  if (dev.VIEWER_SMOKE) await smoke(win, dev.VIEWER_SMOKE);
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
    fs.writeFileSync(dev.VIEWER_SMOKE_SHOT ?? "smoke.png", img.toPNG());
  } catch (e) {
    console.log("SMOKE-FAIL " + String(e));
  }
  app.quit();
}
