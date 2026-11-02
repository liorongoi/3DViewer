import { createHash } from "node:crypto";
import type { Db, Queryable } from "./db.ts";

/** WP 3.8: every action is appended with time, IP and workstation, and chained by SHA-256 so edits show. */
export interface AuditInput {
  ip: string;
  host: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  seq: string;
  at: string;
  ip: string;
  host: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

/** Keys sorted, so the hash does not depend on how the database returns JSON. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function hashEvent(prev: string, e: { at: string; ip: string; host: string; action: string; target: string; detail: unknown }): string {
  return createHash("sha256").update([prev, e.at, e.ip, e.host, e.action, e.target, canonical(e.detail)].join("\n")).digest("hex");
}

/** Appends one event. Callers inside a transaction pass it, so the event and the change commit together. */
export async function audit(db: Db | Queryable, e: AuditInput): Promise<void> {
  const write = async (q: Queryable) => {
    // One writer at a time, so two requests never chain onto the same previous hash.
    await q.query("SELECT pg_advisory_xact_lock(8221)");
    const [last] = await q.query<{ hash: string }>("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
    const prev = last?.hash ?? GENESIS;
    // Hash exactly what is stored: a JSON round trip drops undefined fields, as the database does.
    const detail = JSON.parse(JSON.stringify(e.detail ?? {})) as Record<string, unknown>;
    const row = { at: new Date().toISOString(), ip: e.ip, host: e.host, action: e.action, target: e.target ?? "", detail };
    await q.query("INSERT INTO audit_events (at, ip, host, action, target, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      row.at,
      row.ip,
      row.host,
      row.action,
      row.target,
      JSON.stringify(row.detail),
      prev,
      hashEvent(prev, row),
    ]);
  };
  if ("tx" in db) await db.tx(write);
  else await write(db);
}

/** Recomputes the chain. Returns the first broken sequence number, if any. */
export async function verifyAudit(db: Queryable): Promise<{ ok: boolean; count: number; brokenAt?: string }> {
  const rows = await db.query<Omit<AuditRow, "at"> & { at: Date | string }>("SELECT * FROM audit_events ORDER BY seq");
  let prev = GENESIS;
  for (const r of rows) {
    const at = r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString();
    if (r.prev_hash !== prev || hashEvent(prev, { ...r, at }) !== r.hash) return { ok: false, count: rows.length, brokenAt: String(r.seq) };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

const csvCell = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(rows: AuditRow[]): string {
  const head = ["seq", "at", "ip", "host", "action", "target", "detail", "hash"];
  return [head.join(","), ...rows.map((r) => [r.seq, new Date(r.at).toISOString(), r.ip, r.host, r.action, r.target, r.detail, r.hash].map(csvCell).join(","))].join("\n") + "\n";
}
