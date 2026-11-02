import { BrowserWindow, app, dialog, ipcMain, net, protocol, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Roots, SCHEME, serveLocal } from "./local-files.js";

/**
 * VIEWER desktop shell (plan WP 0.6 spike, later WP 5.1). It loads the same web build as the
 * portal from a private viewer-app:// origin, and reaches local folders only through
 * viewer-file://, which the user opens one at a time. Hardened: context isolation, sandbox,
 * no Node in the page, a narrow preload API, no remote content, no navigation away.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = "viewer-app";
// Web build: next to the app when packaged, the web app's dist folder in development.
const webDir = process.env.VIEWER_WEB_DIR ?? (app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(here, "../../web/dist"));

protocol.registerSchemesAsPrivileged([
  { scheme: APP, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const roots = new Roots();
const CSP = [
  "default-src 'self'",
  `connect-src 'self' ${SCHEME}: data: blob:`,
  `img-src 'self' ${SCHEME}: data: blob:`,
  // Cesium compiles styles and some shaders helpers with new Function, as in the web build.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
].join("; ");

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

app.whenReady().then(async () => {
  roots.add(webDir, "app");
  protocol.handle(APP, async (req) => {
    const res = await serveLocal(roots, req);
    if (process.env.VIEWER_SMOKE && res.status >= 400) console.log("[viewer-app]", res.status, req.url);
    res.headers.set("Content-Security-Policy", CSP);
    return res;
  });
  protocol.handle(SCHEME, (req) => serveLocal(roots, req));
  // Air gap: the page may only talk to its own schemes (and, later, the configured server).
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(viewer-app|viewer-file|data|blob|devtools|chrome-extension):/.test(d.url);
    if (process.env.VIEWER_SMOKE && !ok) console.log("[blocked]", d.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  ipcMain.handle("viewer:openFolder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Open a 3D Tiles folder" });
    if (r.canceled || !r.filePaths[0]) return null;
    return folderInfo(r.filePaths[0]);
  });

  const win = await createWindow();
  if (process.env.VIEWER_SMOKE) console.log("[smoke] page loaded");
  if (process.env.VIEWER_SMOKE) await smoke(win, process.env.VIEWER_SMOKE);
});

app.on("window-all-closed", () => app.quit());

/** A folder the user opened, as a base URL the page can fetch from. */
function folderInfo(dir: string): { name: string; url: string; tileset: string | null } {
  const id = roots.add(dir);
  const tileset = fs.existsSync(path.join(dir, "tileset.json")) ? `${SCHEME}://${id}/tileset.json` : null;
  return { name: path.basename(dir), url: `${SCHEME}://${id}/`, tileset };
}

/**
 * Smoke test for the spike (VIEWER_SMOKE=<folder with tileset.json>): range request, sandbox
 * escape, then stream the tileset in the real app and report frames per second.
 */
async function smoke(win: BrowserWindow, dir: string): Promise<void> {
  const f = folderInfo(dir);
  const js = `(async () => {
    const out = {};
    const r = await fetch(${JSON.stringify(f.tileset)}, { headers: { Range: "bytes=0-15" } });
    out.range = r.status + " " + r.headers.get("content-range") + " " + (await r.text()).length + " bytes";
    out.escape = (await fetch(${JSON.stringify(f.url)} + "..%2F..%2F..%2Fetc%2Fpasswd")).status;
    out.outbound = await fetch("https://example.com/").then(() => "reached", () => "blocked");
    out.desktopApi = typeof window.viewerDesktop?.openFolder;
    for (let i = 0; i < 300 && !(window.viewerEngine && window.Cesium); i++) await new Promise((r) => setTimeout(r, 100));
    const C = window.Cesium, e = window.viewerEngine;
    const t0 = performance.now();
    const ts = await C.Cesium3DTileset.fromUrl(${JSON.stringify(f.tileset)});
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
