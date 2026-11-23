import type { LocalFile } from "@viewer/core";

/**
 * The desktop app's features (WP 5.1, 5.3, 5.4), from its preload script. Null in a browser.
 * Files it opens are read in place through viewer-file:// URLs, never copied into memory.
 */
export interface DesktopFile {
  path: string;
  size: number;
  url: string;
}

export interface DesktopInfo {
  /** Base URL the page uses for the library server, or null when none is configured. */
  server: string | null;
  /** The address IT configured, for the About box. */
  serverAddress: string | null;
  configuredBy: string | null;
  problems: string[];
  version: string;
}

interface DesktopApi {
  info(): Promise<DesktopInfo>;
  openFiles(): Promise<DesktopFile[] | null>;
  openFolder(): Promise<DesktopFile[] | null>;
  openDropped(files: File[]): Promise<DesktopFile[] | null>;
  convertFbx(url: string): Promise<{ ok: true; file: DesktopFile; ms: number } | { ok: false; reason: string; detail?: string }>;
  takeOpened(): Promise<DesktopFile[] | null>;
  onOpened(cb: () => void): void;
  /** Present from the version that has "Check this computer". */
  computer?: () => Promise<{ cpuModel: string | null; cores: number; ramGb: number; freeDiskGb: number | null; os: string }>;
  /** "Build on this PC" (Windows app from 1.3.0). */
  buildStatus?: () => Promise<{ addon: { version: string } | null; nvidiaSmi: string; building: boolean }>;
  installBuildAddon?: () => Promise<{ ok: true; version: string } | { ok: false; reason: string } | null>;
  pickCapture?: (kind: "video" | "photos") => Promise<DesktopFile[] | null>;
  build?: (request: LocalBuildRequest, urls: string[]) => Promise<LocalBuildResult>;
  stopBuild?: () => Promise<boolean>;
  showBuildFolder?: () => Promise<boolean>;
  /** Present from the version that can delete models: the build folder opened files are in, by name. */
  buildFolderOf?: (urls: string[]) => Promise<string | null>;
  /** Moves that build folder to the Recycle Bin (Trash on a Mac). */
  trashBuild?: (urls: string[]) => Promise<boolean>;
  onBuildProgress?: (cb: (p: { fraction: number; stage: string }) => void) => () => void;
  platform: string;
}

export interface LocalBuildRequest {
  inputKind: "video" | "photos";
  name: string;
  checkOnly: boolean;
  iterations: number;
  maxSplats: number;
  resolution: number;
  shDegree: number;
  videoFps: number;
  threads: number;
}

export type LocalBuildResult =
  | { ok: true; file: DesktopFile; name: string; report?: undefined }
  | { ok: true; report: unknown; file?: undefined }
  | { ok: false; reason: "busy" | "noAddon" | "noFiles" | "stopped" | "failed" | "disk"; detail?: string; needGb?: number; freeGb?: number };

export const desktop: DesktopApi | null = (globalThis as { viewerDesktop?: DesktopApi }).viewerDesktop ?? null;

/** "Build on this PC" is offered: HOLO for Windows, from the version that has it. */
export const localBuildAvailable = (): boolean => !!desktop?.build && desktop.platform === "win32";

let info: Promise<DesktopInfo | null> | null = null;
/** The desktop app's set-up, read once. */
export function desktopInfo(): Promise<DesktopInfo | null> {
  return (info ??= desktop ? desktop.info().catch(() => null) : Promise.resolve(null));
}

/** A desktop file as the loaders see it: read through its URL, in ranges when asked. */
export function fromDesktop(f: DesktopFile): LocalFile {
  const read = async (headers?: HeadersInit) => {
    const r = await fetch(f.url, headers ? { headers } : undefined);
    if (!r.ok) throw new Error(`${f.path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  return {
    path: f.path,
    size: f.size,
    url: f.url,
    bytes: () => read(),
    slice: (start, end) => (end <= start ? Promise.resolve(new Uint8Array(0)) : read({ Range: `bytes=${start}-${end - 1}` })),
  };
}

export const fromDesktopList = (list: DesktopFile[] | null): LocalFile[] | null => (list?.length ? list.map(fromDesktop) : null);
