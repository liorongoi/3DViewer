import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAdminPassword } from "./admin.ts";
import { buildApp } from "./app.ts";
import { migrate, openPglite, type Db } from "./db.ts";
import { ingestHandler } from "./ingest.ts";
import { Worker } from "./jobs.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";
import { gridGlb } from "./test-models.ts";

/**
 * AC-08 at API level (WP 3.6 and 3.8). A producer uploads a model with its metadata, others find it
 * in Hebrew and English, edit every field and its classification, change its status, and upload a
 * second version; the first version stays openable. Each action is in the audit log with the IP
 * and workstation it came from and the time.
 */

let db: Db;
let app: FastifyInstance;
let storage: Storage;
let dir: string;
let auth: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-ac08-"));
  db = await openPglite();
  await migrate(db);
  await seed(db, { samples: true });
  await ensureAdminPassword(db, "ac-08 admin password");
  storage = new Storage(dir);
  await storage.init();
  app = await buildApp({ db, storage });
  const { token } = (await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "ac-08 admin password" } })).json();
  auth = { authorization: `Bearer ${token}` };
});
afterAll(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Three people at three workstations. */
const producer = { remoteAddress: "10.20.1.11", headers: { "x-workstation": "PROD-03" } };
const editor = { remoteAddress: "10.20.4.52", headers: { "x-workstation": "ANALYST-07" } };
const viewer = { remoteAddress: "10.20.9.200", headers: { "x-workstation": "BRIEFING-1" } };
type As = typeof producer;

const call = (as: As, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: as.remoteAddress, headers: as.headers });

async function ingest(as: As, file: string, body: object) {
  const data = gridGlb(10);
  const res = await call(as, "POST", "/api/ingests", { files: [{ path: file, size: data.length }], ...body });
  expect(res.statusCode, res.body).toBe(201);
  const ing = res.json() as { id: string; uploads: { url: string }[] };
  const put = await app.inject({
    method: "PATCH",
    url: ing.uploads[0]!.url,
    remoteAddress: as.remoteAddress,
    headers: { ...as.headers, "content-type": "application/offset+octet-stream", "upload-offset": "0", "tus-resumable": "1.0.0" },
    payload: Buffer.from(data),
  });
  expect(put.statusCode, put.body).toBe(204);
  expect((await call(as, "POST", `/api/ingests/${ing.id}/submit`)).statusCode).toBe(202);
  await new Worker(db, { ingest: ingestHandler(db, storage, {}) }).runOnce();
  const s = (await call(as, "GET", `/api/ingests/${ing.id}`)).json();
  expect(s, s.error).toMatchObject({ state: "ready" });
  return s as { id: string; modelId: string; version: number };
}

describe("AC-08: metadata, status, versions and their audit trail", () => {
  const started = new Date(Date.now() - 1000);
  let id = "";
  let v1Url = "";

  it("publishes an upload with its metadata", async () => {
    const r = await ingest(producer, "pump-station.glb", {
      model: {
        name: "תחנת שאיבה צפון",
        project: "Water North",
        operation: "Survey 2026",
        responsibleEntity: "Mapping unit",
        description: "Pump station, north site, before the roof was replaced.",
        status: "draft",
        classificationId: "restricted",
      },
      placement: { lat: 32.79, lon: 35.0, height: 12, aboveGround: 0 },
    });
    id = r.modelId;
    const m = (await call(producer, "GET", `/api/models/${id}`)).json();
    expect(m).toMatchObject({ name: "תחנת שאיבה צפון", project: "Water North", operation: "Survey 2026", responsibleEntity: "Mapping unit", status: "draft", classificationId: "restricted", version: 1, versions: 1 });
    v1Url = m.source.url;
  });

  it("is found by search in Hebrew and English, and by each filter", async () => {
    const ids = async (qs: string) => ((await call(viewer, "GET", `/api/models?${qs}`)).json() as { id: string }[]).map((m) => m.id);
    expect(await ids(`q=${encodeURIComponent("שאיבה")}`)).toEqual([id]);
    expect(await ids("q=PUMP+STATION")).toEqual([id]);
    for (const qs of ["project=Water+North", "operation=Survey+2026", "entity=Mapping+unit", "status=draft", "classification=restricted"]) expect(await ids(qs), qs).toContain(id);
    expect(await ids("project=Water+North&status=current")).toEqual([]);
  });

  it("edits the four fields, the description and the classification", async () => {
    const edit = { name: "Pump station North · תחנת שאיבה", project: "Water North 2", operation: "Survey 2026b", responsibleEntity: "Survey unit", description: "Roof replaced in October.", classificationId: "confidential" };
    const r = await call(editor, "PATCH", `/api/models/${id}`, edit);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ...edit, status: "draft" });
    // The edit is what everyone sees from now on.
    expect((await call(viewer, "GET", `/api/models/${id}`)).json()).toMatchObject(edit);
    expect(((await call(viewer, "GET", "/api/models?classification=restricted")).json() as { id: string }[]).map((m) => m.id)).not.toContain(id);
  });

  it("dates a status change, and only a status change", async () => {
    await db.query("UPDATE models SET status_changed_at = '2026-01-15' WHERE id = $1", [id]);
    const name = await call(editor, "PATCH", `/api/models/${id}`, { description: "Roof replaced in October 2026." });
    expect(name.json().statusChangedAt).toBe("2026-01-15");
    const st = await call(editor, "PATCH", `/api/models/${id}`, { status: "current" });
    expect(st.json()).toMatchObject({ status: "current" });
    expect(st.json().statusChangedAt).toBe(new Date().toISOString().slice(0, 10));
  });

  it("adds a second version and keeps the first one openable", async () => {
    const r = await ingest(producer, "pump-station-v2.glb", { modelId: id, placement: { lat: 32.79, lon: 35.0, height: 12, aboveGround: 0 }, note: "New roof" });
    expect(r).toMatchObject({ modelId: id, version: 2 });
    const now = (await call(viewer, "GET", `/api/models/${id}`)).json();
    expect(now).toMatchObject({ version: 2, versions: 2, name: "Pump station North · תחנת שאיבה" });
    expect(now.history.map((h: { version: number; note: string }) => [h.version, h.note])).toEqual([
      [2, "New roof"],
      [1, ""],
    ]);
    expect(now.source.url).not.toBe(v1Url);

    const old = await call(viewer, "GET", `/api/models/${id}?version=1`);
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json()).toMatchObject({ version: 1, versions: 2, source: { url: v1Url } });
    expect((await app.inject(`/${v1Url}`)).statusCode).toBe(200);
    expect((await app.inject(`/${now.source.url}`)).statusCode).toBe(200);
    const none = await call(viewer, "GET", `/api/models/${id}?version=9`);
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe("This model has no version 9.");
  });

  it("has every action in the audit log with IP, workstation and time", async () => {
    const rows = ((await app.inject({ url: "/api/audit?limit=100000", headers: auth })).json() as { at: string; ip: string; host: string; action: string; target: string; detail: Record<string, unknown> }[])
      .filter((e) => e.target === id || (e.detail as { ingest?: string }).ingest !== undefined)
      .reverse();
    const trail = rows.map((e) => [e.action, e.ip, e.host]);
    const P = ["10.20.1.11", "PROD-03"];
    const E = ["10.20.4.52", "ANALYST-07"];
    const V = ["10.20.9.200", "BRIEFING-1"];
    expect(trail).toEqual([
      ["ingest.create", ...P],
      ["ingest.submit", ...P],
      ["model.create", ...P],
      ["model.view", ...P],
      ["model.update", ...E],
      ["model.view", ...V],
      ["model.update", ...E],
      ["model.update", ...E],
      ["ingest.create", ...P],
      ["ingest.submit", ...P],
      ["version.create", ...P],
      ["model.view", ...V],
      ["model.view", ...V],
    ]);
    for (const e of rows) {
      const at = new Date(e.at).getTime();
      expect(at).toBeGreaterThanOrEqual(started.getTime());
      expect(at).toBeLessThanOrEqual(Date.now());
    }
    // What changed is recorded, old and new, including the classification.
    const updates = rows.filter((e) => e.action === "model.update").map((e) => e.detail.changes);
    expect(updates[0]).toMatchObject({ classificationId: ["restricted", "confidential"], name: ["תחנת שאיבה צפון", "Pump station North · תחנת שאיבה"], responsibleEntity: ["Mapping unit", "Survey unit"] });
    expect(updates[2]).toEqual({ status: ["draft", "current"] });
    // Opening the old version is recorded as that version.
    expect(rows.filter((e) => e.action === "model.view").map((e) => e.detail.version)).toEqual([1, 1, 2, 1]);
    expect((await app.inject({ url: "/api/audit/verify", headers: auth })).json().ok).toBe(true);
  });
});
