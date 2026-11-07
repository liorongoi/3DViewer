import { createApiClient, must, type ApiClient, type paths, type Schemas } from "@viewer/api-client";
import type { CheckReport, LocalFile } from "@viewer/core";
import type { BaseMapConfig, ClassificationLevel, LayerManifest, ModelSummary } from "@viewer/shared";

/**
 * The VIEWER server (Phase 3). The web app finds it at VITE_API_URL, or on its own origin.
 * With no server it runs on the bundled sample library, as before.
 */
const configured = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

export interface ServerInfo {
  /** Absolute base URL, ending without a slash. */
  base: string;
  db: string;
}

export async function findServer(timeoutMs = 2500): Promise<ServerInfo | null> {
  if (import.meta.env.VITE_NO_SERVER === "1") return null;
  const base = configured ?? new URL(".", location.href).href.replace(/\/$/, "");
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${base}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = (await r.json()) as { ok?: boolean; db?: string };
    return j.ok ? { base, db: j.db ?? "" } : null;
  } catch {
    return null;
  }
}

const clients = new WeakMap<ServerInfo, ApiClient>();
/** The generated, typed client for this server (WP 3.1). */
export function apiFor(srv: ServerInfo): ApiClient {
  let c = clients.get(srv);
  if (!c) clients.set(srv, (c = createApiClient(srv.base)));
  return c;
}

/** Published file URLs are relative to the server ("files/…"); the engine needs them absolute. */
function absolute(srv: ServerInfo, m: ModelSummary): ModelSummary {
  const abs = (u: string) => (/^[a-z]+:/i.test(u) ? u : `${srv.base}/${u}`);
  return { ...m, source: { ...m.source, url: abs(m.source.url) }, ...(m.thumbnail ? { thumbnail: abs(m.thumbnail) } : {}) };
}

export async function listModels(srv: ServerInfo): Promise<ModelSummary[]> {
  return must(await apiFor(srv).GET("/api/models")).map((m) => absolute(srv, m));
}

/** The admin's classification levels, lowest first. */
export async function listLevels(srv: ServerInfo): Promise<ClassificationLevel[]> {
  return must(await apiFor(srv).GET("/api/classifications"));
}

/** This site's base map sources (WP 3.9). */
export async function getBaseMaps(srv: ServerInfo): Promise<BaseMapConfig> {
  return must(await apiFor(srv).GET("/api/basemaps"));
}

/** The producer's arrangement of a model's layers (WP 2.1), or null; null too if it cannot be read. */
export async function getLayerManifest(srv: ServerInfo, id: string, version?: number): Promise<LayerManifest | null> {
  const r = await apiFor(srv).GET("/api/models/{id}/layers", { params: { path: { id }, query: version ? { version } : {} } }).catch(() => null);
  return (r?.data?.manifest as LayerManifest | null | undefined) ?? null;
}

/** Reading a model records a view in the audit log (NFR-11). */
export function recordView(srv: ServerInfo, id: string): void {
  void fetch(`${srv.base}/api/models/${encodeURIComponent(id)}`).catch(() => undefined);
}

/** The published status, with the check report in the shape the shared loaders write it. */
export type IngestStatus = Omit<Schemas["IngestStatus"], "report" | "job"> & {
  report: CheckReport | null;
  job: (Omit<NonNullable<Schemas["IngestStatus"]["job"]>, "progress"> & { progress: { step?: string } }) | null;
};
const asStatus = (s: Schemas["IngestStatus"]) => s as unknown as IngestStatus;

/** What to make of the files: the upload request without the file list, which comes from the files. */
export type IngestRequest = Omit<paths["/api/ingests"]["post"]["requestBody"]["content"]["application/json"], "files">;

export interface UploadProgress {
  sent: number;
  total: number;
  /** What the server is doing once the bytes are in. */
  step: string;
}

const CHUNK = 8 * 1024 * 1024;

async function part(f: LocalFile, start: number, end: number): Promise<Uint8Array> {
  return f.slice ? f.slice(start, end) : (await f.bytes()).subarray(start, end);
}

/** Sends one file with tus, resuming from the server's offset after a dropped connection. */
async function sendFile(srv: ServerInfo, url: string, f: LocalFile, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const target = `${srv.base}${url}`;
  let offset = 0;
  let failures = 0;
  while (offset < f.size) {
    try {
      const body = await part(f, offset, Math.min(f.size, offset + CHUNK));
      const r = await fetch(target, {
        method: "PATCH",
        signal,
        headers: { "tus-resumable": "1.0.0", "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
        body: body as BodyInit,
      });
      if (r.status === 409) {
        // Out of step (another tab, or a lost answer): ask where the server is.
        offset = await headOffset(target);
        continue;
      }
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Upload failed (${r.status}).`);
      const next = Number(r.headers.get("upload-offset"));
      onBytes(next - offset);
      offset = next;
      failures = 0;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (++failures > 6) throw new Error(`The connection kept dropping while sending ${f.path}.`);
      await new Promise((res) => setTimeout(res, 500 * 2 ** failures));
      const before = offset;
      offset = await headOffset(target).catch(() => offset);
      onBytes(offset - before);
    }
  }
}

async function headOffset(url: string): Promise<number> {
  const r = await fetch(url, { method: "HEAD", headers: { "tus-resumable": "1.0.0" } });
  if (!r.ok) throw new Error(`The server lost this upload (${r.status}).`);
  return Number(r.headers.get("upload-offset"));
}

/** Uploads the files, queues the ingest and waits for the server's result. */
export async function uploadAndIngest(srv: ServerInfo, files: LocalFile[], req: IngestRequest, onProgress: (p: UploadProgress) => void, signal?: AbortSignal): Promise<IngestStatus> {
  const total = files.reduce((s, f) => s + f.size, 0);
  const api = apiFor(srv);
  const created = must(await api.POST("/api/ingests", { body: { ...req, files: files.map((f) => ({ path: f.path, size: f.size })) }, signal }));
  let sent = 0;
  onProgress({ sent, total, step: "upload" });
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const u of created.uploads) {
    await sendFile(srv, u.url, byPath.get(u.path)!, (n) => onProgress({ sent: (sent += n), total, step: "upload" }), signal);
  }
  let status = asStatus(must(await api.POST("/api/ingests/{id}/submit", { params: { path: { id: created.id } }, signal })));
  for (;;) {
    onProgress({ sent: total, total, step: status.job?.progress?.step ?? status.state });
    if (status.state === "ready" || status.state === "failed") return status;
    await new Promise((res) => setTimeout(res, 800));
    status = asStatus(must(await api.GET("/api/ingests/{id}", { params: { path: { id: created.id } }, signal })));
  }
}
