import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { problem } from "./errors.ts";

/** Where the server keeps bytes: uploads in progress, unpacked ingests, and published model files. */
export class Storage {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  get uploads() {
    return path.join(this.root, "uploads");
  }
  get ingests() {
    return path.join(this.root, "ingests");
  }
  get files() {
    return path.join(this.root, "files");
  }
  async init(): Promise<void> {
    for (const d of [this.uploads, this.ingests, this.files]) await mkdir(d, { recursive: true });
  }
  uploadPart(id: string): string {
    return path.join(this.uploads, `${id}.part`);
  }
  /** Joins a relative path under a base, refusing anything that would leave it. */
  static inside(base: string, rel: string): string | null {
    const clean = rel.replace(/\\/g, "/");
    if (clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").some((p) => p === ".." || p === "")) return null;
    const full = path.resolve(base, clean);
    return full.startsWith(base + path.sep) ? full : null;
  }
}

/** A path inside a dropped folder or zip: relative, no "..", no empty parts, sane length. */
export function validRelPath(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length <= 1024 && Storage.inside("/x", p) !== null && !/[\0\r\n]/.test(p);
}

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".b3dm": "application/octet-stream",
  ".i3dm": "application/octet-stream",
  ".pnts": "application/octet-stream",
  ".cmpt": "application/octet-stream",
  ".subtree": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".fbx": "application/octet-stream",
};

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
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

/**
 * Published model files (WP 3.7). Paths carry the model and version, so their content never
 * changes: immutable caching, ETag, and range requests for large tiles. In production Caddy
 * serves the same folder with the same headers; this route is for development and small sites.
 */
export function registerFiles(app: FastifyInstance, storage: Storage): void {
  app.get<{ Params: { "*": string } }>("/files/*", { schema: { hide: true } }, async (req, reply) => {
    const full = Storage.inside(storage.files, decodeURIComponent(req.params["*"]));
    const st = full ? await stat(full).catch(() => null) : null;
    if (!full || !st?.isFile()) return reply.status(404).send(problem("notFound"));
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    reply
      .header("etag", etag)
      .header("accept-ranges", "bytes")
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .type(TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream");
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    const range = parseRange(req.headers.range, st.size);
    if (range === "invalid") return reply.status(416).header("content-range", `bytes */${st.size}`).send();
    if (range) {
      reply.status(206).header("content-range", `bytes ${range.start}-${range.end}/${st.size}`).header("content-length", range.end - range.start + 1);
      return reply.send(createReadStream(full, { start: range.start, end: range.end }));
    }
    reply.header("content-length", st.size);
    return reply.send(createReadStream(full));
  });
}
