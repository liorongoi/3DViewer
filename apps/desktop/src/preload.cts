import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

/** The only desktop features the page can use (plan 3.2: narrow typed preload API). */
contextBridge.exposeInMainWorld("viewerDesktop", {
  /** Lets the user pick a folder; returns a viewer-file:// base URL and its tileset, if any. */
  openFolder: (): Promise<{ name: string; url: string; tileset: string | null } | null> => ipcRenderer.invoke("viewer:openFolder"),
  platform: process.platform,
});
