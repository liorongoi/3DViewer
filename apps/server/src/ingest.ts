import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Unzip, UnzipInflate } from "fflate";
import { checkFiles, checkItem, LIMITS, placementFromGrid, type CheckItem, type CheckReport, type LocalFile } from "@viewer/core/loaders";
import { UPDATE_STATUSES, type ModelSummary } from "@viewer/shared/model";
import { quotaError } from "./admin.ts";
import { audit } from "./audit.ts";
import type { Db, Queryable } from "./db.ts";
import { enqueue, PermanentError, type Handler } from "./jobs.ts";
import { addVersion, createModel, type NewModel } from "./library.ts";
import { closed, int, ref, text } from "./schemas.ts";
import { Storage, validRelPath } from "./storage.ts";
import { TILE_IF, optimiseGlbInWorker, tileModelInWorker } from "./tiler.ts";
import { validateOfficial } from "./validate.ts";

/**
 * Uploads and ingest (WP 3.2–3.4, 3.7).
 *
 * 1. POST /api/ingests names the files and the model they become; the answer has one tus URL per file.
 * 2. The client sends each file with tus (HEAD to learn the offset, PATCH to append), so a dropped
 *    connection resumes where it stopped.
 * 3. POST /api/ingests/:id/submit queues the "ingest" job: unpack zips with guards, check with the same
 *    loaders the browser uses, scan for viruses, convert FBX, publish under files/, and add the model
 *    or version with its report and audit row in one transaction.
 */

export interface IngestRequest {
  files: { path: string; size: number }[];
  /** Adds a version to this model. Without it, `model` creates a new one. */
  modelId?: string;
  model?: Pick<NewModel, "name" | "project" | "operation" | "responsibleEntity" | "description" | "status" | "classificationId">;
  placement?: ModelSummary["placement"];
  centre?: { lat: number; lon: number };
  groundFit?: "street" | "surface" | "none";
  note?: string;
}

export interface IngestOptions {
  /** clamdscan (or clamscan) binary. Unset: files are not scanned and the report says so. */
  clamdscan?: string;
  /** FBX2glTF binary. Unset: FBX uploads fail with a clear reason. */
  fbx2gltf?: string;
  /** Queue a thumbnail render after each publish (WP 3.5). */
  thumbnails?: boolean;
  /** Errors from the official glTF and 3D Tiles validators block publishing (otherwise they are warnings). */
  strictValidation?: boolean;
  /** Stop the official validator after this long. */
  validatorTimeoutMs?: number;
  /** When a model is tiled into 3D Tiles (default: over 1.5 M triangles or 300 MB). */
  tileIf?: { triangles: number; bytes: number };
  /** Most triangles in one tile. */
  leafTriangles?: number;
  /** Compress a GLB's geometry before publishing (default on). */
  optimise?: boolean;
}

const MAX_FILES = 100_000;
/** A zip entry that expands more than this many times over is treated as a zip bomb. */
const MAX_RATIO = 1000;
const TUS = "1.0.0";

const str = { type: "string", maxLength: 2000 } as const;
const latlon = { type: "object", required: ["lat", "lon"], properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 } } } as const;

interface UploadRow {
  id: string;
  ingest_id: string;
  path: string;
  length: string | number;
}
interface IngestRow {
  id: string;
  model_id: string | null;
  version: number | null;
  state: string;
  request: IngestRequest;
  report: CheckReport | null;
  error: string | null;
  ip: string;
  host: string;
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

async function fileSize(p: string): Promise<number> {
  return (await stat(p).catch(() => null))?.size ?? 0;
}

export function registerIngest(
  app: FastifyInstance,
  db: Db,
  storage: Storage,
  who: (req: FastifyRequest) => Promise<{ ip: string; host: string }>,
): void {
  // tus PATCH bodies are streamed to disk, never buffered.
  app.addContentTypeParser("application/offset+octet-stream", (_req, payload, done) => done(null, payload));

  app.post<{ Body: IngestRequest }>(
    "/api/ingests",
    {
      schema: {
        tags: ["upload"],
        body: {
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              minItems: 1,
              maxItems: MAX_FILES,
              items: { type: "object", required: ["path", "size"], properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, size: { type: "integer", minimum: 0 } }, additionalProperties: false },
            },
            modelId: { type: "string", maxLength: 200 },
            model: {
              type: "object",
              required: ["name", "status", "classificationId"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 300 },
                project: str,
                operation: str,
                responsibleEntity: str,
                description: { type: "string", maxLength: 20000 },
                status: { enum: UPDATE_STATUSES },
                classificationId: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
            placement: {
              type: "object",
              required: ["lat", "lon", "height"],
              properties: { lat: { type: "number" }, lon: { type: "number" }, height: { type: "number" }, aboveGround: { type: "number" }, headingDeg: { type: "number" }, scale: { type: "number", exclusiveMinimum: 0 }, upAxis: { enum: ["y", "z"] }, grid: { type: "object", required: ["epsg", "x", "y", "northDeg", "groundPerGrid"], properties: { epsg: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, northDeg: { type: "number" }, groundPerGrid: { type: "number", exclusiveMinimum: 0 } }, additionalProperties: false } },
              additionalProperties: false,
            },
            centre: latlon,
            groundFit: { enum: ["street", "surface", "none"] },
            note: str,
          },
          additionalProperties: false,
        },
        // Where to send each file with tus.
        response: {
          201: closed({ id: text, state: { enum: ["uploading"] }, uploads: { type: "array", items: closed({ path: text, size: int, url: text }, ["path", "size", "url"]) } }, ["id", "state", "uploads"]),
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (!b.modelId && !b.model) return reply.status(400).send({ error: "Name the model: give `model` for a new one or `modelId` for a new version." });
      if (b.modelId && !(await db.query("SELECT 1 FROM models WHERE id = $1 AND deleted_at IS NULL", [b.modelId])).length) return reply.status(404).send({ error: "No model with this id." });
      if (b.model && !(await db.query("SELECT 1 FROM classifications WHERE id = $1", [b.model.classificationId])).length) return reply.status(400).send({ error: "Unknown classification. Choose one of the levels the admin defined." });
      const seen = new Set<string>();
      let total = 0;
      for (const f of b.files) {
        if (!validRelPath(f.path)) return reply.status(400).send({ error: `This file name is not allowed: ${f.path}` });
        if (seen.has(f.path.toLowerCase())) return reply.status(400).send({ error: `The same file is listed twice: ${f.path}` });
        seen.add(f.path.toLowerCase());
        if (f.size > LIMITS.file) return reply.status(413).send({ error: `${f.path} is over 2 GB.` });
        total += f.size;
      }
      if (total > LIMITS.tileset) return reply.status(413).send({ error: "The upload is over 50 GB." });
      const full = await quotaError(db, total);
      if (full) return reply.status(507).send({ error: full });

      const w = await who(req);
      const id = `i-${crypto.randomUUID()}`;
      const uploads = b.files.map((f) => ({ id: crypto.randomUUID(), ...f }));
      await db.tx(async (q) => {
        await q.query("INSERT INTO ingests (id, model_id, request, ip, host) VALUES ($1, $2, $3, $4, $5)", [id, b.modelId ?? null, JSON.stringify(b), w.ip, w.host]);
        for (const u of uploads) await q.query("INSERT INTO uploads (id, ingest_id, path, length) VALUES ($1, $2, $3, $4)", [u.id, id, u.path, u.size]);
        await audit(q, { ...w, action: "ingest.create", target: b.modelId ?? id, detail: { ingest: id, files: b.files.length, bytes: total, name: b.model?.name } });
      });
      // Empty files are complete from the start.
      await Promise.all(uploads.map((u) => writeFile(storage.uploadPart(u.id), "", { flag: "a" })));
      return reply.status(201).send({ id, state: "uploading", uploads: uploads.map((u) => ({ path: u.path, size: u.size, url: `/api/tus/${u.id}` })) });
    },
  );

  const uploadById = async (id: string) => {
    const [u] = await db.query<UploadRow & { state: string }>("SELECT u.*, i.state FROM uploads u JOIN ingests i ON i.id = u.ingest_id WHERE u.id = $1", [id]);
    return u ?? null;
  };
  const tusParams = { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } as const;

  app.head<{ Params: { id: string } }>("/api/tus/:id", { schema: { tags: ["upload"], params: tusParams, response: { 200: { description: "Upload-Offset and Upload-Length say how much has arrived.", type: "null" } } } }, async (req, reply) => {
    const u = await uploadById(req.params.id);
    reply.header("tus-resumable", TUS).header("cache-control", "no-store");
    if (!u) return reply.status(404).send();
    return reply.header("upload-offset", await fileSize(storage.uploadPart(u.id))).header("upload-length", Number(u.length)).status(200).send();
  });

  app.patch<{ Params: { id: string }; Body: Readable }>(
    "/api/tus/:id",
    { bodyLimit: LIMITS.file, schema: { tags: ["upload"], params: tusParams, response: { 204: { description: "Stored; Upload-Offset is the new offset.", type: "null" } } } },
    async (req, reply) => {
      reply.header("tus-resumable", TUS);
      if (req.headers["content-type"] !== "application/offset+octet-stream") return reply.status(415).send({ error: "Send the bytes as application/offset+octet-stream." });
      const u = await uploadById(req.params.id);
      if (!u) return reply.status(404).send({ error: "No upload with this id." });
      if (u.state !== "uploading") return reply.status(409).send({ error: "This upload is already submitted." });
      const part = storage.uploadPart(u.id);
      const at = await fileSize(part);
      const claimed = Number(req.headers["upload-offset"]);
      if (!Number.isInteger(claimed) || claimed !== at) return reply.status(409).header("upload-offset", at).send({ error: `The upload is at byte ${at}.` });
      const length = Number(u.length);
      // Bytes past the declared length are read and dropped, so the client still gets an answer.
      let room = length - at;
      let overflow = false;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (chunk.length > room) overflow = true;
          const keep = chunk.subarray(0, Math.max(0, room));
          room -= keep.length;
          cb(null, keep.length ? keep : undefined);
        },
      });
      // If the connection drops, what arrived stays on disk and the client resumes from the offset HEAD reports.
      await pipeline(req.body, guard, createWriteStream(part, { flags: "a" })).catch(() => undefined);
      if (overflow) {
        const now = await fileSize(part);
        await db.query('UPDATE uploads SET "offset" = $2, updated_at = now() WHERE id = $1', [u.id, now]);
        return reply.status(413).header("upload-offset", now).send({ error: "More bytes than the declared file size." });
      }
      const offset = await fileSize(part);
      await db.query('UPDATE uploads SET "offset" = $2, updated_at = now() WHERE id = $1', [u.id, offset]);
      return reply.status(204).header("upload-offset", offset).send();
    },
  );

  app.post<{ Params: { id: string } }>("/api/ingests/:id/submit", { schema: { tags: ["upload"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 202: ref("IngestStatus") } } }, async (req, reply) => {
    const [ing] = await db.query<IngestRow>("SELECT * FROM ingests WHERE id = $1", [req.params.id]);
    if (!ing) return reply.status(404).send({ error: "No upload with this id." });
    if (ing.state !== "uploading") return reply.status(409).send({ error: "This upload is already submitted." });
    const ups = await db.query<UploadRow>("SELECT * FROM uploads WHERE ingest_id = $1", [ing.id]);
    const missing: string[] = [];
    for (const u of ups) if ((await fileSize(storage.uploadPart(u.id))) !== Number(u.length)) missing.push(u.path);
    if (missing.length) return reply.status(409).send({ error: "Some files have not finished uploading.", files: missing.slice(0, 50) });
    const w = await who(req);
    await db.tx(async (q) => {
      await q.query("UPDATE ingests SET state = 'queued', updated_at = now() WHERE id = $1", [ing.id]);
      await enqueue(q, "ingest", { ingestId: ing.id });
      await audit(q, { ...w, action: "ingest.submit", target: ing.model_id ?? ing.id, detail: { ingest: ing.id } });
    });
    return reply.status(202).send(await ingestStatus(db, storage, ing.id));
  });

  app.get<{ Params: { id: string } }>("/api/ingests/:id", { schema: { tags: ["upload"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 200: ref("IngestStatus") } } }, async (req, reply) => {
    const s = await ingestStatus(db, storage, req.params.id);
    return s ?? reply.status(404).send({ error: "No upload with this id." });
  });
}

export async function ingestStatus(db: Queryable, storage: Storage, id: string) {
  const [ing] = await db.query<IngestRow>("SELECT * FROM ingests WHERE id = $1", [id]);
  if (!ing) return null;
  const ups = await db.query<UploadRow>("SELECT * FROM uploads WHERE ingest_id = $1 ORDER BY path", [id]);
  const [job] = await db.query<{ state: string; progress: Record<string, unknown>; attempts: number; error: string | null }>(
    "SELECT state, progress, attempts, error FROM jobs WHERE kind = 'ingest' AND payload->>'ingestId' = $1 ORDER BY id DESC LIMIT 1",
    [id],
  );
  let received = 0;
  let total = 0;
  for (const u of ups) {
    total += Number(u.length);
    received += ing.state === "uploading" ? await fileSize(storage.uploadPart(u.id)) : Number(u.length);
  }
  return {
    id: ing.id,
    state: ing.state,
    modelId: ing.model_id,
    version: ing.version,
    report: ing.report,
    error: ing.error,
    upload: { files: ups.length, bytes: total, received },
    job: job ? { state: job.state, progress: job.progress, attempts: job.attempts, error: job.error } : null,
  };
}

// ---------------------------------------------------------------- the ingest job

/** A file on disk, shaped for the shared loaders. `src` survives the loaders' path rewrite. */
type DiskFile = LocalFile & { src: string };
const diskFile = (p: string, abs: string, size: number): DiskFile => ({ path: p, size, src: abs, bytes: async () => new Uint8Array(await readFile(abs)) });

async function listTree(root: string, rel = ""): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(root, r)));
    else if (e.isFile()) out.push(diskFile(r, path.join(root, r), (await stat(path.join(root, r))).size));
  }
  return out;
}

/**
 * Unpacks a zip into `dest` without trusting it: every name must stay inside, entries are counted, sizes
 * are measured as they inflate (not taken from the header) and a high expansion ratio stops it.
 */
export async function unzipGuarded(zipPath: string, dest: string, budget: { files: number; bytes: number }, name = path.basename(zipPath)): Promise<void> {
  const unz = new Unzip();
  unz.register(UnzipInflate);
  let failure: Error | null = null;
  const fail = (msg: string) => {
    failure ??= new PermanentError(msg);
  };
  unz.onfile = (f) => {
    if (failure) return;
    if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/")) return;
    const target = Storage.inside(dest, f.name);
    if (!target || !validRelPath(f.name)) return fail(`The zip has an entry that points outside the upload: ${f.name}`);
    if (--budget.files < 0) return fail(`The upload has more than ${MAX_FILES} files.`);
    mkdirSync(path.dirname(target), { recursive: true });
    const fd = openSync(target, "wx");
    let n = 0;
    const packed = Math.max(f.size ?? 0, 1);
    f.ondata = (err, chunk, final) => {
      if (failure) return closeSync(fd);
      if (err) return fail(`The zip is damaged at ${f.name}.`), closeSync(fd);
      n += chunk.length;
      budget.bytes -= chunk.length;
      if (n > LIMITS.file) return fail(`${f.name} inside the zip is over 2 GB.`), closeSync(fd);
      if (budget.bytes < 0) return fail("The unpacked upload is over 50 GB."), closeSync(fd);
      if (n > 10 * 1024 * 1024 && n / packed > MAX_RATIO) return fail(`${f.name} expands over ${MAX_RATIO} times; this looks like a zip bomb.`), closeSync(fd);
      writeSync(fd, chunk);
      if (final) closeSync(fd);
    };
    f.start();
  };
  try {
    for await (const chunk of createReadStream(zipPath, { highWaterMark: 1024 * 1024 })) {
      unz.push(chunk as Buffer);
      if (failure) break;
    }
    if (!failure) unz.push(new Uint8Array(0), true);
  } catch {
    fail(`${name} is not a readable zip file.`);
  }
  if (failure) throw failure;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** ClamAV hook. clamdscan exits 0 for clean, 1 for a virus, 2 for an error. */
async function scan(bin: string | undefined, dir: string): Promise<CheckItem> {
  if (!bin) return checkItem("scan", "warning", "notScanned");
  const r = await run(bin, ["--no-summary", "--infected", "--fdpass", dir], 30 * 60_000);
  if (r.code === 0) return checkItem("scan", "ok", "clean");
  if (r.code === 1) return checkItem("scan", "error", "virus", {}, r.out.split("\n").slice(0, 5).map((l) => l.replace(dir + path.sep, "")).join("\n"));
  throw new Error(`The virus scanner failed: ${r.out.slice(0, 300)}`);
}

/** FBX → GLB with FBX2glTF (decision in docs/spikes/FBX_BAKEOFF.md). */
async function convertFbx(bin: string | undefined, input: string, outDir: string): Promise<string> {
  if (!bin) throw new PermanentError("FBX conversion is not set up on this server. The administrator sets FBX2GLTF to the FBX2glTF program.");
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(input).replace(/\.fbx$/i, ""));
  const r = await run(bin, ["--binary", "--input", input, "--output", base], 30 * 60_000);
  const out = `${base}.glb`;
  if (r.code !== 0 || !(await fileSize(out))) throw new PermanentError(`FBX2glTF could not convert the file: ${r.out.split("\n").slice(-3).join(" ").slice(0, 400) || `exit code ${r.code}`}`);
  return out;
}

async function place(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await link(src, dest).catch(() => copyFile(src, dest));
}

export function ingestHandler(db: Db, storage: Storage, opts: IngestOptions): Handler {
  return async (job, ctx) => {
    const ingestId = String(job.payload.ingestId);
    const [ing] = await db.query<IngestRow>("SELECT * FROM ingests WHERE id = $1", [ingestId]);
    if (!ing) throw new PermanentError(`Ingest ${ingestId} does not exist.`);
    const ups = await db.query<UploadRow>("SELECT * FROM uploads WHERE ingest_id = $1", [ingestId]);
    const work = path.join(storage.ingests, ingestId);
    const cleanup = async () => {
      await rm(work, { recursive: true, force: true });
      await Promise.all(ups.map((u) => rm(storage.uploadPart(u.id), { force: true })));
    };
    // A rerun after the publish committed only has to tidy up.
    if (ing.state === "ready" || ing.state === "failed") return cleanup();

    const setState = (state: string) => db.query("UPDATE ingests SET state = $2, updated_at = now() WHERE id = $1", [ingestId, state]);
    const actor = { ip: ing.ip, host: ing.host };
    const reject = async (report: CheckReport, error: string) => {
      await db.tx(async (q) => {
        await q.query("UPDATE ingests SET state = 'failed', report = $2, error = $3, updated_at = now() WHERE id = $1", [ingestId, JSON.stringify(report), error]);
        await audit(q, { ...actor, action: "ingest.reject", target: ing.model_id ?? ingestId, detail: { ingest: ingestId, reason: error } });
      });
      await cleanup();
    };

    try {
      await setState("checking");
      await ctx.progress({ step: "unpack" });
      // Rebuild the work folder from the uploaded parts each attempt, so a retry starts clean.
      await rm(work, { recursive: true, force: true });
      const src = path.join(work, "src");
      await mkdir(src, { recursive: true });
      const budget = { files: MAX_FILES, bytes: LIMITS.tileset };
      for (const u of ups) {
        const part = storage.uploadPart(u.id);
        if (/\.zip$/i.test(u.path)) await unzipGuarded(part, src, budget, u.path);
        else {
          const dest = Storage.inside(src, u.path);
          if (!dest) throw new PermanentError(`This file name is not allowed: ${u.path}`);
          await place(part, dest);
        }
      }

      await ctx.progress({ step: "check" });
      let { report, files } = await checkFiles(await listTree(src));
      if (!report.ok) return reject(report, report.items.find((i) => i.severity === "error")?.title ?? "The model did not pass the check.");

      await ctx.progress({ step: "scan" });
      const scanned = await scan(opts.clamdscan, src);
      report.items.push(scanned);
      if (scanned.severity === "error") return reject({ ...report, ok: false }, scanned.title);

      let publish = files as DiskFile[];
      if (report.format === "fbx") {
        await setState("converting");
        await ctx.progress({ step: "convert" });
        const fbx = (files as DiskFile[]).find((f) => f.path === report.mainFile)!;
        const glb = await convertFbx(opts.fbx2gltf, fbx.src, path.join(work, "out"));
        const converted = await checkFiles([diskFile(path.basename(glb), glb, await fileSize(glb))]);
        if (!converted.report.ok) return reject(converted.report, "The converted model did not pass the check.");
        const keep = report.items.filter((i) => i.id === "format" || i.id === "scan");
        report = {
          ...converted.report,
          format: "fbx",
          items: [...keep, checkItem("conversion", "ok", "converted"), ...converted.report.items.filter((i) => i.id !== "format")],
        };
        // The original FBX is kept beside the GLB (FMT-08), under its own folder so names cannot clash.
        publish = [...(converted.files as DiskFile[]), { ...fbx, path: `original/${path.basename(fbx.path)}` }];
      }

      // The official validator, on what will be published (the GLB for an FBX).
      await ctx.progress({ step: "validate" });
      const main = report.format === "fbx" ? publish[0] : publish.find((f) => f.path === report.mainFile);
      if (main) {
        const official = await validateOfficial(report.format === "3dtiles" ? "3dtiles" : "gltf", main.src, { strict: opts.strictValidation, timeoutMs: opts.validatorTimeoutMs });
        report.items.push(official);
        if (official.severity === "error") return reject({ ...report, ok: false }, official.title);
      }

      // Large models stream as 3D Tiles (AD-04); the uploaded file is kept for download.
      const req = ing.request;
      // The Place step's position wins; else one from a file beside the model (metadata.xml).
      const fromSide = !report.georef && !req.placement && report.filePosition ? placementFromGrid(report.filePosition) : undefined;
      const limit = opts.tileIf ?? TILE_IF;
      const meshBytes = publish.reduce((t, f) => t + (f.path.startsWith("original/") ? 0 : f.size), 0);
      let tiled = false;
      const big = (report.stats.triangles ?? 0) > limit.triangles || meshBytes > limit.bytes;
      // The tiler works in a local frame; a GLB in Earth-centred coordinates would lose its precision there.
      if (big && report.georef && report.format !== "3dtiles")
        report.items.push(checkItem("tiling", "warning", "notTiledGeo"));
      if (main && report.format !== "3dtiles" && big && !report.georef) {
        await setState("converting");
        await ctx.progress({ step: "tile" });
        const dir = path.join(work, "tiled");
        try {
          const t = await tileModelInWorker(main.src, dir, { upAxis: (req.placement ?? fromSide)?.upAxis, scale: (req.placement ?? fromSide)?.scale, leafTriangles: opts.leafTriangles }, (done, total) => void ctx.progress({ step: "tile", done, total }));
          const kept = publish.map((f) => (f.path.startsWith("original/") ? f : { ...f, path: `original/${f.path}` }));
          publish = [...(await Promise.all(t.files.map(async (f) => diskFile(f, path.join(dir, f), await fileSize(path.join(dir, f)))))), ...kept];
          tiled = true;
          report.items.push({
            id: "tiling",
            severity: t.skipped ? "warning" : "ok",
            title: `Tiled for streaming: ${t.tiles} tiles in ${t.levels} levels`,
            detail: `${t.triangles.toLocaleString("en")} triangles. Far views draw simplified tiles, close views the full detail.${t.skipped ? ` ${t.skipped} parts that are lines or points were left out of the tiles; the original file keeps them.` : ""}`,
          });
        } catch (e) {
          report.items.push(checkItem("tiling", "warning", "tilingFailed", {}, e instanceof Error ? e.message : String(e)));
        }
      }

      // A single GLB (uploaded, or made from an FBX) is sent smaller: the same positions, compressed.
      const glbIndex = main && !tiled && (report.format === "glb" || report.format === "fbx") ? publish.indexOf(main) : -1;
      if (opts.optimise !== false && glbIndex >= 0 && main!.path.toLowerCase().endsWith(".glb")) {
        await ctx.progress({ step: "optimise" });
        const dest = path.join(work, "optimised.glb");
        try {
          const o = await optimiseGlbInWorker(main!.src, dest);
          if (o.written) {
            publish = publish.map((f, i) => (i === glbIndex ? diskFile(f.path, dest, o.after) : f));
            // The file as uploaded stays downloadable; a GLB made from an FBX has the FBX for that.
            if (report.format === "glb") publish.push({ ...main!, path: `original/${main!.path}` });
            report.items.push(checkItem("optimise", "ok", "compressed", { before: mb(o.before), after: mb(o.after) }));
          }
        } catch (e) {
          report.items.push(checkItem("optimise", "warning", "compressFailed", {}, e instanceof Error ? e.message : String(e)));
        }
      }

      // Where it goes and where it stands.
      const georef = report.georef;
      let placement = georef ? undefined : (req.placement ?? fromSide);
      const centre = georef ? { lat: georef.lat, lon: georef.lon } : placement ? { lat: placement.lat, lon: placement.lon } : req.centre;
      if (!centre) return reject({ ...report, ok: false, items: [...report.items, checkItem("georef", "error", "noPositionSet")] }, "No position");
      // The tiler baked the up axis and scale into the tiles.
      if (tiled) placement = { ...(placement ?? { ...centre, height: 0 }), upAxis: undefined, scale: undefined };

      await ctx.progress({ step: "publish" });
      const modelId = ing.model_id ?? `m-${crypto.randomUUID()}`;
      // The ingest id keeps the folder unique and never reused, so the files can be cached forever.
      const rel = `${modelId}/${ingestId}`;
      const out = path.join(storage.files, modelId, ingestId);
      await rm(out, { recursive: true, force: true });
      let bytes = 0;
      for (const f of publish) {
        const dest = Storage.inside(out, f.path);
        if (!dest) throw new PermanentError(`This file name is not allowed: ${f.path}`);
        if (f.src) await place(f.src, dest);
        else (await mkdir(path.dirname(dest), { recursive: true }), await writeFile(dest, await f.bytes()));
        bytes += f.size;
      }
      const mainPath = tiled ? "tileset.json" : report.format === "fbx" ? publish[0]!.path : report.mainFile!;
      const isTiles = tiled || report.format === "3dtiles";
      const source: ModelSummary["source"] = {
        kind: isTiles ? "3dtiles" : "glb",
        url: `files/${rel}/${mainPath.split("/").map(encodeURIComponent).join("/")}`,
        ...(report.format === "3dtiles" && req.groundFit ? { groundFit: req.groundFit } : {}),
        ...(isTiles && !georef && placement ? { localFrame: true } : {}),
        ...(!isTiles && georef ? { georeferenced: true } : {}),
      };

      await db.tx(async (q) => {
        let version: number;
        if (ing.model_id) {
          const v = await addVersion(q, ing.model_id, { source, placement, sizeBytes: bytes, note: req.note });
          if (!v) throw new PermanentError("The model was deleted while the upload was processed.");
          version = v;
          await audit(q, { ...actor, action: "version.create", target: modelId, detail: { version, ingest: ingestId, note: req.note ?? "" } });
        } else {
          await createModel(q, { ...req.model!, id: modelId, sourceFormat: report.format!, source, centre, placement, sizeBytes: bytes });
          version = 1;
          await audit(q, { ...actor, action: "model.create", target: modelId, detail: { name: req.model!.name, classificationId: req.model!.classificationId, status: req.model!.status, ingest: ingestId } });
        }
        await q.query("UPDATE versions SET report = $3 WHERE model_id = $1 AND version = $2", [modelId, version, JSON.stringify(report)]);
        if (opts.thumbnails) await enqueue(q, "thumbnail", { modelId, version });
        await q.query("UPDATE ingests SET state = 'ready', model_id = $2, version = $3, report = $4, error = NULL, updated_at = now() WHERE id = $1", [ingestId, modelId, version, JSON.stringify(report)]);
      });
      await cleanup();
    } catch (e) {
      // A permanent failure ends the ingest now; anything else goes back to the queue state the job retries from.
      if (e instanceof PermanentError || job.attempts >= job.max_attempts) {
        await db.tx(async (q) => {
          await q.query("UPDATE ingests SET state = 'failed', error = $2, updated_at = now() WHERE id = $1", [ingestId, e instanceof Error ? e.message : String(e)]);
          await audit(q, { ...actor, action: "ingest.reject", target: ing.model_id ?? ingestId, detail: { ingest: ingestId, reason: e instanceof Error ? e.message : String(e) } });
        });
        await cleanup();
      } else await setState("queued");
      throw e;
    }
  };
}
