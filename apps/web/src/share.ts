import { walk, type Layer, type SharedMeasurement, type SharedView, type ViewMode } from "@viewer/core";

/** What a share link carries (WP 4.6). Uploads that only live in one browser cannot be shared. */
export interface ShareState {
  m: string;
  v: number;
  c: SharedView;
  mode: ViewMode;
  hidden: string[];
  /** The measurements on screen; absent in links made before they were carried. */
  ms?: SharedMeasurement[];
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export function hiddenLayers(layers: Layer[]): string[] {
  const out: string[] = [];
  walk(layers, (l) => {
    if (!l.visible) out.push(l.id);
  });
  return out;
}

export function shareUrl(state: ShareState): string {
  const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  const c = state.c;
  const compact = { ...state, ...(state.ms?.length ? {} : { ms: undefined }), c: { lon: round(c.lon, 7), lat: round(c.lat, 7), h: round(c.h, 2), heading: round(c.heading, 5), pitch: round(c.pitch, 5), roll: round(c.roll, 5) } };
  return `${location.origin}${location.pathname}${location.search}#view=${b64url(JSON.stringify(compact))}`;
}

export function readShare(hash = location.hash): ShareState | null {
  const m = /[#&]view=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const s = JSON.parse(unb64url(m[1]!)) as ShareState;
    return typeof s.m === "string" && s.c && Number.isFinite(s.c.lon) ? s : null;
  } catch {
    return null;
  }
}
