import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { migrate, openPglite, type Db } from "./db.ts";
import { addSchemas, checkContract, closed, ref, text } from "./schemas.ts";
import { Storage } from "./storage.ts";

/**
 * WP 3.1 contract tests. Every server test runs in contract mode (each JSON answer is checked
 * against the published schema for its status), so the whole suite exercises the contract. These
 * tests check the contract itself: that it is complete, that contract mode catches a mismatch,
 * and that the published copy the web app's client is generated from is current.
 */

const PUBLISHED = path.resolve(import.meta.dirname, "../../../packages/api-client/openapi.json");

let db: Db;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  dir = await mkdtemp(path.join(tmpdir(), "contract-"));
  app = await buildApp({ db, storage: new Storage(dir) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

type Spec = { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>; components: { schemas: Record<string, unknown> } };
const spec = async () => (await app.inject("/api/openapi.json")).json() as Spec;

describe("the published API", () => {
  it("names a success answer for every operation, and the error answer", async () => {
    const s = await spec();
    const ops = Object.entries(s.paths).flatMap(([p, m]) => Object.entries(m).map(([verb, op]) => ({ op: `${verb.toUpperCase()} ${p}`, codes: Object.keys(op.responses ?? {}) })));
    expect(ops.length).toBeGreaterThanOrEqual(25);
    const missing = ops.filter((o) => !o.codes.some((c) => /^2/.test(c))).map((o) => o.op);
    expect(missing).toEqual([]);
    const noErrors = ops.filter((o) => !o.codes.includes("4XX")).map((o) => o.op);
    expect(noErrors).toEqual([]);
    // Shared shapes keep their names, so the generated client has ModelSummary, not def-3.
    expect(Object.keys(s.components.schemas)).toEqual(expect.arrayContaining(["ModelSummary", "ModelDetail", "Classification", "BaseMapConfig", "IngestStatus", "AuditEvent", "Error"]));
  });

  it("is the copy the web app's client is generated from (UPDATE_API=1 rewrites it)", async () => {
    const live = JSON.stringify(await spec(), null, 2) + "\n";
    if (process.env.UPDATE_API) await writeFile(PUBLISHED, live);
    const published = await readFile(PUBLISHED, "utf8").catch(() => "");
    expect(published, "packages/api-client/openapi.json is out of date: run UPDATE_API=1 pnpm --filter @viewer/server test, then pnpm --filter @viewer/api-client generate").toBe(live);
  });
});

describe("contract mode", () => {
  const tiny = async (answer: unknown) => {
    const t = Fastify();
    addSchemas(t);
    await checkContract(t);
    t.get("/api/thing", { schema: { response: { 200: closed({ name: text }, ["name"]), "4xx": ref("Error") } } }, async () => answer);
    t.get("/api/unlisted", { schema: { response: { 200: closed({ name: text }, ["name"]) } } }, async (_q, reply) => (reply as { status(n: number): typeof reply }).status(418).send({ error: "teapot" }));
    await t.ready();
    return t;
  };

  it("passes an answer that matches", async () => {
    const t = await tiny({ name: "ok" });
    expect((await t.inject("/api/thing")).statusCode).toBe(200);
  });

  it("fails a field the contract does not name, rather than dropping it", async () => {
    const t = await tiny({ name: "ok", secretNew: 1 });
    const r = await t.inject("/api/thing");
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toMatch(/^Contract: GET \/api\/thing answered 200, not as published: .*additional properties/);
  });

  it("fails a missing or mistyped field", async () => {
    expect((await (await tiny({})).inject("/api/thing")).json().error).toMatch(/must have required property 'name'/);
    expect((await (await tiny({ name: 3 })).inject("/api/thing")).json().error).toMatch(/must be string/);
  });

  it("fails a status the route does not list", async () => {
    const r = await (await tiny({ name: "ok" })).inject("/api/unlisted");
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toMatch(/answered 418, which the published API does not list/);
  });
});
