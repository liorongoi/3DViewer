import type { CheckReport, LocalFile } from "@viewer/core";
import type { ModelSummary } from "@viewer/shared";

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

async function call<T>(srv: ServerInfo, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = init?.body ? { "content-type": "application/json" } : {};
  const r = await fetch(`${srv.base}${path}`, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } });
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `The server answered ${r.status}.`);
  return body as T;
}

/** Published file URLs are relative to the server ("files/…"); the engine needs them absolute. */
function absolute(srv: ServerInfo, m: ModelSummary): ModelSummary {
  return /^[a-z]+:/i.test(m.source.url) ? m : { ...m, source: { ...m.source, url: `${srv.base}/${m.source.url}` } };
}

export async function listModels(srv: ServerInfo): Promise<ModelSummary[]> {
  return (await call<ModelSummary[]>(srv, "/api/models")).map((m) => absolute(srv, m));
}

/** Reading a model records a view in the audit log (NFR-11). */
export function recordView(srv: ServerInfo, id: string): void {
  void fetch(`${srv.base}/api/models/${encodeURIComponent(id)}`).catch(() => undefined);
}

export interface IngestStatus {
  id: string;
  state: "uploading" | "queued" | "checking" | "converting" | "ready" | "failed";
  modelId: string | null;
  version: number | null;
  report: CheckReport | null;
  error: string | null;
  upload: { files: number; bytes: number; received: number };
  job: { state: string; progress: { step?: string }; attempts: number; error: string | null } | null;
}

export interface IngestRequest {
  modelId?: string;
  model?: { name: string; project?: string; operation?: string; responsibleEntity?: string; description?: string; status: string; classificationId: string };
  placement?: ModelSummary["placement"];
  centre?: { lat: number; lon: number };
  groundFit?: "street" | "surface" | "none";
  note?: string;
}

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
  const created = await call<{ id: string; uploads: { path: string; url: string }[] }>(srv, "/api/ingests", {
    method: "POST",
    body: JSON.stringify({ ...req, files: files.map((f) => ({ path: f.path, size: f.size })) }),
    signal,
  });
  let sent = 0;
  onProgress({ sent, total, step: "upload" });
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const u of created.uploads) {
    await sendFile(srv, u.url, byPath.get(u.path)!, (n) => onProgress({ sent: (sent += n), total, step: "upload" }), signal);
  }
  let status = await call<IngestStatus>(srv, `/api/ingests/${created.id}/submit`, { method: "POST", signal });
  for (;;) {
    onProgress({ sent: total, total, step: status.job?.progress?.step ?? status.state });
    if (status.state === "ready" || status.state === "failed") return status;
    await new Promise((res) => setTimeout(res, 800));
    status = await call<IngestStatus>(srv, `/api/ingests/${created.id}`, { signal });
  }
}
