import { rm } from "node:fs/promises";
import path from "node:path";
import { ensureAdminPassword } from "./admin.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { buildApp } from "./app.ts";
import { AuditForwarder } from "./audit-forward.ts";
import { migrate, openPglite, openPostgres } from "./db.ts";
import { ingestHandler } from "./ingest.ts";
import { Worker, type Handler } from "./jobs.ts";
import { chromiumRenderer, thumbnailHandler } from "./thumbnails.ts";
import { PodmanSandbox, probeSandbox, type Sandbox } from "./sandbox.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";

// Settings are checked before anything starts: a wrong one stops the server with its name.
let config: Config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(78); // EX_CONFIG: systemd does not restart a unit that exits with a bad configuration
}
const log = (msg: string, extra?: object, level = 50) => console.error(JSON.stringify({ level, time: Date.now(), msg, ...extra }));
const errInfo = (e: unknown) => (e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : { message: String(e) });

// A fault nothing caught leaves the process in an unknown state: log it and exit, and the
// service manager starts a clean one (jobs in flight are taken up again when their lease ends).
// Registered first, so a fault while starting is caught too.
process.on("unhandledRejection", (e) => {
  log("unhandled promise rejection; exiting", { err: errInfo(e) }, 60);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  log("uncaught exception; exiting", { err: errInfo(e) }, 60);
  process.exit(1);
});
const db = config.databaseUrl
  ? await openPostgres(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, onError: (e) => log("database connection failed; it will reconnect", { err: e.message }) })
  : await openPglite(`${config.dataDir}/db`);
const applied = await migrate(db);
const seeded = await seed(db, { samples: config.seedSamples });
// ADMIN_PASSWORD sets the admin password on first start; ADMIN_PASSWORD_RESET=1 replaces a stored one.
const adminPassword = await ensureAdminPassword(db, config.adminPassword, config.adminPasswordReset);
const storage = new Storage(config.storageDir);
await storage.init();
// The conversion sandbox is checked before the server takes any work: a step must have no
// network and only its work folder to write. One that leaks stops the server (exit 78).
let sandbox: Sandbox | undefined;
if (config.convertSandbox === "podman" && config.workers) {
  const release = new URL("../..", import.meta.url).pathname;
  sandbox = new PodmanSandbox({
    podman: config.podman!,
    rootfs: config.convertRootfs ?? `${release}sandbox/rootfs`,
    stateDir: `${config.dataDir}/sandbox`,
    mounts: config.fbx2gltf ? [path.dirname(config.fbx2gltf)] : [],
    memoryMb: config.convertMemoryMb || undefined,
  });
  const probe = await probeSandbox(sandbox, path.join(storage.ingests, ".sandbox-probe"));
  await rm(path.join(storage.ingests, ".sandbox-probe"), { recursive: true, force: true });
  if (!probe.ok) {
    log(`CONVERT_SANDBOX=podman, but ${probe.problems.join("; ")}. Fix it, or set CONVERT_SANDBOX=none.`, { probe: probe.result }, 60);
    process.exit(78);
  }
  log("conversion sandbox ready: each step runs in a podman container with no network", { probe: probe.result }, 30);
}
const corsOrigins = config.corsOrigins;
// THUMBNAIL_WEB_URL: where the web app is served, on the same origin as /files (WP 3.5).
const renderer = config.thumbnailWebUrl ? chromiumRenderer({ webUrl: config.thumbnailWebUrl, executablePath: config.chromium }) : null;
const thumbnails = !!renderer;
const app = await buildApp({ db, storage, corsOrigins, thumbnails, reverseDns: true, logger: true, writeRateLimit: config.writeRateLimit });
app.log.info({ db: db.kind, migrations: applied, seeded, storage: storage.root, production: config.production }, "database ready");
if (!config.databaseUrl && config.production) app.log.warn("EMBEDDED_DB=1: the embedded database is for a single workstation, not a shared server");

// WORKERS=0 runs the API alone, for a site that runs the workers on another machine.
const worker =
  !config.workers
    ? null
    : new Worker(
        db,
        {
          ingest: ingestHandler(db, storage, { clamdscan: config.clamdscan, fbx2gltf: config.fbx2gltf, thumbnails, strictValidation: config.strictValidation, sandbox }),
          ...(renderer ? { thumbnail: thumbnailHandler(db, storage, renderer) } : {}),
        } as Record<string, Handler>,
        // A job whose worker died goes to another worker (or this one, restarted) when its lease
        // runs out; the lease is renewed every third of it while the job runs.
        { leaseSeconds: config.jobLeaseSeconds, onError: (e, job) => app.log.warn({ err: e, job: job.id }, "job failed") },
      );
if (adminPassword === "missing") app.log.warn("No admin password: set ADMIN_PASSWORD and restart to open the admin page");
if (adminPassword === "kept" && config.adminPassword && !config.adminPasswordReset) app.log.info("ADMIN_PASSWORD is ignored: a password is already stored (ADMIN_PASSWORD_RESET=1 replaces it)");
if (!config.clamdscan) app.log.warn("CLAMDSCAN is not set: uploads are not scanned for viruses");
if (!config.fbx2gltf) app.log.warn("FBX2GLTF is not set: FBX uploads will fail");
if (config.workers && !sandbox && config.production) app.log.warn("CONVERT_SANDBOX is not podman: uploaded files are converted in a child process of the server, not in a container with no network");
if (!renderer) app.log.warn("THUMBNAIL_WEB_URL is not set: library cards use a format icon instead of a thumbnail");
// AUDIT_SYSLOG=udp://siem:514, tcp://siem:514 or tls://siem:6514 sends the audit log to the SIEM as CEF (WP 3.8).
const forwarder = config.auditSyslog
  ? new AuditForwarder(db, config.auditSyslog, { onError: (e) => app.log.warn({ err: e }, "audit log could not reach the SIEM; it will retry") })
  : null;
await app.listen({ host: config.host, port: config.port });
worker?.start();
forwarder?.start();

// Stop taking work, let running requests and the current job step finish, then close. A stuck
// job must not hold the shutdown: after 30 s the process exits anyway (its job lease lets
// another worker take the job up).
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal: sig }, "shutting down");
    setTimeout(() => {
      app.log.error("shutdown took longer than 30 s; exiting");
      process.exit(1);
    }, 30_000).unref();
    void Promise.all([worker?.stop(), forwarder?.stop()])
      .then(() => renderer?.close?.())
      .then(() => app.close())
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (e: unknown) => {
          app.log.error({ err: e }, "shutdown failed");
          process.exit(1);
        },
      );
  });
