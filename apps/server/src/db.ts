import m001 from "./migrations/001_init.sql?raw";
import m002 from "./migrations/002_ingest.sql?raw";
import m003 from "./migrations/003_thumbnails.sql?raw";
import m004 from "./migrations/004_admin.sql?raw";

/** Migrations in order. Bundled into the build, so the server is one file plus node_modules. */
export const MIGRATIONS: [string, string][] = [
  ["001_init.sql", m001],
  ["002_ingest.sql", m002],
  ["003_thumbnails.sql", m003],
  ["004_admin.sql", m004],
];

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** The database the server talks to: PostgreSQL in production, embedded PGlite for development and tests. */
export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Embedded PostgreSQL (PGlite). No data dir means in memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // PGlite creates only the last folder; a fresh DATA_DIR needs its parents too.
  if (dataDir) await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const q: Queryable = { query: async <T>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params as never[])).rows };
  return {
    kind: "pglite",
    query: q.query,
    tx: (fn) => pg.transaction((t) => fn({ query: async <T>(sql: string, params?: unknown[]) => (await t.query<T>(sql, params as never[])).rows })),
    exec: async (sql) => void (await pg.exec(sql)),
    close: () => pg.close(),
  };
}

export async function openPostgres(url: string): Promise<Db> {
  const { default: pgmod } = await import("pg");
  const pool = new pgmod.Pool({ connectionString: url, max: 10 });
  await pool.query("SELECT 1");
  return {
    kind: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[],
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn({ query: async <T>(sql: string, params?: unknown[]) => (await c.query(sql, params)).rows as T[] });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

/** Applies each migration once, in order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const [f, sql] of MIGRATIONS) {
    if (done.has(f)) continue;
    await db.tx(async (q) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s))) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}
