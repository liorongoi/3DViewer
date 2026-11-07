/**
 * Production gap 6: deploy/bin/viewer-backup and viewer-restore put back the database and the
 * published files exactly, and keep what they replaced.
 *
 * The embedded-database case always runs; the PostgreSQL case runs where TEST_DATABASE_URL and
 * pg_dump are available (CI), on a database of its own.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { audit, verifyAudit } from "./audit.ts";
import { migrate, openPglite, openPostgres, type Db } from "./db.ts";
import { seed } from "./seed.ts";

const bin = fileURLToPath(new URL("../../../deploy/bin/", import.meta.url));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(extra: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "viewer-backup-"));
  dirs.push(root);
  const data = path.join(root, "data");
  const storage = path.join(data, "storage");
  mkdirSync(path.join(storage, "files", "m1", "v1"), { recursive: true });
  writeFileSync(path.join(storage, "files", "m1", "v1", "model.glb"), "first model");
  const env = path.join(root, "viewer.env");
  // A port nothing listens on, so the "is the server running" check says no.
  writeFileSync(env, Object.entries({ DATA_DIR: data, STORAGE_DIR: storage, PORT: "1", ...extra }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync(path.join(bin, script), args, { env: { PATH: process.env.PATH, VIEWER_ENV: env, KEEP: "2" }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${script} failed (${r.status}): ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  return { root, data, storage, run, backups: path.join(root, "backups") };
}

const files = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort() : [];

async function fill(db: Db) {
  await migrate(db);
  await seed(db, { samples: true });
  await audit(db, { ip: "10.0.0.7", host: "ANALYST-07", action: "model.view", target: "m1", detail: {} });
}
async function state(db: Db) {
  const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
  const models = await count("models");
  const events = await count("audit_events");
  return { models, events, chain: (await verifyAudit(db)).ok };
}

describe("backup and restore", () => {
  it("embedded database: puts back the database and files, and keeps what it replaced", async () => {
    const s = setup({ EMBEDDED_DB: "1" });
    let db = await openPglite(path.join(s.data, "db"));
    await fill(db);
    const before = await state(db);
    await db.close();

    const backup = s.run("viewer-backup", s.backups);
    expect(readdirSync(backup).sort()).toEqual(["MANIFEST", "database.tar", "files.tar"]);

    // Work goes on after the backup: a new event, a new file, a file lost.
    db = await openPglite(path.join(s.data, "db"));
    await audit(db, { ip: "10.0.0.8", host: "ANALYST-08", action: "model.view", target: "m2", detail: {} });
    await db.close();
    writeFileSync(path.join(s.storage, "files", "m1", "v1", "extra.bin"), "later");
    rmSync(path.join(s.storage, "files", "m1", "v1", "model.glb"));

    s.run("viewer-restore", backup, "--yes");
    db = await openPglite(path.join(s.data, "db"));
    expect(await state(db)).toEqual(before);
    await db.close();
    expect(files(path.join(s.storage, "files"))).toEqual(["m1/v1/model.glb"]);
    expect(readFileSync(path.join(s.storage, "files", "m1", "v1", "model.glb"), "utf8")).toBe("first model");
    const kept = readdirSync(s.backups).find((d) => d.startsWith("before-restore-"))!;
    expect(files(path.join(s.backups, kept, "files"))).toEqual(["m1/v1/extra.bin"]);
  });

  it("refuses a damaged backup", () => {
    const s = setup({ EMBEDDED_DB: "1" });
    mkdirSync(path.join(s.data, "db"), { recursive: true });
    const backup = s.run("viewer-backup", s.backups);
    writeFileSync(path.join(backup, "files.tar"), "damaged");
    expect(() => s.run("viewer-restore", backup, "--yes")).toThrow(/does not match its MANIFEST/);
    expect(() => s.run("viewer-restore", backup)).toThrow(/Usage/);
  });

  it("keeps the newest KEEP backups", () => {
    const s = setup({ EMBEDDED_DB: "1" });
    mkdirSync(path.join(s.data, "db"), { recursive: true });
    const made = [0, 1, 2].map(() => (execFileSync("sleep", ["1.1"]), s.run("viewer-backup", s.backups)));
    expect(readdirSync(s.backups).sort()).toEqual(made.slice(1).map((d) => path.basename(d)));
  });

  const url = process.env.TEST_DATABASE_URL;
  const hasPgDump = spawnSync("pg_dump", ["--version"]).status === 0;
  it.skipIf(!url || !hasPgDump)("PostgreSQL: puts back the database, audit chain included", async () => {
    const name = `viewer_restore_${process.pid}`;
    const admin = await openPostgres(url!);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const dbUrl = Object.assign(new URL(url!), { pathname: `/${name}` }).href;
    try {
      const s = setup({ DATABASE_URL: dbUrl });
      let db = await openPostgres(dbUrl);
      await fill(db);
      const before = await state(db);
      const backup = s.run("viewer-backup", s.backups);
      expect(readdirSync(backup).sort()).toEqual(["MANIFEST", "database.dump", "files.tar"]);
      await audit(db, { ip: "10.0.0.8", host: "ANALYST-08", action: "model.view", target: "m2", detail: {} });
      await db.query("DELETE FROM models WHERE id = (SELECT id FROM models LIMIT 1)").catch(() => undefined);
      await db.close();

      s.run("viewer-restore", backup, "--yes");
      db = await openPostgres(dbUrl);
      expect(await state(db)).toEqual(before);
      // The audit log still refuses changes after a restore.
      await expect(db.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
      await db.close();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    }
  }, 60_000);
});
