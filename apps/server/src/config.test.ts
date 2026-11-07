import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const problems = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
};

describe("server settings", () => {
  it("has working defaults for a workstation", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ production: false, databaseUrl: null, port: 8787, host: "127.0.0.1", seedSamples: true, workers: true, jobLeaseSeconds: 300, writeRateLimit: 600, dbStatementTimeoutMs: 60_000, storageDir: "./data/storage" });
  });

  it("names every wrong setting at once", () => {
    const p = problems({ PORT: "80a", JOB_LEASE_SECONDS: "abc", WORKERS: "maybe", NODE_ENV: "prod", DATABASE_URL: "mysql://u:secret@h/db", AUDIT_SYSLOG: "udp://siem", CORS_ORIGINS: "viewer.internal", ADMIN_PASSWORD: "short", CLAMDSCAN: "/no/such/clamdscan" });
    expect(p).toHaveLength(9);
    for (const k of ["PORT", "JOB_LEASE_SECONDS", "WORKERS", "NODE_ENV", "DATABASE_URL", "AUDIT_SYSLOG", "CORS_ORIGINS", "ADMIN_PASSWORD", "CLAMDSCAN"]) expect(p.some((m) => m.includes(k))).toBe(true);
    // The database password never appears in a message.
    expect(p.join("\n")).not.toContain("secret");
  });

  it("refuses out-of-range numbers", () => {
    expect(problems({ PORT: "70000" })).toHaveLength(1);
    expect(problems({ JOB_LEASE_SECONDS: "5" })).toHaveLength(1);
    expect(problems({ DB_STATEMENT_TIMEOUT_MS: "-1" })).toHaveLength(1);
    expect(loadConfig({ WRITE_RATE_LIMIT: "0" }).writeRateLimit).toBe(0);
  });

  it("in production needs a real database and named origins, and leaves samples off", () => {
    const p = problems({ NODE_ENV: "production", CORS_ORIGINS: "*" });
    expect(p.some((m) => m.includes("DATABASE_URL is required"))).toBe(true);
    expect(p.some((m) => m.includes('CORS_ORIGINS="*"'))).toBe(true);
    const c = loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://viewer:pw@db/viewer", CORS_ORIGINS: "https://viewer.internal, viewer-file://app" });
    expect(c).toMatchObject({ production: true, seedSamples: false, corsOrigins: ["https://viewer.internal", "viewer-file://app"] });
    expect(loadConfig({ NODE_ENV: "production", EMBEDDED_DB: "1" }).databaseUrl).toBeNull();
  });
});
