import { buildApp } from "./app.ts";
import { migrate, openPglite, openPostgres } from "./db.ts";
import { seed } from "./seed.ts";

// DATABASE_URL=postgres://… in production; without it an embedded PostgreSQL keeps its data in ./data.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(process.env.DATA_DIR ?? "./data");
const applied = await migrate(db);
const seeded = await seed(db, { samples: process.env.SEED_SAMPLES !== "0" });
const app = await buildApp({ db, reverseDns: true, logger: true });
app.log.info({ db: db.kind, migrations: applied, seeded }, "database ready");
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void app.close().then(() => db.close()).then(() => process.exit(0));
  });
