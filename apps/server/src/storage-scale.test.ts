import { mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAdminPassword } from "./admin.ts";
import { buildApp } from "./app.ts";
import { migrate, openPglite, openPostgres, type Db } from "./db.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";

/**
 * WP 6.3, NFR-06: the library holds at least 10 TB and 5,000 versions. Synthetic data: 1,000 models
 * of 5 versions and one of 250, 1 to 3 GB a version, over 10 TB in all, with Hebrew and English
 * metadata. The files themselves are not written (only their records), except one model's, as
 * sparse files, to check that deleting removes them.
 *
 * At that size the library list, a search, opening a model with its history, the storage page, a new
 * version, the quota and a permanent delete must all work and answer within the time a person
 * waits without noticing. On PostgreSQL where TEST_DATABASE_URL is set (CI), else PGlite.
 */

const MODELS = 1000;
const PER_MODEL = 5;
const LONG = 250;
const GB = 1e9;
const PASSWORD = "storage-scale admin password";

let db: Db;
let app: FastifyInstance;
let storage: Storage;
let dir: string;
let auth: Record<string, string>;
let expectedBytes = 0;
const timings: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-scale-"));
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const a = await openPostgres(url);
    await a.exec("DROP SCHEMA IF EXISTS scale_test CASCADE; CREATE SCHEMA scale_test");
    await a.close();
    db = await openPostgres(`${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=scale_test")}`);
  } else db = await openPglite();
  await migrate(db);
  await seed(db, { samples: true });
  await ensureAdminPassword(db, PASSWORD);
  storage = new Storage(dir);
  await storage.init();
  app = await buildApp({ db, storage });
  auth = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } })).json().token}` };

  const [sample] = await db.query<{ source: unknown; placement: unknown; classification_id: string }>(
    "SELECT v.source, v.placement, m.classification_id FROM versions v JOIN models m ON m.id = v.model_id WHERE m.source_format = 'glb' LIMIT 1",
  );
  const source = JSON.stringify(sample!.source);
  const placement = JSON.stringify(sample!.placement);
  // 1,000 models: 20 projects, 12 operations, 8 responsible entities, every status.
  await db.query(
    `INSERT INTO models (id, name, project, operation, responsible_entity, description, status, classification_id, source_format, centre_lat, centre_lon, current_version, updated_at)
     SELECT 'synth-' || lpad(g::text, 4, '0'),
            CASE WHEN g % 2 = 0 THEN 'מבנה ' || g || ' · גבעה ' || (g % 37) ELSE 'Site ' || g || ' block ' || chr(65 + g % 26) END,
            'פרויקט ' || (g % 20), 'Operation ' || (g % 12), 'יחידה ' || (g % 8),
            'Synthetic model ' || g || ' for the storage test',
            (ARRAY['draft','inProduction','current','superseded'])[1 + g % 4], $1, 'glb',
            31 + (g % 100) / 100.0, 34 + (g % 100) / 100.0, $2, now() - (g || ' minutes')::interval
     FROM generate_series(1, $3::int) g`,
    [sample!.classification_id, PER_MODEL, MODELS],
  );
  // About 2 GB a version, between 1 and 3 GB.
  await db.query(
    `INSERT INTO versions (model_id, version, source, placement, size_bytes, note, created_at)
     SELECT 'synth-' || lpad(g::text, 4, '0'), v, $1::jsonb, $2::jsonb, (1e9 + ((g * 7 + v * 13) % 2000) * 1e6)::bigint, 'v' || v, now() - ((g + 10 * (5 - v)) || ' hours')::interval
     FROM generate_series(1, $3::int) g, generate_series(1, $4::int) v`,
    [source, placement, MODELS, PER_MODEL],
  );
  await db.query(
    `INSERT INTO models (id, name, project, operation, responsible_entity, status, classification_id, source_format, centre_lat, centre_lon, current_version)
     VALUES ('synth-long', 'בסיס ארוך · Long history', 'פרויקט 1', 'Operation 1', 'יחידה 1', 'current', $1, 'glb', 31.5, 34.8, $2)`,
    [sample!.classification_id, LONG],
  );
  await db.query(
    `INSERT INTO versions (model_id, version, source, placement, size_bytes, note)
     SELECT 'synth-long', v, $1::jsonb, $2::jsonb, 2000000000, 'v' || v FROM generate_series(1, $3::int) v`,
    [source, placement, LONG],
  );
  // One model's files, as sparse files of their full size: deleting it must remove them.
  const files = path.join(storage.files, "synth-0001");
  await mkdir(files, { recursive: true });
  for (let v = 1; v <= PER_MODEL; v++) {
    const f = await open(path.join(files, `v${v}.glb`), "w");
    await f.truncate(2 * GB);
    await f.close();
  }
  const [s] = await db.query<{ b: string }>("SELECT sum(size_bytes)::text AS b FROM versions");
  expectedBytes = Number(s!.b);
}, 300_000);

afterAll(async () => {
  console.log(`Storage test, ${process.env.TEST_DATABASE_URL ? "PostgreSQL" : "PGlite"}:\n  ${timings.join("\n  ")}`);
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** A request, timed against what a person waits without noticing. */
async function timed(what: string, budgetMs: number, req: InjectOptions) {
  await app.inject(req); // the first run warms caches and the query plan
  const t = performance.now();
  const res = await app.inject(req);
  const ms = performance.now() - t;
  timings.push(`${what}: ${ms.toFixed(0)} ms (budget ${budgetMs} ms)`);
  expect(res.statusCode, res.body.slice(0, 300)).toBeLessThan(300);
  expect(ms, `${what} took ${ms.toFixed(0)} ms`).toBeLessThan(budgetMs);
  return res;
}

describe("a library of 10 TB and 5,000 versions (NFR-06)", () => {
  it("holds them", async () => {
    const [n] = await db.query<{ v: number; m: number }>("SELECT count(*)::int AS v, count(DISTINCT model_id)::int AS m FROM versions");
    expect(n!.v).toBeGreaterThanOrEqual(5000);
    expect(expectedBytes).toBeGreaterThanOrEqual(10e12);
  });

  it("lists every model", async () => {
    const res = await timed("library list, all models", 1500, { method: "GET", url: "/api/models" });
    const list = res.json() as { id: string; versions: number }[];
    expect(list.length).toBeGreaterThan(MODELS);
    expect(list.find((m) => m.id === "synth-long")!.versions).toBe(LONG);
    timings.push(`  (${list.length} models, ${(res.body.length / 1e6).toFixed(1)} MB)`);
  });

  it("searches and filters", async () => {
    const res = await timed("search in Hebrew", 800, { method: "GET", url: `/api/models?q=${encodeURIComponent("גבעה 12")}` });
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
    const f = await timed("filter by project and status", 800, { method: "GET", url: `/api/models?project=${encodeURIComponent("פרויקט 3")}&status=current` });
    expect((f.json() as { project: string }[]).every((m) => m.project === "פרויקט 3")).toBe(true);
  });

  it("opens a model with 250 versions, with its history, and an early version", async () => {
    const res = await timed("open a model and its history", 300, { method: "GET", url: "/api/models/synth-long" });
    expect((res.json() as { history: unknown[] }).history).toHaveLength(LONG);
    await timed("open version 3 of it", 300, { method: "GET", url: "/api/models/synth-long?version=3" });
  });

  it("adds a version to it", async () => {
    const [v] = await db.query<{ source: unknown }>("SELECT source FROM versions WHERE model_id = 'synth-long' AND version = 1");
    const t = performance.now();
    const res = await app.inject({ method: "POST", url: "/api/models/synth-long/versions", payload: { source: v!.source, sizeBytes: 2 * GB, note: "storage test" } });
    const ms = performance.now() - t;
    timings.push(`add a version: ${ms.toFixed(0)} ms (budget 500 ms)`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().version).toBe(LONG + 1);
    expect(ms).toBeLessThan(500);
    expectedBytes += 2 * GB;
  });

  it("reports the storage used, exactly", async () => {
    const res = await timed("storage page", 500, { method: "GET", url: "/api/admin/storage", headers: auth });
    const s = res.json() as { publishedBytes: number; versions: number; models: number };
    expect(s.publishedBytes).toBe(expectedBytes);
    expect(s.versions).toBeGreaterThanOrEqual(5000 + LONG);
    timings.push(`  (${(s.publishedBytes / 1e12).toFixed(2)} TB in ${s.versions} versions of ${s.models} models)`);
  });

  it("refuses an upload past the quota and takes it once the quota is raised", async () => {
    // The quota 1 GB above what is used: a 1.9 GB upload no longer fits.
    await app.inject({ method: "PUT", url: "/api/admin/storage", headers: auth, payload: { quotaBytes: expectedBytes + 1e9 } });
    const big = { files: [{ path: "big.glb", size: 1.9e9 }], model: { name: "Too big", status: "draft", classificationId: "unclassified" }, placement: { lat: 32, lon: 34.8, height: 0, aboveGround: 0 } };
    const full = await app.inject({ method: "POST", url: "/api/ingests", payload: big });
    expect(full.statusCode).toBe(507);
    expect(full.json().key).toBe("libraryFull");
    await app.inject({ method: "PUT", url: "/api/admin/storage", headers: auth, payload: { quotaBytes: 20e12 } });
    const ok = await app.inject({ method: "POST", url: "/api/ingests", payload: big });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("deletes a model with its versions and files, and the figures follow", async () => {
    const [m] = await db.query<{ name: string; b: string }>("SELECT m.name, sum(v.size_bytes)::text AS b FROM models m JOIN versions v ON v.model_id = m.id WHERE m.id = 'synth-0001' GROUP BY m.name");
    const t = performance.now();
    const res = await app.inject({ method: "DELETE", url: "/api/admin/models/synth-0001", headers: auth, payload: { confirm: m!.name } });
    const ms = performance.now() - t;
    timings.push(`permanent delete of a 5-version model with 10 GB of files: ${ms.toFixed(0)} ms (budget 1500 ms)`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ versions: PER_MODEL, bytes: Number(m!.b) });
    expect(ms).toBeLessThan(1500);
    expect(await readdir(storage.files)).not.toContain("synth-0001");
    const s = (await app.inject({ method: "GET", url: "/api/admin/storage", headers: auth })).json() as { publishedBytes: number };
    expect(s.publishedBytes).toBe(expectedBytes - Number(m!.b));
  });
});
