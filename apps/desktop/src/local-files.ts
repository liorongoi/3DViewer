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

/** Folders the user opened, by a short random id that appears in the URL instead of the path. */
export class Roots {
  private roots = new Map<string, string>();

  add(dir: string, fixedId?: string): string {
    const real = fs.realpathSync(dir);
    for (const [id, d] of this.roots) if (d === real && (!fixedId || id === fixedId)) return id;
    const id = fixedId ?? Math.random().toString(36).slice(2, 10);
    this.roots.set(id, real);
    return id;
  }

  /** The file a URL path points to, or null when it is outside every opened folder. */
  resolve(id: string, rel: string): string | null {
    const root = this.roots.get(id);
    if (!root) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const full = path.resolve(root, "." + path.posix.normalize("/" + decoded.replace(/\\/g, "/")));
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
