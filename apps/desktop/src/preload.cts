import electron = require("electron");
const { contextBridge, ipcRenderer, webUtils } = electron;

/** A file the page can read through viewer-file://, with its path inside what was opened. */
interface ListedFile {
  path: string;
  size: number;
  url: string;
}

/** The only desktop features the page can use (plan 3.2: narrow typed preload API). */
contextBridge.exposeInMainWorld("viewerDesktop", {
  /** How the app is set up: the server base the page uses (or null), where it came from, problems. */
  info: (): Promise<{ server: string | null; serverAddress: string | null; configuredBy: string | null; problems: string[]; version: string; onlineMaps?: boolean; onlineMapsLocked?: boolean; samples?: boolean }> => ipcRenderer.invoke("viewer:info"),
  /** The user's switch for online maps; answers whether they are on now (IT's decision wins). */
  setOnlineMaps: (on: boolean): Promise<boolean> => ipcRenderer.invoke("viewer:setOnlineMaps", on),
  /** The models opened from this computer, kept from the last start; those whose files are gone are listed in missing. */
  loadLibrary: (): Promise<{ models: unknown[]; files: Record<string, string[]>; missing: string[] }> => ipcRenderer.invoke("viewer:loadLibrary"),
  /** Keeps the models opened from this computer for the next start. */
  saveLibrary: (models: unknown[], files: Record<string, string[]>): Promise<boolean> => ipcRenderer.invoke("viewer:saveLibrary", models, files),
  /** The open dialog for model files. */
  openFiles: (): Promise<ListedFile[] | null> => ipcRenderer.invoke("viewer:openFiles"),
  /** The open dialog for a folder (a 3D Tiles set, a glTF with its textures). */
  openFolder: (): Promise<ListedFile[] | null> => ipcRenderer.invoke("viewer:openFolder"),
  /** Files and folders dropped on the page, read in place by path instead of copied into memory. */
  openDropped: (files: File[]): Promise<ListedFile[] | null> => {
    const paths = Array.from(files, (f) => {
      try {
        return webUtils.getPathForFile(f);
      } catch {
        return "";
      }
    }).filter(Boolean);
    return ipcRenderer.invoke("viewer:openPaths", paths);
  },
  /** Converts an opened FBX to a GLB on this computer, with the same converter as the server. */
  convertFbx: (url: string): Promise<{ ok: true; file: ListedFile; ms: number } | { ok: false; reason: string; detail?: string }> => ipcRenderer.invoke("viewer:convertFbx", url),
  /** Files the app was started with (Explorer's "Open with"), once. */
  takeOpened: (): Promise<ListedFile[] | null> => ipcRenderer.invoke("viewer:takeOpened"),
  /** Called when files are opened while the app is already running; take them with takeOpened. */
  onOpened: (cb: () => void): void => {
    ipcRenderer.on("viewer:opened", () => cb());
  },
  /** Processor, memory, free disk and system, for "Check this computer". */
  computer: (): Promise<{ cpuModel: string | null; cores: number; ramGb: number; freeDiskGb: number | null; os: string }> => ipcRenderer.invoke("viewer:computer"),
  /** "Build on this PC": the building add-on HOLO uses (or null), what nvidia-smi says, and whether a build runs. */
  buildStatus: (): Promise<{ addon: { version: string } | null; nvidiaSmi: string; building: boolean }> => ipcRenderer.invoke("viewer:buildStatus"),
  /** Picks the building add-on zip and installs it for this user. Null when the user cancels. */
  installBuildAddon: (): Promise<{ ok: true; version: string } | { ok: false; reason: string } | null> => ipcRenderer.invoke("viewer:installBuildAddon"),
  /** The open dialog for a capture: one video, or photos. */
  pickCapture: (kind: "video" | "photos"): Promise<ListedFile[] | null> => ipcRenderer.invoke("viewer:pickCapture", kind),
  /** Builds splats (or only checks the capture) from files opened in HOLO, named by their viewer-file:// URLs. */
  build: (request: Record<string, unknown>, urls: string[]): Promise<Record<string, unknown>> => ipcRenderer.invoke("viewer:build", request, urls),
  stopBuild: (): Promise<boolean> => ipcRenderer.invoke("viewer:stopBuild"),
  /** Shows the last finished build in Explorer. */
  showBuildFolder: (): Promise<boolean> => ipcRenderer.invoke("viewer:showBuildFolder"),
  /** The name of the HOLO build folder these opened files are in, or null when they are not in one. */
  buildFolderOf: (urls: string[]): Promise<string | null> => ipcRenderer.invoke("viewer:buildFolderOf", urls),
  /** Moves that build folder to the Recycle Bin (Trash on a Mac). False when it could not. */
  trashBuild: (urls: string[]): Promise<boolean> => ipcRenderer.invoke("viewer:trashBuild", urls),
  /** Progress of the running build; returns a function that stops listening. */
  onBuildProgress: (cb: (p: { fraction: number; stage: string }) => void): (() => void) => {
    const h = (_e: unknown, p: { fraction: number; stage: string }) => cb(p);
    ipcRenderer.on("viewer:buildProgress", h);
    return () => {
      ipcRenderer.removeListener("viewer:buildProgress", h);
    };
  },
  platform: process.platform,
});
