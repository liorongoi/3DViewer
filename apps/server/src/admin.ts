import { createHash, randomBytes } from "node:crypto";
import { rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { argon2id, argon2Verify } from "hash-wasm";
import { audit } from "./audit.ts";
import type { Db, Queryable } from "./db.ts";
import { enqueue } from "./jobs.ts";
import type { Storage } from "./storage.ts";

/**
 * Admin (WP 3.9, VWR-ADM-01, ADM-02, RND-11). There are no user accounts: one admin password,
 * hashed with argon2id, opens the admin API for a session of a few hours. Behind it: the
 * classification levels, permanent delete, the storage quota and the base map sources.
 */

type Who = (req: FastifyRequest) => Promise<{ ip: string; host: string }>;

export interface AdminOptions {
  storage?: Storage;
  who: Who;
  /** A thumbnail worker runs, so changing a level's colours re-renders the band on its models' thumbnails. */
  thumbnails?: boolean;
  /** How long a sign-in lasts. */
  sessionHours?: number;
}

// argon2id with 64 MiB, 3 passes, 1 lane: RFC 9106's second recommended setting, about 0.2 s here.
const ARGON = { memorySize: 64 * 1024, iterations: 3, parallelism: 1, hashLength: 32 };
export const MIN_PASSWORD = 12;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...ARGON, outputType: "encoded" });
}

export async function getSetting<T>(q: Queryable, key: string): Promise<T | undefined> {
  const [r] = await q.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return r?.value;
}

export async function setSetting(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
}

/**
 * Sets the first admin password from ADMIN_PASSWORD when none is stored yet. A stored password is
 * kept unless `reset` (ADMIN_PASSWORD_RESET=1), which is how someone at the server recovers it.
 */
export async function ensureAdminPassword(db: Db, password: string | undefined, reset = false): Promise<"set" | "reset" | "kept" | "missing"> {
  const stored = await getSetting<string>(db, "admin.password");
  if (stored && !(reset && password)) return "kept";
  if (!password) return "missing";
  if (password.length < MIN_PASSWORD) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
  await db.tx(async (q) => {
    await setSetting(q, "admin.password", await hashPassword(password));
    await q.query("DELETE FROM admin_sessions");
    await audit(q, { ip: "", host: "server", action: stored ? "admin.password.reset" : "admin.password.set", detail: { by: "ADMIN_PASSWORD" } });
  });
  return stored ? "reset" : "set";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** WCAG 2.1 contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Bytes used by published versions plus uploads still in progress. */
export async function storageUsage(q: Queryable): Promise<{ publishedBytes: number; uploadingBytes: number; usedBytes: number; models: number; versions: number }> {
  const [p] = await q.query<{ b: string | number | null; v: string | number; m: string | number }>("SELECT sum(size_bytes) AS b, count(*) AS v, count(DISTINCT model_id) AS m FROM versions");
  const [u] = await q.query<{ b: string | number | null }>(
    "SELECT sum(u.length) AS b FROM uploads u JOIN ingests i ON i.id = u.ingest_id WHERE i.state IN ('uploading', 'queued', 'checking', 'converting')",
  );
  const publishedBytes = Number(p?.b ?? 0), uploadingBytes = Number(u?.b ?? 0);
  return { publishedBytes, uploadingBytes, usedBytes: publishedBytes + uploadingBytes, models: Number(p?.m ?? 0), versions: Number(p?.v ?? 0) };
}

/** The quota check for a new upload: an error message, or null when it fits. */
export async function quotaError(q: Queryable, addBytes: number): Promise<string | null> {
  const quota = await getSetting<number | null>(q, "storage.quotaBytes");
  if (quota == null) return null;
  const { usedBytes } = await storageUsage(q);
  if (usedBytes + addBytes <= quota) return null;
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `The library is full: ${gb(usedBytes)} of ${gb(quota)} is used and this upload needs ${gb(addBytes)}. Ask the administrator to free space or raise the quota.`;
}

// ---- Base map sources (RND-11) ----

export interface BaseMapSource {
  id: string;
  label: string;
  /** Imagery draped on the globe, or terrain under it. */
  kind: "imagery" | "terrain";
  /** xyz / tms / wmts for imagery; terrarium (PNG heights) or quantized-mesh for terrain. */
  type: "xyz" | "tms" | "wmts" | "terrarium" | "quantized-mesh";
  /** Template with {z}/{x}/{y} for xyz and terrarium; the service root for tms, wmts and quantized-mesh. Relative paths resolve against the web app. */
  url: string;
  layer?: string;
  style?: string;
  matrixSet?: string;
  format?: string;
  maxZoom?: number;
  attribution?: string;
}

export interface BaseMapConfig {
  sources: BaseMapSource[];
  /** What the viewer opens with; ids from `sources` or the built-in catalogue. */
  defaultImagery?: string;
  defaultTerrain?: string;
  /** Hide the built-in internet presets, for the internal network. */
  hideOnline?: boolean;
}

const short = { type: "string", maxLength: 200 } as const;
const baseMapSchema = {
  type: "object",
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: ["id", "label", "kind", "type", "url"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
          label: { type: "string", minLength: 1, maxLength: 200 },
          kind: { enum: ["imagery", "terrain"] },
          type: { enum: ["xyz", "tms", "wmts", "terrarium", "quantized-mesh"] },
          url: { type: "string", minLength: 1, maxLength: 2000 },
          layer: short,
          style: short,
          matrixSet: short,
          format: short,
          maxZoom: { type: "integer", minimum: 0, maximum: 30 },
          attribution: { type: "string", maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
    defaultImagery: short,
    defaultTerrain: short,
    hideOnline: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

/** Problems a schema cannot see: duplicate ids, a source type that does not fit its kind, a bad URL. */
export function baseMapProblems(c: BaseMapConfig): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of c.sources) {
    if (seen.has(s.id)) out.push(`Two sources have the id "${s.id}".`);
    seen.add(s.id);
    const terrain = s.type === "terrarium" || s.type === "quantized-mesh";
    if (terrain !== (s.kind === "terrain")) out.push(`"${s.label}": a ${s.type} source is ${terrain ? "terrain" : "imagery"}, not ${s.kind}.`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(s.url) && !/^https?:\/\//i.test(s.url)) out.push(`"${s.label}": the address must start with http://, https:// or be a path on this server.`);
    if ((s.type === "xyz" || s.type === "terrarium") && !/\{z\}/.test(s.url)) out.push(`"${s.label}": an ${s.type} address needs {z}, {x} and {y} in it.`);
    if (s.type === "wmts" && !s.layer) out.push(`"${s.label}": a WMTS source needs its layer name.`);
  }
  return out;
}

// ---- Routes ----

const LOCK_AFTER = 5;

export function registerAdmin(app: FastifyInstance, db: Db, opts: AdminOptions): onRequestAsyncHookHandler {
  const hours = opts.sessionHours ?? 8;
  const fails = new Map<string, { n: number; until: number }>();

  const session = async (req: FastifyRequest) => {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const [s] = await db.query<{ token_hash: string }>("SELECT token_hash FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()", [sha(m[1]!)]);
    return s?.token_hash ?? null;
  };
  const guard: onRequestAsyncHookHandler = async (req, reply) => {
    if (!(await session(req))) return reply.status(401).send({ error: "Sign in as administrator first." });
  };

  app.get("/api/admin/status", { schema: { tags: ["admin"] } }, async (req) => ({
    passwordSet: !!(await getSetting<string>(db, "admin.password")),
    signedIn: !!(await session(req)),
  }));

  app.post<{ Body: { password: string } }>(
    "/api/admin/login",
    { schema: { tags: ["admin"], body: { type: "object", required: ["password"], properties: { password: { type: "string", maxLength: 500 } }, additionalProperties: false } } },
    async (req, reply) => {
      const w = await opts.who(req);
      const f = fails.get(req.ip);
      if (f && f.until > Date.now()) {
        const s = Math.ceil((f.until - Date.now()) / 1000);
        return reply.status(429).header("retry-after", s).send({ error: `Too many wrong passwords. Try again in ${s} s.` });
      }
      const stored = await getSetting<string>(db, "admin.password");
      if (!stored) return reply.status(503).send({ error: "No admin password is set. The person who runs the server sets ADMIN_PASSWORD and restarts it." });
      if (!(await argon2Verify({ password: req.body.password, hash: stored }))) {
        const n = (f?.n ?? 0) + 1;
        // After 5 wrong tries in a row, wait 30 s, then twice as long after each further miss, up to 15 min.
        fails.set(req.ip, { n, until: n >= LOCK_AFTER ? Date.now() + Math.min(15 * 60, 30 * 2 ** (n - LOCK_AFTER)) * 1000 : 0 });
        await audit(db, { ...w, action: "admin.login.failed", detail: { attempt: n } });
        return reply.status(401).send({ error: "Wrong password." });
      }
      fails.delete(req.ip);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
      await db.tx(async (q) => {
        await q.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
        await q.query("INSERT INTO admin_sessions (token_hash, ip, host, expires_at) VALUES ($1, $2, $3, $4)", [sha(token), w.ip, w.host, expiresAt]);
        await audit(q, { ...w, action: "admin.login" });
      });
      return { token, expiresAt };
    },
  );

  app.post("/api/admin/logout", { schema: { tags: ["admin"] }, onRequest: guard }, async (req) => {
    const h = await session(req);
    await db.tx(async (q) => {
      await q.query("DELETE FROM admin_sessions WHERE token_hash = $1", [h]);
      await audit(q, { ...(await opts.who(req)), action: "admin.logout" });
    });
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>(
    "/api/admin/password",
    {
      onRequest: guard,
      schema: {
        tags: ["admin"],
        body: { type: "object", required: ["current", "next"], properties: { current: { type: "string", maxLength: 500 }, next: { type: "string", minLength: MIN_PASSWORD, maxLength: 500 } }, additionalProperties: false },
      },
    },
    async (req, reply) => {
      const stored = (await getSetting<string>(db, "admin.password"))!;
      if (!(await argon2Verify({ password: req.body.current, hash: stored }))) return reply.status(400).send({ error: "The current password is wrong." });
      const hash = await hashPassword(req.body.next);
      const mine = await session(req);
      await db.tx(async (q) => {
        await setSetting(q, "admin.password", hash);
        // Every other sign-in ends; this one carries on.
        await q.query("DELETE FROM admin_sessions WHERE token_hash <> $1", [mine]);
        await audit(q, { ...(await opts.who(req)), action: "admin.password.change" });
      });
      return { ok: true };
    },
  );

  // Classification levels (ADM-02, UPL-10).
  const hex = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } as const;
  app.put<{ Params: { id: string }; Body: { label: string; color: string; textColor: string; order: number } }>(
    "/api/admin/classifications/:id",
    {
      onRequest: guard,
      schema: {
        tags: ["admin"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } } },
        body: {
          type: "object",
          required: ["label", "color", "textColor", "order"],
          properties: { label: { type: "string", minLength: 1, maxLength: 100 }, color: hex, textColor: hex, order: { type: "integer", minimum: 0, maximum: 1000 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      // The band must stay readable (NFR-17): WCAG AA for normal text.
      const ratio = contrast(b.color, b.textColor);
      if (ratio < 4.5) return reply.status(400).send({ error: `The text colour on the band colour has a contrast of ${ratio.toFixed(1)}:1; it needs at least 4.5:1 to be readable.` });
      const id = req.params.id;
      const w = await opts.who(req);
      const result = await db.tx(async (q) => {
        const [old] = await q.query<{ label: string; color: string; text_color: string; ord: number }>("SELECT * FROM classifications WHERE id = $1", [id]);
        await q.query(
          "INSERT INTO classifications (id, label, color, text_color, ord) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, color = EXCLUDED.color, text_color = EXCLUDED.text_color, ord = EXCLUDED.ord",
          [id, b.label, b.color.toUpperCase(), b.textColor.toUpperCase(), b.order],
        );
        await audit(q, { ...w, action: old ? "classification.update" : "classification.create", target: id, detail: { label: b.label, color: b.color, textColor: b.textColor, order: b.order, ...(old ? { was: { label: old.label, color: old.color, textColor: old.text_color, order: old.ord } } : {}) } });
        // The band is burned into thumbnails, so a change of look renders them again.
        let rerender = 0;
        if (old && opts.thumbnails && (old.label !== b.label || old.color.toUpperCase() !== b.color.toUpperCase() || old.text_color.toUpperCase() !== b.textColor.toUpperCase())) {
          const ms = await q.query<{ id: string; v: number }>("SELECT id, current_version AS v FROM models WHERE classification_id = $1 AND deleted_at IS NULL", [id]);
          for (const m of ms) await enqueue(q, "thumbnail", { modelId: m.id, version: m.v });
          rerender = ms.length;
        }
        return { created: !old, rerender };
      });
      return reply.status(result.created ? 201 : 200).send({ id, label: b.label, color: b.color.toUpperCase(), textColor: b.textColor.toUpperCase(), order: b.order, thumbnailsQueued: result.rerender });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/classifications/:id",
    { onRequest: guard, schema: { tags: ["admin"], params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 100 } } } } },
    async (req, reply) => {
      const id = req.params.id;
      const [{ n }] = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM models WHERE classification_id = $1", [id])) as [{ n: number }];
      if (n) return reply.status(409).send({ error: `${n} model${n === 1 ? " is" : "s are"} at this level. Move ${n === 1 ? "it" : "them"} to another level first.` });
      const [{ c }] = (await db.query<{ c: number }>("SELECT count(*)::int AS c FROM classifications")) as [{ c: number }];
      const w = await opts.who(req);
      const gone = await db.tx(async (q) => {
        const [old] = await q.query<{ label: string }>("SELECT label FROM classifications WHERE id = $1", [id]);
        if (!old) return false;
        if (c <= 1) throw Object.assign(new Error("The last level cannot be removed; every model needs one."), { statusCode: 409 });
        await q.query("DELETE FROM classifications WHERE id = $1", [id]);
        await audit(q, { ...w, action: "classification.delete", target: id, detail: { label: old.label } });
        return true;
      });
      if (!gone) return reply.status(404).send({ error: "No level with this id." });
      return { ok: true };
    },
  );

  // Permanent delete (ADM-01, ADM-02): the model, every version, its files. The audit trail stays.
  app.delete<{ Params: { id: string }; Body: { confirm: string } }>(
    "/api/admin/models/:id",
    {
      onRequest: guard,
      schema: {
        tags: ["admin"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } },
        body: { type: "object", required: ["confirm"], properties: { confirm: { type: "string", maxLength: 300 } }, additionalProperties: false },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const [m] = await db.query<{ name: string; classification_id: string }>("SELECT name, classification_id FROM models WHERE id = $1", [id]);
      if (!m) return reply.status(404).send({ error: "No model with this id." });
      if (req.body.confirm.trim() !== m.name.trim()) return reply.status(400).send({ error: "To delete for good, type the model's name exactly." });
      const w = await opts.who(req);
      const freed = await db.tx(async (q) => {
        const [v] = await q.query<{ b: string | number | null; n: number }>("SELECT sum(size_bytes) AS b, count(*)::int AS n FROM versions WHERE model_id = $1", [id]);
        await q.query("DELETE FROM uploads WHERE ingest_id IN (SELECT id FROM ingests WHERE model_id = $1)", [id]);
        await q.query("DELETE FROM ingests WHERE model_id = $1", [id]);
        await q.query("DELETE FROM jobs WHERE state IN ('queued', 'running') AND payload->>'modelId' = $1", [id]);
        await q.query("DELETE FROM models WHERE id = $1", [id]);
        const detail = { name: m.name, classificationId: m.classification_id, versions: v?.n ?? 0, bytes: Number(v?.b ?? 0) };
        await audit(q, { ...w, action: "model.delete", target: id, detail });
        return detail;
      });
      // Files go after the rows, so a crash here leaves only unreferenced files, never a model without files.
      if (opts.storage) {
        const dir = path.join(opts.storage.files, id);
        if (path.dirname(dir) === opts.storage.files) await rm(dir, { recursive: true, force: true });
      }
      return { ok: true, ...freed };
    },
  );

  // Storage quota and usage (ADM-02).
  app.get("/api/admin/storage", { onRequest: guard, schema: { tags: ["admin"] } }, async () => {
    const usage = await storageUsage(db);
    const quotaBytes = (await getSetting<number | null>(db, "storage.quotaBytes")) ?? null;
    let disk: { freeBytes: number; totalBytes: number } | null = null;
    if (opts.storage) {
      const s = await statfs(opts.storage.root).catch(() => null);
      if (s) disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    }
    return { ...usage, quotaBytes, disk };
  });

  app.put<{ Body: { quotaBytes: number | null } }>(
    "/api/admin/storage",
    {
      onRequest: guard,
      schema: { tags: ["admin"], body: { type: "object", required: ["quotaBytes"], properties: { quotaBytes: { type: ["integer", "null"], minimum: 0 } }, additionalProperties: false } },
    },
    async (req) => {
      const w = await opts.who(req);
      await db.tx(async (q) => {
        const was = (await getSetting<number | null>(q, "storage.quotaBytes")) ?? null;
        await setSetting(q, "storage.quotaBytes", req.body.quotaBytes);
        await audit(q, { ...w, action: "settings.quota", detail: { quotaBytes: req.body.quotaBytes, was } });
      });
      return { quotaBytes: req.body.quotaBytes };
    },
  );

  // Base map sources (RND-11). Everyone reads them; only the admin changes them.
  app.get("/api/basemaps", { schema: { tags: ["library"] } }, async () => (await getSetting<BaseMapConfig>(db, "basemaps")) ?? { sources: [] });

  app.put<{ Body: BaseMapConfig }>("/api/admin/basemaps", { onRequest: guard, schema: { tags: ["admin"], body: baseMapSchema } }, async (req, reply) => {
    const problems = baseMapProblems(req.body);
    if (problems.length) return reply.status(400).send({ error: problems.join(" "), problems });
    const w = await opts.who(req);
    await db.tx(async (q) => {
      await setSetting(q, "basemaps", req.body);
      await audit(q, { ...w, action: "settings.basemaps", detail: { sources: req.body.sources.map((s) => s.id), defaultImagery: req.body.defaultImagery, defaultTerrain: req.body.defaultTerrain, hideOnline: !!req.body.hideOnline } });
    });
    return req.body;
  });

  return guard;
}
