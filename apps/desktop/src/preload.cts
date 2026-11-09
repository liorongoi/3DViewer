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
  info: (): Promise<{ server: string | null; serverAddress: string | null; configuredBy: string | null; problems: string[]; version: string }> => ipcRenderer.invoke("viewer:info"),
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
  platform: process.platform,
});
