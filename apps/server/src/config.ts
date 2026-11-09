import { accessSync, constants } from "node:fs";
import { MIN_PASSWORD } from "./admin.ts";

/**
 * The server's settings, read from the environment once at start (docs/OPERATIONS.md lists
 * them). Every value is checked: a wrong one stops the server with a message that names the
 * setting, rather than starting it with a half-working configuration.
 */
export interface Config {
  production: boolean;
  /** PostgreSQL connection string; null runs the embedded database in `dataDir/db`. */
  databaseUrl: string | null;
  dataDir: string;
  storageDir: string;
  host: string;
  port: number;
  seedSamples: boolean;
  adminPassword: string | undefined;
  adminPasswordReset: boolean;
  corsOrigins: string[];
  /** Where the web app is served, for thumbnails (WP 3.5); null turns them off. */
  thumbnailWebUrl: string | null;
  chromium: string | undefined;
  /** Run the job workers in this process (WORKERS=0 for an API-only machine). */
  workers: boolean;
  clamdscan: string | undefined;
  fbx2gltf: string | undefined;
  /** Where uploaded files are converted, validated and tiled: "podman" (a container per step, no network) or "none". */
  convertSandbox: "none" | "podman";
  podman: string | undefined;
  /** The sandbox's root (the C libraries only); default: sandbox/rootfs in the installed release. */
  convertRootfs: string | undefined;
  /** Memory limit for one step, in MB (needs cgroup delegation); 0 for none. */
  convertMemoryMb: number;
  strictValidation: boolean;
  jobLeaseSeconds: number;
  auditSyslog: string | null;
  /** Write requests (POST, PUT, PATCH, DELETE) one address may make per minute; 0 turns the limit off. */
  writeRateLimit: number;
  /** Longest a single database statement may run, in milliseconds. */
  dbStatementTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The server's settings are not valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

/** Reads and checks the settings. Throws ConfigError listing every problem at once. */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const get = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const bool = (k: string, dflt: boolean): boolean => {
    const v = get(k)?.toLowerCase();
    if (v === undefined) return dflt;
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    problems.push(`${k} must be 1 or 0 (it is "${env[k]}").`);
    return dflt;
  };
  const int = (k: string, dflt: number, min: number, max: number): number => {
    const v = get(k);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < min || n > max) {
      problems.push(`${k} must be a whole number from ${min} to ${max} (it is "${env[k]}").`);
      return dflt;
    }
    return n;
  };
  const url = (k: string, schemes: string[]): string | null => {
    const v = get(k);
    if (v === undefined) return null;
    try {
      const u = new URL(v);
      if (!schemes.includes(u.protocol.replace(/:$/, ""))) throw new Error();
      if (!u.hostname) throw new Error();
      return v;
    } catch {
      problems.push(`${k} must be a ${schemes.join(" or ")} address such as ${schemes[0]}://host${schemes[0]!.startsWith("postgres") ? "/viewer" : ""} (it is "${redact(v)}").`);
      return null;
    }
  };
  const program = (k: string): string | undefined => {
    const v = get(k);
    if (v === undefined) return undefined;
    try {
      accessSync(v, constants.X_OK);
    } catch {
      problems.push(`${k} must be the path of a program this server can run (${v} is missing or not executable).`);
    }
    return v;
  };

  const nodeEnv = get("NODE_ENV");
  const production = nodeEnv === "production";
  const databaseUrl = url("DATABASE_URL", ["postgres", "postgresql"]);
  const embedded = bool("EMBEDDED_DB", false);
  if (production && !databaseUrl && !get("DATABASE_URL") && !embedded)
    problems.push("DATABASE_URL is required in production (postgres://user:password@host/viewer). EMBEDDED_DB=1 allows the embedded database, for a single workstation only.");
  const dataDir = get("DATA_DIR") ?? "./data";
  const thumbnailWebUrl = url("THUMBNAIL_WEB_URL", ["https", "http"]);
  const auditSyslog = url("AUDIT_SYSLOG", ["udp", "tcp", "tls"]);
  if (auditSyslog && !new URL(auditSyslog).port) problems.push(`AUDIT_SYSLOG must include the port, such as udp://siem:514 (it is "${auditSyslog}").`);
  const corsOrigins = (get("CORS_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of corsOrigins) if (o !== "*" && !/^(https?|viewer-file):\/\/[^/\s]+$/.test(o)) problems.push(`CORS_ORIGINS has "${o}", which is not an origin such as https://viewer.internal.`);
  if (production && corsOrigins.includes("*")) problems.push('CORS_ORIGINS="*" lets any web page call the API; name the origins instead in production.');
  const adminPassword = get("ADMIN_PASSWORD");
  if (adminPassword !== undefined && adminPassword.length < MIN_PASSWORD) problems.push(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.`);

  const config: Config = {
    production,
    databaseUrl,
    dataDir,
    storageDir: get("STORAGE_DIR") ?? `${dataDir}/storage`,
    host: get("HOST") ?? "127.0.0.1",
    port: int("PORT", 8787, 1, 65535),
    // The sample library is for demonstrations and tests, never a site's real library.
    seedSamples: bool("SEED_SAMPLES", !production),
    adminPassword,
    adminPasswordReset: bool("ADMIN_PASSWORD_RESET", false),
    corsOrigins,
    thumbnailWebUrl,
    chromium: get("CHROMIUM"),
    workers: bool("WORKERS", true),
    clamdscan: program("CLAMDSCAN"),
    fbx2gltf: program("FBX2GLTF"),
    convertSandbox: "none",
    podman: undefined,
    convertRootfs: get("CONVERT_ROOTFS"),
    convertMemoryMb: int("CONVERT_MEMORY_MB", 0, 0, 1_000_000),
    strictValidation: bool("STRICT_VALIDATION", false),
    jobLeaseSeconds: int("JOB_LEASE_SECONDS", 300, 10, 86_400),
    auditSyslog,
    writeRateLimit: int("WRITE_RATE_LIMIT", 600, 0, 1_000_000),
    dbStatementTimeoutMs: int("DB_STATEMENT_TIMEOUT_MS", 60_000, 1000, 3_600_000),
  };
  const sandbox = get("CONVERT_SANDBOX")?.toLowerCase() ?? "none";
  if (sandbox === "podman") {
    config.convertSandbox = "podman";
    config.podman = program("PODMAN") ?? "/usr/bin/podman";
    if (!get("PODMAN")) {
      try {
        accessSync(config.podman, constants.X_OK);
      } catch {
        problems.push("CONVERT_SANDBOX=podman needs podman: install it, or set PODMAN to its path.");
      }
    }
  } else if (sandbox !== "none") problems.push(`CONVERT_SANDBOX must be podman or none (it is "${env.CONVERT_SANDBOX}").`);
  if (nodeEnv !== undefined && !["production", "development", "test"].includes(nodeEnv)) problems.push(`NODE_ENV must be production, development or test (it is "${nodeEnv}").`);
  if (problems.length) throw new ConfigError(problems);
  return config;
}

/** A connection string without its password, for messages. */
function redact(v: string): string {
  return v.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}
