import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { argon2Verify } from "hash-wasm";
import { contrast, ensureAdminPassword, getSetting } from "./admin.ts";
import { buildApp } from "./app.ts";
import { migrate, openPglite, openPostgres, type Db } from "./db.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";

/** WP 3.9, AC-09 at API level: password-protected admin, classification levels, permanent delete, quota, base maps. */

let db: Db;
let app: FastifyInstance;
let storage: Storage;
let dir: string;
const PASSWORD = "Admin-pass-for-tests";
let auth: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-admin-"));
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const a = await openPostgres(url);
    await a.exec("DROP SCHEMA IF EXISTS admin_test CASCADE; CREATE SCHEMA admin_test");
    await a.close();
    db = await openPostgres(`${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=admin_test")}`);
  } else db = await openPglite();
  await migrate(db);
  await seed(db, { samples: true });
  storage = new Storage(dir);
  await storage.init();
  app = await buildApp({ db, storage, thumbnails: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const login = (password: string) => app.inject({ method: "POST", url: "/api/admin/login", payload: { password } });
const as = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });
const lastAudit = async () => (await db.query<{ action: string; target: string; detail: Record<string, unknown> }>("SELECT action, target, detail FROM audit_events ORDER BY seq DESC LIMIT 1"))[0]!;

describe("admin password and sign-in", () => {
  it("says no password is set, and refuses sign-in until the server sets one", async () => {
    expect((await app.inject("/api/admin/status")).json()).toEqual({ passwordSet: false, signedIn: false });
    expect((await login("anything at all")).statusCode).toBe(503);
  });

  it("stores the first password from ADMIN_PASSWORD as argon2id, and keeps it on later starts", async () => {
    await expect(ensureAdminPassword(db, "short")).rejects.toThrow(/12 characters/);
    expect(await ensureAdminPassword(db, PASSWORD)).toBe("set");
    const hash = (await getSetting<string>(db, "admin.password"))!;
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await argon2Verify({ password: PASSWORD, hash })).toBe(true);
    expect(await ensureAdminPassword(db, "a different password")).toBe("kept");
    expect(await getSetting<string>(db, "admin.password")).toBe(hash);
  });

  it("guards every admin route and the audit log", async () => {
    for (const [method, url] of [
      ["GET", "/api/admin/storage"],
      ["PUT", "/api/admin/storage"],
      ["PUT", "/api/admin/classifications/x"],
      ["DELETE", "/api/admin/classifications/secret"],
      ["DELETE", "/api/admin/models/m-lyon"],
      ["PUT", "/api/admin/basemaps"],
      ["POST", "/api/admin/password"],
      ["GET", "/api/audit"],
      ["GET", "/api/audit.csv"],
      ["GET", "/api/audit/verify"],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      const forged = await app.inject({ method, url, headers: { authorization: "Bearer " + "A".repeat(43) }, payload: method === "GET" ? undefined : {} });
      expect(forged.statusCode, `${method} ${url} with a made-up token`).toBe(401);
    }
  });

  it("signs in with the right password and records both outcomes", async () => {
    const bad = await login("wrong password!");
    expect(bad.statusCode).toBe(401);
    expect(await lastAudit()).toMatchObject({ action: "admin.login.failed" });
    const ok = await login(PASSWORD);
    expect(ok.statusCode).toBe(200);
    const { token, expiresAt } = ok.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(7.9 * 3600_000);
    expect(await lastAudit()).toMatchObject({ action: "admin.login" });
    // Only a hash of the token is stored.
    expect(JSON.stringify(await db.query("SELECT * FROM admin_sessions"))).not.toContain(token);
    auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/api/admin/status", headers: auth })).json()).toEqual({ passwordSet: true, signedIn: true });
  });

  it("locks out an address after 5 wrong passwords in a row", async () => {
    const other = { remoteAddress: "10.0.0.9" };
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: `guess ${i}` }, ...other })).statusCode).toBe(401);
    const locked = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD }, ...other });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(20);
    // Another address is not affected.
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it("changes the password, ending other sign-ins but not this one", async () => {
    const second = { authorization: `Bearer ${(await login(PASSWORD)).json().token}` };
    expect((await as("POST", "/api/admin/password", { current: "nope", next: "a new long password" })).statusCode).toBe(400);
    expect((await as("POST", "/api/admin/password", { current: PASSWORD, next: "too short" })).statusCode).toBe(400);
    expect((await as("POST", "/api/admin/password", { current: PASSWORD, next: "a new long password" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/admin/storage", headers: second })).statusCode).toBe(401);
    expect((await as("GET", "/api/admin/storage")).statusCode).toBe(200);
    expect((await login(PASSWORD)).statusCode).toBe(401);
    expect((await login("a new long password")).statusCode).toBe(200);
  });

  it("ADMIN_PASSWORD_RESET replaces a forgotten password and ends every sign-in", async () => {
    expect(await ensureAdminPassword(db, PASSWORD, true)).toBe("reset");
    expect((await as("GET", "/api/admin/storage")).statusCode).toBe(401);
    auth = { authorization: `Bearer ${(await login(PASSWORD)).json().token}` };
    expect((await as("GET", "/api/admin/storage")).statusCode).toBe(200);
  });
});

describe("classification levels", () => {
  it("adds a level and lists it in order", async () => {
    const r = await as("PUT", "/api/admin/classifications/internal", { label: "Internal use", color: "#2F6FDB", textColor: "#ffffff", order: 1 });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id: "internal", color: "#2F6FDB", textColor: "#FFFFFF" });
    const ids = (await app.inject("/api/classifications")).json().map((c: { id: string }) => c.id);
    expect(ids).toContain("internal");
    expect(await lastAudit()).toMatchObject({ action: "classification.create", target: "internal" });
  });

  it("refuses a band whose text would be hard to read", async () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    const r = await as("PUT", "/api/admin/classifications/internal", { label: "Internal use", color: "#FFD400", textColor: "#FFFFFF", order: 1 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/contrast of 1\.\d:1/);
    expect((await as("PUT", "/api/admin/classifications/internal", { label: "x", color: "red", textColor: "#FFFFFF", order: 1 })).statusCode).toBe(400);
  });

  it("the seeded levels all pass the same contrast rule", async () => {
    for (const c of (await app.inject("/api/classifications")).json()) expect(contrast(c.color, c.textColor), c.id).toBeGreaterThanOrEqual(4.5);
  });

  it("changing a level's look re-renders the thumbnails of its models", async () => {
    const [cls] = (await app.inject("/api/classifications")).json().filter((c: { id: string }) => c.id === "restricted");
    const users = (await app.inject("/api/models?classification=restricted")).json().length;
    expect(users).toBeGreaterThan(0);
    const r = await as("PUT", "/api/admin/classifications/restricted", { ...cls, label: "Restricted (updated)" });
    expect(r.json().thumbnailsQueued).toBe(users);
    // A change of order alone does not touch the band.
    expect((await as("PUT", "/api/admin/classifications/restricted", { ...cls, label: "Restricted (updated)", order: cls.order })).json().thumbnailsQueued).toBe(0);
  });

  it("will not remove a level that models still use", async () => {
    const r = await as("DELETE", "/api/admin/classifications/restricted");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/models? (is|are) at this level/);
    expect((await as("DELETE", "/api/admin/classifications/internal")).statusCode).toBe(200);
    expect((await as("DELETE", "/api/admin/classifications/internal")).statusCode).toBe(404);
  });
});

describe("permanent delete", () => {
  it("needs the model's name typed exactly", async () => {
    const r = await as("DELETE", "/api/admin/models/m-lyon", { confirm: "lyon" });
    expect(r.statusCode).toBe(400);
    expect((await app.inject("/api/models/m-lyon")).statusCode).toBe(200);
  });

  it("removes the model, every version and its files, and keeps the audit trail", async () => {
    const m = (await app.inject("/api/models/m-lyon")).json();
    const files = path.join(storage.files, "m-lyon");
    await mkdir(path.join(files, "i-1"), { recursive: true });
    await writeFile(path.join(files, "i-1", "tileset.json"), "{}");
    await writeFile(path.join(storage.files, "keep.txt"), "another model's file");
    await db.query("INSERT INTO ingests (id, model_id, state) VALUES ('i-old', 'm-lyon', 'ready')");
    await db.query("INSERT INTO uploads (id, ingest_id, path, length) VALUES ('u-old', 'i-old', 'tileset.json', 2)");

    const r = await as("DELETE", "/api/admin/models/m-lyon", { confirm: m.name });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, name: m.name, versions: 3 });
    expect((await app.inject("/api/models/m-lyon")).statusCode).toBe(404);
    expect(await db.query("SELECT 1 FROM versions WHERE model_id = 'm-lyon'")).toEqual([]);
    expect(await db.query("SELECT 1 FROM ingests WHERE model_id = 'm-lyon'")).toEqual([]);
    expect(await readdir(storage.files)).toEqual(["keep.txt"]);
    expect(await lastAudit()).toMatchObject({ action: "model.delete", target: "m-lyon", detail: { name: m.name } });
    // The view of it before the delete is still in the log, and the chain still checks.
    expect((await db.query("SELECT 1 FROM audit_events WHERE action = 'model.view' AND target = 'm-lyon'")).length).toBeGreaterThan(0);
    expect((await as("GET", "/api/audit/verify")).json().ok).toBe(true);
    expect((await as("DELETE", "/api/admin/models/m-lyon", { confirm: m.name })).statusCode).toBe(404);
  });
});

describe("storage quota", () => {
  it("reports usage and the disk, and refuses an upload past the quota", async () => {
    const s = (await as("GET", "/api/admin/storage")).json();
    expect(s).toMatchObject({ quotaBytes: null, models: expect.any(Number), versions: expect.any(Number) });
    expect(s.disk.totalBytes).toBeGreaterThan(0);
    const ingest = (size: number) =>
      app.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: "a.glb", size }], model: { name: "Quota test", status: "draft", classificationId: "unclassified" }, centre: { lat: 0, lon: 0 } } });

    expect((await as("PUT", "/api/admin/storage", { quotaBytes: s.usedBytes + 1000 })).statusCode).toBe(200);
    expect(await lastAudit()).toMatchObject({ action: "settings.quota", detail: { quotaBytes: s.usedBytes + 1000, was: null } });
    expect((await ingest(600)).statusCode).toBe(201);
    // The first upload still in progress counts too.
    const full = await ingest(600);
    expect(full.statusCode).toBe(507);
    expect(full.json().error).toMatch(/library is full/);
    expect((await as("PUT", "/api/admin/storage", { quotaBytes: null })).statusCode).toBe(200);
    expect((await ingest(600)).statusCode).toBe(201);
  });
});

describe("base map sources", () => {
  const internal = {
    sources: [
      { id: "ortho", label: "Orthophoto 2025", kind: "imagery", type: "wmts", url: "http://maps.internal/wmts", layer: "ortho2025", matrixSet: "GoogleMapsCompatible", format: "image/jpeg", attribution: "Survey dept." },
      { id: "dem", label: "National DEM", kind: "terrain", type: "quantized-mesh", url: "/basemap/terrain" },
      { id: "streets", label: "Streets", kind: "imagery", type: "xyz", url: "/basemap/streets/{z}/{x}/{y}.png", maxZoom: 18 },
    ],
    defaultImagery: "ortho",
    defaultTerrain: "dem",
    hideOnline: true,
  };

  it("starts empty, so the viewer keeps its own catalogue", async () => {
    expect((await app.inject("/api/basemaps")).json()).toEqual({ sources: [] });
  });

  it("saves internal sources that every viewer reads", async () => {
    expect((await as("PUT", "/api/admin/basemaps", internal)).statusCode).toBe(200);
    expect((await app.inject("/api/basemaps")).json()).toEqual(internal);
    expect(await lastAudit()).toMatchObject({ action: "settings.basemaps", detail: { sources: ["ortho", "dem", "streets"], hideOnline: true } });
  });

  it("explains what is wrong with a source", async () => {
    const bad = {
      sources: [
        { id: "a", label: "A", kind: "imagery", type: "terrarium", url: "/t/{z}/{x}/{y}.png" },
        { id: "a", label: "B", kind: "imagery", type: "xyz", url: "/tiles" },
        { id: "c", label: "C", kind: "imagery", type: "wmts", url: "file:///etc/passwd" },
      ],
    };
    const r = await as("PUT", "/api/admin/basemaps", bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().problems).toEqual([
      '"A": a terrarium source is terrain, not imagery.',
      'Two sources have the id "a".',
      '"B": an xyz address needs {z}, {x} and {y} in it.',
      '"C": the address must start with http://, https:// or be a path on this server.',
      '"C": a WMTS source needs its layer name.',
    ]);
    expect((await app.inject("/api/basemaps")).json()).toEqual(internal);
  });
});
