import fs from "node:fs";
import path from "node:path";
import { SCHEME, type Roots } from "./local-files.js";

/**
 * The models opened from this computer, kept for the next start (the Windows app has no server
 * library of its own). The page hands over its list; the main process stores it with the folders
 * its viewer-file:// URLs stand for, taken from what the user opened this session, never from
 * the page. At the next start those folders are opened again under the same ids, so the stored
 * URLs work unchanged. A model whose folder is gone is still listed, marked missing, so it can be
 * deleted.
 */
export interface KeptFile {
  version: 1;
  models: unknown[];
  /** Per model id, the viewer-file:// URLs of the files it was opened from (for delete). */
  files: Record<string, string[]>;
  roots: Record<string, { dir: string; only?: string[] }>;
}

/** Big enough for thousands of models; a page that sends more is refused. */
export const MAX_KEPT_BYTES = 8 * 1024 * 1024;

const URL_ID = new RegExp(`${SCHEME}://([a-z0-9]+)/`, "g");

/** Ids of the opened folders a JSON text refers to. */
export function referencedRoots(json: string): Set<string> {
  const ids = new Set<string>();
  for (const m of json.matchAll(URL_ID)) ids.add(m[1]!);
  return ids;
}

/** What to write for the page's list: only models and folders this session can vouch for. */
export function toKept(roots: Roots, models: unknown, files: unknown): KeptFile | null {
  if (!Array.isArray(models)) return null;
  const list = models.filter((m): m is { id: string } => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string");
  const fileMap: Record<string, string[]> = {};
  if (files && typeof files === "object") {
    for (const m of list) {
      const f = (files as Record<string, unknown>)[m.id];
      if (Array.isArray(f)) fileMap[m.id] = f.filter((u): u is string => typeof u === "string" && u.startsWith(`${SCHEME}://`));
    }
  }
  const out: KeptFile = { version: 1, models: list, files: fileMap, roots: {} };
  const text = JSON.stringify(out);
  if (text.length > MAX_KEPT_BYTES) return null;
  for (const id of referencedRoots(text)) {
    const r = roots.get(id);
    if (r) out.roots[id] = r;
  }
  return out;
}

/** Writes the file whole or not at all. */
export function writeKept(file: string, kept: KeptFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(kept));
  fs.renameSync(tmp, file);
}

/** Reads the kept list and opens its folders again; models whose folders are gone come back as missing. */
export function readKept(file: string, roots: Roots): { models: unknown[]; files: Record<string, string[]>; missing: string[] } {
  let kept: KeptFile;
  try {
    kept = JSON.parse(fs.readFileSync(file, "utf8")) as KeptFile;
    if (kept?.version !== 1 || !Array.isArray(kept.models)) throw new Error("not a kept library");
  } catch {
    return { models: [], files: {}, missing: [] };
  }
  const ok = new Set<string>();
  for (const [id, r] of Object.entries(kept.roots ?? {})) {
    if (r && typeof r.dir === "string" && roots.restore(id, r.dir, Array.isArray(r.only) ? r.only : undefined)) ok.add(id);
  }
  const missing: string[] = [];
  for (const m of kept.models) {
    const ids = referencedRoots(JSON.stringify(m));
    if ([...ids].some((id) => !ok.has(id))) missing.push((m as { id: string }).id);
  }
  return { models: kept.models, files: kept.files ?? {}, missing };
}

/** Folders a kept library still needs (to keep FBX conversions of kept models). */
export function keptDirs(file: string): Set<string> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8")) as KeptFile;
    return new Set(Object.values(kept.roots ?? {}).map((r) => path.resolve(r.dir)));
  } catch {
    return new Set();
  }
}
