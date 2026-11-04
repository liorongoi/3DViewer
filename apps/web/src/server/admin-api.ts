import type { BaseMapConfig, ClassificationLevel } from "@viewer/shared";
import { createApiClient, must, type ApiClient, type paths, type Schemas } from "@viewer/api-client";
import type { ServerInfo } from "./api";

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

export type StorageInfo = paths["/api/admin/storage"]["get"]["responses"][200]["content"]["application/json"];
export type AuditEntry = Schemas["AuditEvent"];
type AuditQuery = NonNullable<paths["/api/audit"]["get"]["parameters"]["query"]>;

export class AdminApi {
  private readonly api: ApiClient;
  constructor(
    readonly srv: ServerInfo,
    private token: string | null = savedToken(),
  ) {
    // Its own client, so the sign-in token goes only on admin calls.
    this.api = createApiClient(srv.base);
    this.api.use({
      onRequest: ({ request }) => {
        if (this.token) request.headers.set("authorization", `Bearer ${this.token}`);
        return request;
      },
    });
  }

  async status() {
    return must(await this.api.GET("/api/admin/status"));
  }
  async login(password: string): Promise<void> {
    const r = must(await this.api.POST("/api/admin/login", { body: { password } }));
    this.token = r.token;
    keep(r.token);
  }
  async logout(): Promise<void> {
    await this.api.POST("/api/admin/logout").catch(() => undefined);
    this.token = null;
    keep(null);
  }
  async changePassword(current: string, next: string) {
    return must(await this.api.POST("/api/admin/password", { body: { current, next } }));
  }

  async saveLevel(l: ClassificationLevel) {
    return must(await this.api.PUT("/api/admin/classifications/{id}", { params: { path: { id: l.id } }, body: { label: l.label, color: l.color, textColor: l.textColor, order: l.order } }));
  }
  async removeLevel(id: string) {
    return must(await this.api.DELETE("/api/admin/classifications/{id}", { params: { path: { id } } }));
  }

  async deleteModel(id: string, confirm: string) {
    return must(await this.api.DELETE("/api/admin/models/{id}", { params: { path: { id } }, body: { confirm } }));
  }

  async storage(): Promise<StorageInfo> {
    return must(await this.api.GET("/api/admin/storage"));
  }
  async setQuota(quotaBytes: number | null) {
    return must(await this.api.PUT("/api/admin/storage", { body: { quotaBytes } }));
  }

  async saveBaseMaps(cfg: BaseMapConfig): Promise<BaseMapConfig> {
    return must(await this.api.PUT("/api/admin/basemaps", { body: cfg }));
  }

  async audit(q: AuditQuery): Promise<AuditEntry[]> {
    return must(await this.api.GET("/api/audit", { params: { query: clean(q) } }));
  }
  async auditCsv(q: Omit<AuditQuery, "limit">): Promise<string> {
    const r = must(await this.api.GET("/api/audit.csv", { params: { query: clean({ ...q, limit: 100000 }) }, parseAs: "text" }));
    return r.replace(/^\uFEFF/, "");
  }
  async verifyAudit() {
    return must(await this.api.GET("/api/audit/verify"));
  }
}

/** Empty filter fields are left out rather than sent as "". */
function clean<T extends Record<string, string | number | undefined>>(q: T): T {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "")) as T;
}
