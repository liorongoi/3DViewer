import type { FastifyInstance } from "fastify";
import { UPDATE_STATUSES } from "@viewer/shared/model";

/**
 * What the API answers (WP 3.1). These schemas are the contract: they go into the published
 * OpenAPI, the web app's client is generated from it, and Fastify writes responses through them.
 * Every object is closed (additionalProperties: false) so a field the server starts sending that
 * the contract does not name fails the contract tests, instead of being dropped silently.
 */

const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const text = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const iso = { type: "string", format: "date-time" } as const;
/** A free-form JSON object (audit details, check reports, job progress). */
const anyObject = { type: "object", additionalProperties: true } as const;
const closed = <P extends Record<string, unknown>, R extends readonly (keyof P & string)[]>(properties: P, required: R) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const;

const LatLon = closed({ lat: num, lon: num }, ["lat", "lon"]);

const MODEL = {
  id: text,
  name: text,
  project: text,
  operation: text,
  responsibleEntity: text,
  description: text,
  status: { enum: UPDATE_STATUSES },
  statusChangedAt: text,
  classificationId: text,
  version: int,
  versions: int,
  sourceFormat: { enum: ["glb", "gltf", "fbx", "3dtiles"] },
  source: { $ref: "ModelSource#" },
  centre: LatLon,
  placement: { $ref: "Placement#" },
  thumbnail: text,
  sizeBytes: num,
} as const;
const MODEL_REQUIRED = ["id", "name", "project", "operation", "responsibleEntity", "description", "status", "statusChangedAt", "classificationId", "version", "versions", "sourceFormat", "source", "centre", "sizeBytes"] as const;

export const SCHEMAS = [
  { $id: "Error", ...closed({ error: text, code: text, problems: { type: "array", items: text }, files: { type: "array", items: text } }, ["error"]) },
  { $id: "Ok", ...closed({ ok: bool }, ["ok"]) },
  { $id: "Classification", ...closed({ id: text, label: text, color: text, textColor: text, order: int }, ["id", "label", "color", "textColor", "order"]) },
  {
    $id: "ModelSource",
    ...closed(
      { kind: { enum: ["glb", "3dtiles"] }, url: text, groundFit: { enum: ["street", "surface", "none"] }, clipTerrain: bool, localFrame: bool, georeferenced: bool, attribution: text },
      ["kind", "url"],
    ),
  },
  {
    $id: "Placement",
    ...closed({ lat: num, lon: num, height: num, aboveGround: num, headingDeg: num, scale: num, upAxis: { enum: ["y", "z"] }, grid: closed({ epsg: int, x: num, y: num, northDeg: num, groundPerGrid: num }, ["epsg", "x", "y", "northDeg", "groundPerGrid"]) }, ["lat", "lon", "height"]),
  },
  { $id: "ModelSummary", ...closed(MODEL, MODEL_REQUIRED) },
  { $id: "ModelDetail", ...closed({ ...MODEL, history: { type: "array", items: { $ref: "Version#" } } }, [...MODEL_REQUIRED, "history"]) },
  {
    $id: "ManifestLayer",
    ...closed({ name: { type: "string", maxLength: 300 }, nodes: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 100000 }, children: { type: "array", items: { $ref: "ManifestLayer#" } } }, ["name"]),
  },
  { $id: "LayerManifest", ...closed({ layers: { type: "array", items: { $ref: "ManifestLayer#" } } }, ["layers"]) },
  { $id: "Version", ...closed({ version: int, state: text, note: text, sizeBytes: num, createdAt: iso }, ["version", "state", "note", "sizeBytes", "createdAt"]) },
  {
    $id: "BaseMapConfig",
    ...closed(
      {
        sources: {
          type: "array",
          items: closed(
            {
              id: text,
              label: text,
              kind: { enum: ["imagery", "terrain"] },
              type: { enum: ["xyz", "tms", "wmts", "terrarium", "quantized-mesh"] },
              url: text,
              layer: text,
              style: text,
              matrixSet: text,
              format: text,
              maxZoom: int,
              attribution: text,
            },
            ["id", "label", "kind", "type", "url"],
          ),
        },
        defaultImagery: text,
        defaultTerrain: text,
        hideOnline: bool,
      },
      ["sources"],
    ),
  },
  {
    $id: "AuditEvent",
    ...closed({ seq: int, at: iso, ip: text, host: text, action: text, target: text, detail: anyObject, prev_hash: text, hash: text }, ["seq", "at", "ip", "host", "action", "target", "detail", "prev_hash", "hash"]),
  },
  {
    $id: "IngestStatus",
    ...closed(
      {
        id: text,
        state: { enum: ["uploading", "queued", "checking", "converting", "ready", "failed"] },
        modelId: { type: ["string", "null"] },
        version: { type: ["integer", "null"] },
        report: { anyOf: [anyObject, { type: "null" }] },
        error: { type: ["string", "null"] },
        upload: closed({ files: int, bytes: num, received: num }, ["files", "bytes", "received"]),
        job: { anyOf: [closed({ state: text, progress: anyObject, attempts: int, error: { type: ["string", "null"] } }, ["state", "progress", "attempts", "error"]), { type: "null" }] },
      },
      ["id", "state", "modelId", "version", "report", "error", "upload", "job"],
    ),
  },
] as const;

export const ref = (id: (typeof SCHEMAS)[number]["$id"]) => ({ $ref: `${id}#` }) as const;
export const arrayOf = (id: (typeof SCHEMAS)[number]["$id"]) => ({ type: "array", items: ref(id) }) as const;
export { closed, text, num, int, bool, iso, anyObject };

/** The error answers every route can give, beside its own success answers. */
export const errors = (...codes: number[]) => Object.fromEntries(codes.map((c) => [c, ref("Error")]));

export function addSchemas(app: FastifyInstance): void {
  for (const s of SCHEMAS) app.addSchema(s);
}

/**
 * Contract mode (tests): answers are written as they are, with no trimming to the schema, and each
 * JSON answer is checked against the schema for its status. One that does not match, or has no
 * schema, becomes a 500 naming the route and the mismatch, so the test that made the call fails.
 */
export async function checkContract(app: FastifyInstance): Promise<void> {
  const { default: Ajv } = await import("ajv");
  const { default: addFormats } = await import("ajv-formats");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const s of SCHEMAS) ajv.addSchema(s);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>();
  app.addHook("onSend", async (req, reply, payload) => {
    const schema = req.routeOptions.schema as { hide?: boolean; response?: Record<string, object> } | undefined;
    if (!req.url.startsWith("/api/") || !schema || schema.hide) return payload;
    if (!String(reply.getHeader("content-type") ?? "").includes("application/json") || typeof payload !== "string") return payload;
    const code = reply.statusCode;
    const responses = schema.response ?? {};
    const s = responses[code] ?? responses[`${String(code)[0]}xx`] ?? responses.default;
    const fail = (why: string) => {
      reply.status(500);
      return JSON.stringify({ error: `Contract: ${req.method} ${req.routeOptions.url} answered ${code}, ${why}` });
    };
    if (!s) return fail("which the published API does not list.");
    let check = compiled.get(s);
    if (!check) compiled.set(s, (check = ajv.compile(s)));
    if (!check(JSON.parse(payload))) return fail(`not as published: ${ajv.errorsText(check.errors)} — ${payload.slice(0, 300)}`);
    return payload;
  });
}
