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
    // The database refuses the change, so this plays someone who switched the guard off first.
    await expect(db.query("UPDATE audit_events SET host = 'someone-else' WHERE action = 'model.update'")).rejects.toThrow(/append-only/);
    await db.exec("ALTER TABLE audit_events DISABLE TRIGGER audit_events_rows");
    await db.query("UPDATE audit_events SET host = 'someone-else' WHERE action = 'model.update'");
    await db.exec("ALTER TABLE audit_events ENABLE TRIGGER audit_events_rows");
    const v = (await read("/api/audit/verify")).json();
    expect(v.ok).toBe(false);
    expect(Number(v.brokenAt)).toBe(4);
  });
});

describe("layer manifest (WP 2.1)", () => {
  const manifest = { layers: [{ name: "Structure", nodes: [1, 2], children: [{ name: "Chimney", nodes: [3] }] }, { name: "Trees", nodes: [4] }] };
  it("saves the arrangement for the current version, audits it, and carries it to the next version", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/models", payload: { ...newModel, name: "Layered" }, headers: ws })).json().id as string;
    expect((await app.inject(`/api/models/${id}/layers`)).json()).toEqual({ version: 1, manifest: null });

    const put = await app.inject({ method: "PUT", url: `/api/models/${id}/layers`, payload: { manifest }, headers: ws });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ version: 1, manifest });
    expect((await app.inject(`/api/models/${id}/layers`)).json()).toEqual({ version: 1, manifest });

    // A new version starts with the same arrangement; changing it leaves version 1's alone.
    await app.inject({ method: "POST", url: `/api/models/${id}/versions`, payload: { source: { kind: "glb", url: "files/x/v2.glb" }, note: "v2" }, headers: ws });
    expect((await app.inject(`/api/models/${id}/layers`)).json()).toEqual({ version: 2, manifest });
    const changed = { layers: [{ name: "Everything", nodes: [0] }] };
    await app.inject({ method: "PUT", url: `/api/models/${id}/layers`, payload: { manifest: changed }, headers: ws });
    expect((await app.inject(`/api/models/${id}/layers`)).json().manifest).toEqual(changed);
    expect((await app.inject(`/api/models/${id}/layers?version=1`)).json()).toEqual({ version: 1, manifest });

    // Cleared: back to the file's own tree.
    expect((await app.inject({ method: "PUT", url: `/api/models/${id}/layers`, payload: { manifest: null }, headers: ws })).json()).toEqual({ version: 2, manifest: null });
    expect((await app.inject(`/api/models/${id}/layers`)).json().manifest).toBeNull();

    const { token } = (await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "correct horse battery" } })).json();
    const events = (await app.inject({ url: `/api/audit?target=${id}&action=layers.update`, headers: { authorization: `Bearer ${token}` } })).json();
    expect(events.map((e: { host: string; detail: { version: number; cleared: boolean } }) => [e.host, e.detail.version, e.detail.cleared])).toEqual([
      ["ANALYST-07", 2, true],
      ["ANALYST-07", 2, false],
      ["ANALYST-07", 1, false],
    ]);
  });

  it("refuses an arrangement it cannot use, and an unknown model", async () => {
    const id = (await app.inject("/api/models")).json()[0].id as string;
    const bad = async (payload: unknown) => (await app.inject({ method: "PUT", url: `/api/models/${id}/layers`, payload })).statusCode;
    expect(await bad({ manifest: { layers: [{ nodes: [1] }] } })).toBe(400); // no name
    expect(await bad({ manifest: { layers: [{ name: "x", nodes: [-1] }] } })).toBe(400);
    expect(await bad({ manifest: { layers: [{ name: "x", nodes: [1.5] }] } })).toBe(400);
    let deep: { name: string; children?: unknown[] } = { name: "leaf" };
    for (let i = 0; i < 70; i++) deep = { name: `l${i}`, children: [deep] };
    const r = await app.inject({ method: "PUT", url: `/api/models/${id}/layers`, payload: { manifest: { layers: [deep] } } });
    expect([r.statusCode, r.json().error]).toEqual([400, "The layers are nested more than 64 deep."]);
    expect((await app.inject({ method: "PUT", url: "/api/models/nope/layers", payload: { manifest: null } })).statusCode).toBe(404);
    expect((await app.inject("/api/models/nope/layers")).statusCode).toBe(404);
    expect((await app.inject(`/api/models/${id}/layers?version=99`)).statusCode).toBe(404);
  });
});
