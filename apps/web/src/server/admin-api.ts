import type { BaseMapConfig, ClassificationLevel } from "@viewer/shared";
import { call, type ServerInfo } from "./api";

/**
 * The admin API (WP 3.9). The sign-in token lives in this tab's session storage, so it ends
 * when the tab closes; the server ends it after 8 hours anyway.
 */
const KEY = "viewer.adminToken";

export function savedToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function keep(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private windows can refuse storage; the token then lasts until the page reloads.
  }
}

export interface StorageInfo {
  publishedBytes: number;
  uploadingBytes: number;
  usedBytes: number;
  models: number;
  versions: number;
  quotaBytes: number | null;
  disk: { freeBytes: number; totalBytes: number } | null;
}

export interface AuditEntry {
  seq: number;
  at: string;
  ip: string;
  host: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  hash: string;
}

export class AdminApi {
  constructor(
    readonly srv: ServerInfo,
    private token: string | null = savedToken(),
  ) {}

  private as<T>(path: string, init: RequestInit = {}): Promise<T> {
    return call<T>(this.srv, path, { ...init, headers: { ...(init.headers as Record<string, string>), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) } });
  }
  private json<T>(method: string, path: string, body: unknown): Promise<T> {
    return this.as<T>(path, { method, body: JSON.stringify(body) });
  }

  status(): Promise<{ passwordSet: boolean; signedIn: boolean }> {
    return this.as("/api/admin/status");
  }
  async login(password: string): Promise<void> {
    const r = await call<{ token: string }>(this.srv, "/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
    this.token = r.token;
    keep(r.token);
  }
  async logout(): Promise<void> {
    await this.as("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    this.token = null;
    keep(null);
  }
  changePassword(current: string, next: string): Promise<unknown> {
    return this.json("POST", "/api/admin/password", { current, next });
  }

  saveLevel(l: ClassificationLevel): Promise<ClassificationLevel & { thumbnailsQueued: number }> {
    return this.json("PUT", `/api/admin/classifications/${encodeURIComponent(l.id)}`, { label: l.label, color: l.color, textColor: l.textColor, order: l.order });
  }
  removeLevel(id: string): Promise<unknown> {
    return this.as(`/api/admin/classifications/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  deleteModel(id: string, confirm: string): Promise<{ name: string; versions: number; bytes: number }> {
    return this.json("DELETE", `/api/admin/models/${encodeURIComponent(id)}`, { confirm });
  }

  storage(): Promise<StorageInfo> {
    return this.as("/api/admin/storage");
  }
  setQuota(quotaBytes: number | null): Promise<unknown> {
    return this.json("PUT", "/api/admin/storage", { quotaBytes });
  }

  saveBaseMaps(cfg: BaseMapConfig): Promise<BaseMapConfig> {
    return this.json("PUT", "/api/admin/basemaps", cfg);
  }

  audit(q: { action?: string; from?: string; to?: string; target?: string; limit?: number }): Promise<AuditEntry[]> {
    return this.as(`/api/audit?${query(q)}`);
  }
  async auditCsv(q: { action?: string; from?: string; to?: string; target?: string }): Promise<string> {
    const r = await fetch(`${this.srv.base}/api/audit.csv?${query({ ...q, limit: 100000 })}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!r.ok) throw new Error(`The server answered ${r.status}.`);
    return (await r.text()).replace(/^﻿/, "");
  }
  verifyAudit(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    return this.as("/api/audit/verify");
  }
}

function query(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}
