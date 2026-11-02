import { promises as dns } from "node:dns";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import { UPDATE_STATUSES } from "@viewer/shared/model";
import { audit, auditCsv, verifyAudit, type AuditRow } from "./audit.ts";
import type { Db } from "./db.ts";
import { registerIngest } from "./ingest.ts";
import { enqueue } from "./jobs.ts";
import { registerFiles, type Storage } from "./storage.ts";
import { addVersion, createModel, getModel, listModels, listVersions, updateModel, type LibraryFilter, type ModelPatch, type NewModel } from "./library.ts";

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
}

const FORMATS = ["glb", "gltf", "fbx", "3dtiles"];
const str = { type: "string", maxLength: 2000 } as const;
const centre = { type: "object", required: ["lat", "lon"], properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 } } } as const;
const source = {
  type: "object",
  required: ["kind", "url"],
  properties: { kind: { enum: ["glb", "3dtiles"] }, url: { type: "string", maxLength: 4000 }, groundFit: { enum: ["street", "surface", "none"] }, clipTerrain: { type: "boolean" }, localFrame: { type: "boolean" }, attribution: str },
  additionalProperties: false,
} as const;
const placement = {
  type: "object",
  required: ["lat", "lon", "height"],
  properties: { lat: { type: "number" }, lon: { type: "number" }, height: { type: "number" }, aboveGround: { type: "number" }, headingDeg: { type: "number" }, scale: { type: "number", exclusiveMinimum: 0 }, upAxis: { enum: ["y", "z"] } },
  additionalProperties: false,
} as const;
const idParam = { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } } as const;

/** Builds the API (WP 3.1). Every request that reads a model or changes anything is audited (WP 3.8, NFR-11). */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(swagger, {
    openapi: { info: { title: "VIEWER library API", version: "0.1.0", description: "Library, versions and audit for the 3D Intelligence Model Viewer." } },
  });

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
          .header("access-control-allow-methods", "GET, HEAD, POST, PATCH, OPTIONS")
          .header("access-control-allow-headers", "content-type, upload-offset, upload-length, tus-resumable, x-workstation, range, if-none-match")
          .header("access-control-max-age", "600");
        return reply.status(204).send();
      }
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
    hostCache.set(req.ip, name);
    return name;
  };
  const who = async (req: FastifyRequest) => ({ ip: req.ip, host: await hostOf(req) });

  app.setErrorHandler((err: { statusCode?: number; message: string; code?: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    reply.status(status).send({ error: status >= 500 ? "The server could not complete the request." : err.message, code: err.code });
  });

  app.get("/api/health", { schema: { tags: ["system"] } }, async () => ({ ok: true, db: db.kind }));

  app.get("/api/classifications", { schema: { tags: ["library"] } }, async () =>
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
      },
    },
    async (req) => listModels(db, req.query),
  );

  app.get<{ Params: { id: string } }>("/api/models/:id", { schema: { tags: ["library"], params: idParam } }, async (req, reply) => {
    const m = await getModel(db, req.params.id);
    if (!m) return reply.status(404).send({ error: "No model with this id." });
    await audit(db, { ...(await who(req)), action: "model.view", target: m.id, detail: { version: m.version } });
    return { ...m, history: await listVersions(db, m.id) };
  });

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
      },
    },
    async (req, reply) => {
      const [cls] = await db.query("SELECT 1 FROM classifications WHERE id = $1", [req.body.classificationId]);
      if (!cls) return reply.status(400).send({ error: "Unknown classification. Choose one of the levels the admin defined." });
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
      },
    },
    async (req, reply) => {
      if (req.body.classificationId) {
        const [cls] = await db.query("SELECT 1 FROM classifications WHERE id = $1", [req.body.classificationId]);
        if (!cls) return reply.status(400).send({ error: "Unknown classification." });
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
      if (!changes) return reply.status(404).send({ error: "No model with this id." });
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
      },
    },
    async (req, reply) => {
      const w = await who(req);
      const v = await db.tx(async (q) => {
        const v = await addVersion(q, req.params.id, req.body);
        if (v) await audit(q, { ...w, action: "version.create", target: req.params.id, detail: { version: v, note: req.body.note ?? "" } });
        return v;
      });
      if (!v) return reply.status(404).send({ error: "No model with this id." });
      return reply.status(201).send(await getModel(db, req.params.id));
    },
  );

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

  app.get<{ Querystring: AuditQ }>("/api/audit", { schema: { tags: ["audit"], querystring: auditQuery } }, async (req) =>
    (await auditRows(req.query)).map((r) => ({ ...r, seq: Number(r.seq), at: new Date(r.at).toISOString() })),
  );
  app.get<{ Querystring: AuditQ }>("/api/audit.csv", { schema: { tags: ["audit"], querystring: auditQuery } }, async (req, reply) => {
    await audit(db, { ...(await who(req)), action: "audit.export", detail: { ...req.query } });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="viewer-audit.csv"');
    return "﻿" + auditCsv((await auditRows(req.query)).reverse());
  });
  app.get("/api/audit/verify", { schema: { tags: ["audit"] } }, async () => verifyAudit(db));

  if (opts.storage) {
    registerFiles(app, opts.storage);
    registerIngest(app, db, opts.storage, who);
  }

  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
