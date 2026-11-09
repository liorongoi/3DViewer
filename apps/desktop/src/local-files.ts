import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * viewer-file:// (plan WP 0.6 / 5.3): streams files from folders the user opened, with HTTP
 * range requests so Cesium can read a 50 GB local tileset piece by piece. Only folders the
 * user picked are reachable; anything outside them, or through "..", is refused.
 */

export const SCHEME = "viewer-file";

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".b3dm": "application/octet-stream",
  ".i3dm": "application/octet-stream",
  ".pnts": "application/octet-stream",
  ".cmpt": "application/octet-stream",
  ".subtree": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
};

/**
 * Folders the user opened, by a short random id that appears in the URL instead of the path.
 * A folder can be limited to some of its files (files opened one by one, not their folder).
 */
export class Roots {
  private roots = new Map<string, { dir: string; only?: Set<string> }>();

  add(dir: string, fixedId?: string, only?: string[]): string {
    const real = fs.realpathSync(dir);
    const key = only ? [...only].sort().join("\0") : undefined;
    for (const [id, r] of this.roots) {
      const same = r.only ? [...r.only].sort().join("\0") : undefined;
      if (r.dir === real && same === key && (!fixedId || id === fixedId)) return id;
    }
    const id = fixedId ?? randomId();
    this.roots.set(id, { dir: real, ...(only ? { only: new Set(only) } : {}) });
    return id;
  }

  /** The file a URL path points to, or null when it is outside every opened folder. */
  resolve(id: string, rel: string): string | null {
    const r = this.roots.get(id);
    if (!r) return null;
    const root = r.dir;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const inside = path.posix.normalize("/" + decoded.replace(/\\/g, "/")).slice(1);
    if (r.only && !r.only.has(inside)) return null;
    const full = path.resolve(root, "./" + inside);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    // Symlinks must not lead out of the folder either.
    try {
      const real = fs.realpathSync(full);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return real;
    } catch {
      return null;
    }
  }
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);

/** A file the page can read: its path inside what was opened, size and viewer-file:// URL. */
export interface ListedFile {
  path: string;
  size: number;
  url: string;
}

/** At most this many files are listed from one folder (a big city tileset has tens of thousands). */
export const MAX_LISTED = 500_000;

/**
 * Every file under a folder, with paths starting with the folder's own name (as a dropped
 * folder lists in the browser). Symlinks are skipped, so nothing outside the folder is listed.
 */
export async function listFolder(roots: Roots, dir: string): Promise<{ id: string; files: ListedFile[]; truncated: boolean }> {
  const id = roots.add(dir);
  const top = path.basename(dir);
  const files: ListedFile[] = [];
  let truncated = false;
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= MAX_LISTED) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(abs, e.name), relPath);
      else if (e.isFile()) {
        const st = await fs.promises.stat(path.join(abs, e.name));
        files.push({ path: `${top}/${relPath}`, size: st.size, url: `${SCHEME}://${id}/${relPath.split("/").map(encodeURIComponent).join("/")}` });
      }
    }
  };
  await walk(fs.realpathSync(dir), "");
  return { id, files, truncated };
}

/**
 * Files opened one by one (from Explorer, the open dialog or a drop), each reachable on its
 * own. A .gltf or a tileset.json needs the files next to it, so its whole folder is opened.
 */
export async function listFiles(roots: Roots, paths: string[]): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const d = path.dirname(p);
    byDir.set(d, [...(byDir.get(d) ?? []), path.basename(p)]);
  }
  for (const [dir, names] of byDir) {
    if (names.some((n) => /\.(gltf|json)$/i.test(n))) {
      const all = await listFolder(roots, dir);
      const top = path.basename(dir);
      out.push(...all.files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })));
      continue;
    }
    const id = roots.add(dir, undefined, names);
    for (const n of names) {
      const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
      if (st?.isFile()) out.push({ path: n, size: st.size, url: `${SCHEME}://${id}/${encodeURIComponent(n)}` });
    }
  }
  return out;
}

/** Parses "bytes=a-b", "bytes=a-" and "bytes=-n" for a file of the given size. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** Answers one viewer-file:// request. */
export async function serveLocal(roots: Roots, req: Request): Promise<Response> {
  const url = new URL(req.url);
  // viewer-file://<root id>/<path inside the folder>
  const file = roots.resolve(url.hostname, url.pathname.slice(1));
  const cors = { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" };
  if (!file) return new Response("Not found", { status: 404, headers: cors });
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return new Response("Not found", { status: 404, headers: cors });
  }
  if (!stat.isFile()) return new Response("Not found", { status: 404, headers: cors });
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = parseRange(req.headers.get("range"), stat.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...cors, "Content-Range": `bytes */${stat.size}` } });
  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  const body = stat.size === 0 ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...cors,
      "Content-Type": type,
      "Content-Length": String(stat.size === 0 ? 0 : end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
    },
  });
}
