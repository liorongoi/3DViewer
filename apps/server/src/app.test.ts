import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ensureAdminPassword } from "./admin.ts";
import { audit } from "./audit.ts";
import { buildApp } from "./app.ts";
import { MIGRATIONS, migrate, openPglite, openPostgres, type Db } from "./db.ts";
import { seed } from "./seed.ts";

let db: Db;
let app: FastifyInstance;
const ws = { "x-workstation": "ANALYST-07" };

beforeAll(async () => {
  // CI repeats these tests on a real PostgreSQL (TEST_DATABASE_URL); locally they use embedded PGlite.
  const url = process.env.TEST_DATABASE_URL;
  db = url ? await openPostgres(url) : await openPglite();
  expect(await migrate(db)).toEqual(MIGRATIONS.map(([f]) => f));
  expect(await migrate(db)).toEqual([]);
  await seed(db, { samples: true });
  await ensureAdminPassword(db, "correct horse battery");
  app = await buildApp({ db });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const newModel = {
  name: "Bridge 12 · נחל שורק",
  project: "Crossings",
  operation: "Survey 2026",
  responsibleEntity: "Mapping unit",
  status: "draft",
  classificationId: "restricted",
  sourceFormat: "glb",
  source: { kind: "glb", url: "files/bridge12/v1/model.glb" },
  centre: { lat: 31.77, lon: 34.81 },
  placement: { lat: 31.77, lon: 34.81, height: 60, aboveGround: 0 },
  sizeBytes: 1234,
};

describe("library API", () => {
  it("is healthy and publishes OpenAPI", async () => {
    expect((await app.inject("/api/health")).json()).toEqual({ ok: true, db: db.kind });
    const spec = (await app.inject("/api/openapi.json")).json();
    expect(Object.keys(spec.paths)).toContain("/api/models/{id}");
  });

  it("serves the seeded classifications and sample library in the client's shape", async () => {
    const cls = (await app.inject("/api/classifications")).json();
    expect(cls.map((c: { id: string }) => c.id)).toEqual(["unclassified", "restricted", "confidential", "secret"]);
    const models = (await app.inject("/api/models")).json();
    expect(models.length).toBeGreaterThan(5);
    const lyon = models.find((m: { id: string }) => m.id === "m-lyon");
    expect(lyon).toMatchObject({ version: 3, versions: 3, sourceFormat: "3dtiles", source: { kind: "3dtiles" } });
  });

  it("creates, searches in Hebrew, filters, updates and versions a model", async () => {
    const res = await app.inject({ method: "POST", url: "/api/models", payload: newModel, headers: ws });
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({ name: newModel.name, version: 1, versions: 1, classificationId: "restricted", placement: { aboveGround: 0 } });

    const found = (await app.inject("/api/models?q=" + encodeURIComponent("שורק"))).json();
    expect(found.map((x: { id: string }) => x.id)).toEqual([m.id]);
    expect((await app.inject("/api/models?classification=restricted&status=draft")).json().map((x: { id: string }) => x.id)).toContain(m.id);
    expect((await app.inject("/api/models?q=" + encodeURIComponent("100%"))).json()).toEqual([]);

    const up = await app.inject({ method: "PATCH", url: `/api/models/${m.id}`, payload: { status: "current", classificationId: "secret" }, headers: ws });
    expect(up.json()).toMatchObject({ status: "current", classificationId: "secret" });

    const v2 = await app.inject({ method: "POST", url: `/api/models/${m.id}/versions`, payload: { source: { kind: "glb", url: "files/bridge12/v2/model.glb" }, note: "Deck added" }, headers: ws });
    expect(v2.json()).toMatchObject({ version: 2, versions: 2, source: { url: "files/bridge12/v2/model.glb" } });

    const detail = (await app.inject({ url: `/api/models/${m.id}`, headers: ws })).json();
    expect(detail.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
  });

  it("rejects bad input with a reason", async () => {
    const noCls = await app.inject({ method: "POST", url: "/api/models", payload: { ...newModel, classificationId: "top-secret-x" } });
    expect(noCls.statusCode).toBe(400);
    expect(noCls.json().error).toMatch(/classification/i);
    const missing = await app.inject({ method: "POST", url: "/api/models", payload: { name: "x" } });
    expect(missing.statusCode).toBe(400);
    expect((await app.inject("/api/models/nope")).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/models/nope", payload: { name: "y" } })).statusCode).toBe(404);
  });
});

describe("audit log", () => {
  // Reading the log is for the administrator.
  let auth: Record<string, string> = {};
  const read = (url: string) => app.inject({ url, headers: auth });
  beforeAll(async () => {
    expect((await app.inject("/api/audit")).statusCode).toBe(401);
    const { token } = (await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "correct horse battery" } })).json();
    auth = { authorization: `Bearer ${token}` };
  });

  it("records every action with IP, workstation and time, chained by hash", async () => {
    const rows = (await read("/api/audit")).json();
    const actions = rows.map((r: { action: string }) => r.action).reverse();
    expect(actions).toEqual(["system.seed", "admin.password.set", "model.create", "model.update", "version.create", "model.view", "admin.login"]);
    const upd = rows.find((r: { action: string }) => r.action === "model.update");
    expect(upd).toMatchObject({ host: "ANALYST-07", ip: "127.0.0.1", detail: { changes: { status: ["draft", "current"], classificationId: ["restricted", "secret"] } } });
    expect((await read("/api/audit/verify")).json()).toEqual({ ok: true, count: 7 });
  });

  it("exports CSV and logs the export", async () => {
    const res = await read("/api/audit.csv?action=model.update");
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const lines = res.body.replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]).toBe("seq,at,ip,host,action,target,detail,hash");
    expect(lines).toHaveLength(2);
    const last = (await read("/api/audit?limit=1")).json()[0];
    expect(last.action).toBe("audit.export");
  });

  it("an entry with an empty detail field still checks", async () => {
    await audit(db, { ip: "", host: "test", action: "test.undefined", detail: { kept: 1, dropped: undefined, list: [1, null] } });
    expect((await read("/api/audit/verify")).json().ok).toBe(true);
  });

  it("detects a changed row", async () => {
    await db.query("UPDATE audit_events SET host = 'someone-else' WHERE action = 'model.update'");
    const v = (await read("/api/audit/verify")).json();
    expect(v.ok).toBe(false);
    expect(Number(v.brokenAt)).toBe(4);
  });
});
