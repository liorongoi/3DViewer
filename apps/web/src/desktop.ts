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
  takeOpened(): Promise<DesktopFile[] | null>;
  onOpened(cb: () => void): void;
  platform: string;
}

export const desktop: DesktopApi | null = (globalThis as { viewerDesktop?: DesktopApi }).viewerDesktop ?? null;

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
