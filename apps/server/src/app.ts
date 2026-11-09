import { promises as dns } from "node:dns";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import { UPDATE_STATUSES, type LayerManifest } from "@viewer/shared/model";
import { ServerError } from "@viewer/shared";
import { registerAdmin } from "./admin.ts";
import { audit, auditCsv, verifyAudit, type AuditRow } from "./audit.ts";
import type { Db } from "./db.ts";
import { registerIngest } from "./ingest.ts";
import { enqueue } from "./jobs.ts";
import { registerFiles, type Storage } from "./storage.ts";
import { addSchemas, arrayOf, bool, closed, int, ref, text, checkContract } from "./schemas.ts";
import { addVersion, createModel, getManifest, getModel, manifestProblem, setManifest, listModels, listVersions, updateModel, type LibraryFilter, type ModelPatch, type NewModel } from "./library.ts";
import { problem } from "./errors.ts";

export interface AppOptions {
  db: Db;
  /** Reverse DNS for the audit host column (decision D-5). Off in tests. */
  reverseDns?: boolean;
  logger?: boolean;
  /** Where uploads and published files live. Without it the upload routes are off. */
  storage?: Storage;
  /** Origins allowed to call the API from another origin (the desktop app, a separate web host). "*" allows any. */
  corsOrigins?: string[];
  /** A thumbnail worker runs, so a classification change re-renders the band on the thumbnail. */
  thumbnails?: boolean;
  /**
   * Check every JSON answer against the published contract and fail it with a 500 if it does
   * not match, instead of trimming it to the schema. On in tests (WP 3.1 contract tests).
   */
  contract?: boolean;
  /**
   * Write requests (POST, PUT, PATCH, DELETE) one address may make per minute, answered with 429
   * and Retry-After beyond that. Upload chunks (/api/tus/) do not count. 0 or unset: no limit.
   */
  writeRateLimit?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`no answer in ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t));
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Most addresses the rate limiter and host-name cache remember; the oldest are forgotten first. */
const MAX_TRACKED = 10_000;

/** A token bucket per address: `limit` requests at once, refilled at `limit` per minute. */
export function writeLimiter(limit: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const perMs = limit / 60_000;
  /** Seconds to wait before the next write is allowed, or 0 when it is allowed now. */
  return (ip: string): number => {
    const t = now();
    let b = buckets.get(ip);
    if (b) {
      b.tokens = Math.min(limit, b.tokens + (t - b.at) * perMs);
      b.at = t;
      buckets.delete(ip); // re-insert so the map stays in least-recently-used order
    } else {
      b = { tokens: limit, at: t };
      if (buckets.size >= MAX_TRACKED) buckets.delete(buckets.keys().next().value!);
    }
    buckets.set(ip, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000));
  };
}

const FORMATS = ["glb", "gltf", "fbx", "3dtiles"];
const str = { type: "string", maxLength: 2000 } as const;
const centre = { type: "object", required: ["lat", "lon"], properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 } } } as const;
const source = {
  type: "object",
  required: ["kind", "url"],
  properties: { kind: { enum: ["glb", "3dtiles"] }, url: { type: "string", maxLength: 4000 }, groundFit: { enum: ["street", "surface", "none"] }, clipTerrain: { type: "boolean" }, localFrame: { type: "boolean" }, georeferenced: { type: "boolean" }, attribution: str },
  additionalProperties: false,
} as const;
const placement = {
  type: "object",
  required: ["lat", "lon", "height"],
  properties: { lat: { type: "number" }, lon: { type: "number" }, height: { type: "number" }, aboveGround: { type: "number" }, headingDeg: { type: "number" }, scale: { type: "number", exclusiveMinimum: 0 }, modelUnit: { type: "number", exclusiveMinimum: 0 }, verticalFactor: { type: "number", exclusiveMinimum: 0 }, upAxis: { enum: ["y", "z"] }, grid: { type: "object", required: ["epsg", "x", "y", "northDeg", "groundPerGrid"], properties: { epsg: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, northDeg: { type: "number" }, groundPerGrid: { type: "number", exclusiveMinimum: 0 } }, additionalProperties: false } },
  additionalProperties: false,
} as const;
const idParam = { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } } as const;

/** Builds the API (WP 3.1). Every request that reads a model or changes anything is audited (WP 3.8, NFR-11). */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(swagger, {
    openapi: { info: { title: "VIEWER library API", version: "0.1.0", description: "Library, versions and audit for the 3D Intelligence Model Viewer." } },
    // Shared schemas keep their names in the published document (components/schemas/ModelSummary…).
    refResolver: { buildLocalReference: (json, _base, _frag, i) => (typeof json.$id === "string" ? json.$id : `def-${i}`) },
  });
  addSchemas(app);
  // Every API route can answer with an error object; say so once here rather than on each route.
  app.addHook("onRoute", (r) => {
    if (!r.url.startsWith("/api/") || (r.schema as { hide?: boolean } | undefined)?.hide) return;
    r.schema = { ...r.schema, response: { "4xx": ref("Error"), "5xx": ref("Error"), ...((r.schema?.response as object) ?? {}) } };
  });
  if (opts.contract ?? !!process.env.VITEST) await checkContract(app);

  const cors = opts.corsOrigins ?? [];
  if (cors.length) {
    app.addHook("onRequest", async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin || !(cors.includes("*") || cors.includes(origin))) return;
      reply
        .header("access-control-allow-origin", origin)
        .header("vary", "origin")
        .header("access-control-expose-headers", "upload-offset, upload-length, tus-resumable, etag, content-range, accept-ranges");
      if (req.method === "OPTIONS") {
        reply
          .header("access-control-allow-methods", "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS")
          .header("access-control-allow-headers", "authorization, content-type, upload-offset, upload-length, tus-resumable, x-workstation, range, if-none-match")
          .header("access-control-max-age", "600");
        return reply.status(204).send();
      }
    });
  }

  if (opts.writeRateLimit && opts.writeRateLimit > 0) {
    const wait = writeLimiter(opts.writeRateLimit);
    app.addHook("onRequest", async (req, reply) => {
      if (!WRITE_METHODS.has(req.method) || req.url.startsWith("/api/tus/")) return;
      const s = wait(req.ip);
      if (s > 0) return reply.status(429).header("retry-after", String(s)).send(problem("rateLimited", { seconds: s }, { code: "RATE_LIMITED" }));
    });
  }

  const hostCache = new Map<string, string>();
  const hostOf = async (req: FastifyRequest): Promise<string> => {
    // The desktop app sends the Windows computer name; browsers cannot, so the server looks up the IP.
    const ws = req.headers["x-workstation"];
    if (typeof ws === "string" && ws.trim()) return ws.trim().slice(0, 200);
    if (!opts.reverseDns) return "";
    const hit = hostCache.get(req.ip);
    if (hit !== undefined) return hit;
    const name = await Promise.race([dns.reverse(req.ip).then((n) => n[0] ?? "").catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), 300))]);
    if (hostCache.size >= MAX_TRACKED) hostCache.delete(hostCache.keys().next().value!);
    hostCache.set(req.ip, name);
    return name;
  };
  const who = async (req: FastifyRequest) => ({ ip: req.ip, host: await hostOf(req) });

  app.setErrorHandler((err: { statusCode?: number; message: string; code?: string }, _req, reply) => {
    if (err instanceof ServerError) return reply.status(err.status ?? 400).send(problem(err.key, err.params));
    const status = err.statusCode ?? 500;
    // A request the schema or Fastify refused keeps its own (English) detail.
    reply.status(status).send(status >= 500 ? problem("serverFailed", undefined, { code: err.code }) : problem("invalidRequest", { detail: err.message }, { code: err.code }));
  });

  // Readiness, for a load balancer or monitor: the database answers and storage can be written.
  // 503 names what failed. /api/health/live only says the process answers.
  const health = closed({ ok: bool, db: text, checks: closed({ database: text, storage: text }, ["database", "storage"]), error: text }, ["ok", "db", "checks"]);
  app.get("/api/health", { schema: { tags: ["system"], response: { 200: health, 503: health } } }, async (_req, reply) => {
    const checks = { database: "ok", storage: opts.storage ? "ok" : "off" };
    const failed: string[] = [];
    try {
      await withTimeout(db.query("SELECT 1"), 3000);
    } catch (e) {
      checks.database = `failed: ${(e as Error).message}`.slice(0, 300);
      failed.push("database");
    }
    if (opts.storage) {
      const probe = path.join(opts.storage.root, `.health-${process.pid}-${Date.now()}`);
      try {
        await withTimeout(writeFile(probe, "ok").then(() => rm(probe, { force: true })), 3000);
      } catch (e) {
        checks.storage = `failed: ${(e as Error).message}`.slice(0, 300);
        failed.push("storage");
      }
    }
    if (failed.length) return reply.status(503).send({ ok: false, db: db.kind, checks, error: `Not ready: ${failed.join(" and ")} failed.` });
    return { ok: true, db: db.kind, checks };
  });
  app.get("/api/health/live", { schema: { tags: ["system"], response: { 200: closed({ ok: bool }, ["ok"]) } } }, async () => ({ ok: true }));

  app.get("/api/classifications", { schema: { tags: ["library"], response: { 200: arrayOf("Classification") } } }, async () =>
    (await db.query<{ id: string; label: string; color: string; text_color: string; ord: number }>("SELECT * FROM classifications ORDER BY ord")).map((c) => ({
      id: c.id,
      label: c.label,
      color: c.color,
      textColor: c.text_color,
      order: c.ord,
    })),
  );

  app.get<{ Querystring: LibraryFilter }>(
    "/api/models",
    {
      schema: {
        tags: ["library"],
        querystring: { type: "object", properties: { q: str, project: str, operation: str, status: { enum: UPDATE_STATUSES }, entity: str, classification: str } },
        response: { 200: arrayOf("ModelSummary") },
      },
    },
    async (req) => listModels(db, req.query),
  );

  app.get<{ Params: { id: string }; Querystring: { version?: number } }>(
    "/api/models/:id",
    {
      schema: {
        tags: ["library"],
        params: idParam,
        querystring: { type: "object", properties: { version: { type: "integer", minimum: 1, description: "Open an earlier version. Left out, the current one." } }, additionalProperties: false },
        response: { 200: ref("ModelDetail") },
      },
    },
    async (req, reply) => {
      const m = await getModel(db, req.params.id, req.query.version);
      if (!m) return reply.status(404).send(req.query.version && (await getModel(db, req.params.id)) ? problem("noVersion", { version: req.query.version }) : problem("noModel"));
      await audit(db, { ...(await who(req)), action: "model.view", target: m.id, detail: { version: m.version } });
      return { ...m, history: await listVersions(db, m.id) };
    },
  );

  app.post<{ Body: NewModel }>(
    "/api/models",
    {
      schema: {
        tags: ["library"],
        body: {
          type: "object",
          required: ["name", "status", "classificationId", "sourceFormat", "source", "centre"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 300 },
            project: str,
            operation: str,
            responsibleEntity: str,
            description: { type: "string", maxLength: 20000 },
            status: { enum: UPDATE_STATUSES },
            classificationId: { type: "string", minLength: 1 },
            sourceFormat: { enum: FORMATS },
            source,
            centre,
            placement,
            sizeBytes: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        response: { 201: ref("ModelSummary") },
      },
    },
    async (req, reply) => {
      const [cls] = await db.query("SELECT 1 FROM classifications WHERE id = $1", [req.body.classificationId]);
      if (!cls) return reply.status(400).send(problem("unknownClassification"));
      const w = await who(req);
      const id = await db.tx(async (q) => {
        const id = await createModel(q, { ...req.body, id: undefined, versions: 1 });
        await audit(q, { ...w, action: "model.create", target: id, detail: { name: req.body.name, classificationId: req.body.classificationId, status: req.body.status } });
        return id;
      });
      return reply.status(201).send(await getModel(db, id));
    },
  );

  app.patch<{ Params: { id: string }; Body: ModelPatch }>(
    "/api/models/:id",
    {
      schema: {
        tags: ["library"],
        params: idParam,
        body: {
          type: "object",
          minProperties: 1,
          properties: { name: { type: "string", minLength: 1, maxLength: 300 }, project: str, operation: str, responsibleEntity: str, description: { type: "string", maxLength: 20000 }, status: { enum: UPDATE_STATUSES }, classificationId: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: { 200: ref("ModelSummary") },
      },
    },
    async (req, reply) => {
      if (req.body.classificationId) {
        const [cls] = await db.query("SELECT 1 FROM classifications WHERE id = $1", [req.body.classificationId]);
        if (!cls) return reply.status(400).send(problem("unknownClassification"));
      }
      const w = await who(req);
      const changes = await db.tx(async (q) => {
        const c = await updateModel(q, req.params.id, req.body);
        if (c && Object.keys(c).length) await audit(q, { ...w, action: "model.update", target: req.params.id, detail: { changes: c } });
        if (c?.classificationId && opts.thumbnails) {
          const [m] = await q.query<{ v: number }>("SELECT current_version AS v FROM models WHERE id = $1", [req.params.id]);
          await enqueue(q, "thumbnail", { modelId: req.params.id, version: m!.v });
        }
        return c;
      });
      if (!changes) return reply.status(404).send(problem("noModel"));
      return getModel(db, req.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { source: NewModel["source"]; placement?: NewModel["placement"]; sizeBytes?: number; note?: string } }>(
    "/api/models/:id/versions",
    {
      schema: {
        tags: ["library"],
        params: idParam,
        body: { type: "object", required: ["source"], properties: { source, placement, sizeBytes: { type: "integer", minimum: 0 }, note: str }, additionalProperties: false },
        response: { 201: ref("ModelSummary") },
      },
    },
    async (req, reply) => {
      const w = await who(req);
      const v = await db.tx(async (q) => {
        const v = await addVersion(q, req.params.id, req.body);
        if (v) await audit(q, { ...w, action: "version.create", target: req.params.id, detail: { version: v, note: req.body.note ?? "" } });
        return v;
      });
      if (!v) return reply.status(404).send(problem("noModel"));
      return reply.status(201).send(await getModel(db, req.params.id));
    },
  );

  // The producer's arrangement of the layers (WP 2.1 applies it, WP 4.3 edits it).
  const manifestAnswer = closed({ version: int, manifest: { anyOf: [ref("LayerManifest"), { type: "null" }] } }, ["version", "manifest"]);
  app.get<{ Params: { id: string }; Querystring: { version?: number } }>(
    "/api/models/:id/layers",
    {
      schema: {
        tags: ["library"],
        params: idParam,
        querystring: { type: "object", properties: { version: { type: "integer", minimum: 1, description: "An earlier version's. Left out, the current one." } }, additionalProperties: false },
        response: { 200: manifestAnswer },
      },
    },
    async (req, reply) => (await getManifest(db, req.params.id, req.query.version)) ?? reply.status(404).send(problem("noModelOrVersion")),
  );
  app.put<{ Params: { id: string }; Body: { manifest: LayerManifest | null } }>(
    "/api/models/:id/layers",
    {
      schema: {
        tags: ["library"],
        params: idParam,
        body: closed({ manifest: { anyOf: [ref("LayerManifest"), { type: "null" }] } }, ["manifest"]),
        response: { 200: manifestAnswer },
      },
    },
    async (req, reply) => {
      const bad = req.body.manifest && manifestProblem(req.body.manifest);
      if (bad) return reply.status(400).send(problem(bad));
      const w = await who(req);
      const version = await db.tx(async (q) => {
        const v = await setManifest(q, req.params.id, req.body.manifest);
        if (v) await audit(q, { ...w, action: "layers.update", target: req.params.id, detail: { version: v, layers: req.body.manifest?.layers.length ?? 0, cleared: !req.body.manifest } });
        return v;
      });
      if (!version) return reply.status(404).send(problem("noModel"));
      return { version, manifest: req.body.manifest };
    },
  );

  const admin = registerAdmin(app, db, { storage: opts.storage, who, thumbnails: opts.thumbnails });

  // The audit log says who opened what, so reading it is for the administrator (admin page, WP 3.9).
  const auditQuery = {
    type: "object",
    properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, action: str, target: str, limit: { type: "integer", minimum: 1, maximum: 100000, default: 1000 } },
  } as const;
  type AuditQ = { from?: string; to?: string; action?: string; target?: string; limit?: number };
  const auditRows = (f: AuditQ) => {
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => (p.push(v), where.push(sql.replace("?", `$${p.length}`)));
    if (f.from) add("at >= ?", f.from);
    if (f.to) add("at < ?", f.to);
    if (f.action) add("action = ?", f.action);
    if (f.target) add("target = ?", f.target);
    p.push(f.limit ?? 1000);
    return db.query<AuditRow>(`SELECT * FROM audit_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT $${p.length}`, p);
  };

  app.get<{ Querystring: AuditQ }>("/api/audit", { onRequest: admin, schema: { tags: ["audit"], querystring: auditQuery, response: { 200: arrayOf("AuditEvent") } } }, async (req) =>
    (await auditRows(req.query)).map((r) => ({ ...r, seq: Number(r.seq), at: new Date(r.at).toISOString() })),
  );
  app.get<{ Querystring: AuditQ }>("/api/audit.csv", { onRequest: admin, schema: { tags: ["audit"], querystring: auditQuery, response: { 200: { description: "The log as CSV (UTF-8 with BOM), oldest first.", content: { "text/csv": { schema: { type: "string" } } } } } } }, async (req, reply) => {
    await audit(db, { ...(await who(req)), action: "audit.export", detail: { ...req.query } });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="viewer-audit.csv"');
    return "﻿" + auditCsv((await auditRows(req.query)).reverse());
  });
  app.get("/api/audit/verify", { onRequest: admin, schema: { tags: ["audit"], response: { 200: closed({ ok: bool, count: int, brokenAt: text, firstSeq: int }, ["ok", "count"]) } } }, async () => verifyAudit(db));

  if (opts.storage) {
    registerFiles(app, opts.storage);
    registerIngest(app, db, opts.storage, who);
  }

  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
