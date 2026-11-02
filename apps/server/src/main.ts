import { buildApp } from "./app.ts";
import { migrate, openPglite, openPostgres } from "./db.ts";
import { ingestHandler } from "./ingest.ts";
import { Worker } from "./jobs.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";

// DATABASE_URL=postgres://… in production; without it an embedded PostgreSQL keeps its data in ./data.
const dataDir = process.env.DATA_DIR ?? "./data";
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(`${dataDir}/db`);
const applied = await migrate(db);
const seeded = await seed(db, { samples: process.env.SEED_SAMPLES !== "0" });
const storage = new Storage(process.env.STORAGE_DIR ?? `${dataDir}/storage`);
await storage.init();
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const app = await buildApp({ db, storage, corsOrigins, reverseDns: true, logger: true });
app.log.info({ db: db.kind, migrations: applied, seeded, storage: storage.root }, "database ready");

// WORKERS=0 runs the API alone, for a site that runs the workers on another machine.
const worker =
  process.env.WORKERS === "0"
    ? null
    : new Worker(db, { ingest: ingestHandler(db, storage, { clamdscan: process.env.CLAMDSCAN, fbx2gltf: process.env.FBX2GLTF }) }, { onError: (e, job) => app.log.warn({ err: e, job: job.id }, "job failed") });
if (!process.env.CLAMDSCAN) app.log.warn("CLAMDSCAN is not set: uploads are not scanned for viruses");
if (!process.env.FBX2GLTF) app.log.warn("FBX2GLTF is not set: FBX uploads will fail");
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });
worker?.start();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void (worker?.stop() ?? Promise.resolve())
      .then(() => app.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
