import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { cannotRun, goalsFor, methodById, presetSettings, SPLAT_METHODS, type CaptureInput, type ServerHardware, type SplatGoal, type SplatPreset } from "@viewer/shared";
import { audit } from "./audit.ts";
import type { Db, Queryable } from "./db.ts";
import { enqueue, PermanentError, type Handler } from "./jobs.ts";
import { closed, text } from "./schemas.ts";
import { Storage } from "./storage.ts";
import { problem } from "./errors.ts";
import { writeTrainingLog } from "./training-log.ts";
import { componentChecker, componentStates } from "./splat-components.ts";
import { satellitePreflight } from "./satellite.ts";

/**
 * Making Gaussian splats from a capture (docs/GAUSSIAN_SPLATS.md, "Making a splat").
 *
 * The operator uploads a video, photos or satellite images through the usual upload (tus) with a
 * `reconstruct` request. Submitting it queues one "reconstruct" job per chosen method in the same
 * transaction, so a comparison is queued whole or not at all. Each job runs that method's worker
 * (an installed program, see the worker contract below) and hands the splats it made to a normal
 * ingest, which checks, scans, tiles and publishes them like any uploaded splat file. The first
 * method to finish creates the model; the others add versions to it, so they can be compared.
 *
 * Worker contract: the worker is started without a shell, with discrete arguments
 *   --method <id> --input <dir> --input-kind video|photos|satellite --goal <goal> --output <dir>
 *   --preset fast|balanced|high --iterations N --max-splats N --resolution N --sh-degree N
 *   --video-fps N --threads N
 * and a minimal environment (PATH, HOME, LANG, CUDA_VISIBLE_DEVICES). It prints lines
 * "progress <0..1> <stage>" on stdout, writes exactly one of output/splats.ply or
 * output/splats.spz, and may write output/provenance.json ({ tool, version, poses, frames,
 * registeredViews, fixture }); what it leaves out is recorded as unknown, never guessed.
 * Exit 0 is success; exit 2 means the input cannot be reconstructed (not retried); anything else
 * is retried once. One job runs at a time per server, so jobs never compete for the GPU.
 *
 * Cancelling (POST /api/captures/:id/cancel) ends the methods still queued at once and asks a
 * running one to stop: the job sees the request within two seconds, stops its worker (SIGTERM, then
 * SIGKILL after ten seconds) and removes its work folder. Nothing already published is touched.
 */

export interface ReconstructRequest {
  input: CaptureInput;
  goal: SplatGoal;
  methods: string[];
  preset: SplatPreset;
}

export interface SplatProvenance {
  method: string;
  methodName: string;
  licence: string;
  generative: boolean;
  /** Made by a test fixture worker, not a real reconstruction. */
  fixture: boolean;
  input: CaptureInput;
  goal: SplatGoal;
  settings: ReturnType<typeof presetSettings>;
  hardware: string;
  tool?: string;
  toolVersion?: string;
  poses?: string;
  /** Frames or images the worker used, and how many got a camera pose, when it says so. */
  frames?: number;
  registeredViews?: number;
  /** Placed from camera positions by the worker (georef.json), with its fit residuals. */
  georef?: SplatGeoref;
  /** Why the worker could not place it although the capture had camera positions. */
  georefNote?: string;
  /** What the satellite check found: calibrated views and the widest angle between them. */
  satellite?: { views: number; convergenceDeg: number | null; warnings: ("satVideoIgnored" | "satNoAngles")[] };
  startedAt: string;
  finishedAt: string;
}

export interface Residuals {
  count: number;
  horizontalRms: number;
  verticalRms: number;
  max: number;
}
export interface SplatGeoref {
  source: string;
  origin: { lat: number; lon: number; height: number };
  horizontalCrs: string;
  verticalDatum: string;
  metresPerModelUnit: number;
  controls: Residuals;
  checks: Residuals | null;
}

/**
 * The worker's georef.json, checked: the splats are in metres east, north and up of `origin`
 * (worker contract). Anything out of range or missing means the model is not placed.
 */
export async function readGeoref(file: string): Promise<SplatGeoref | null> {
  const s = await stat(file).catch(() => null);
  if (!s || s.size > 64 * 1024) return null;
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
    const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
    const res = (r: any): Residuals | null =>
      r && Number.isInteger(r.count) && r.count > 0 && num(r.horizontalRms, 0, 1e5) && num(r.verticalRms, 0, 1e5) && num(r.max, 0, 1e5) ? { count: r.count, horizontalRms: r.horizontalRms, verticalRms: r.verticalRms, max: r.max } : null;
    const o = j.origin;
    if (j.frame !== "enu" || !o || !num(o.lat, -90, 90) || !num(o.lon, -180, 180) || !num(o.height, -1000, 10000) || !num(j.metresPerModelUnit, 1e-9, 1e9)) return null;
    const controls = res(j.controls);
    if (!controls) return null;
    const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : d);
    return { source: str(j.source, "camera positions"), origin: { lat: o.lat, lon: o.lon, height: o.height }, horizontalCrs: str(j.horizontalCrs, "EPSG:4326"), verticalDatum: str(j.verticalDatum, "not stated"), metresPerModelUnit: j.metresPerModelUnit, controls, checks: res(j.checks) };
  } catch {
    return null;
  }
}

const VIDEO = /\.(mp4|mov|m4v|lrv|ts|mts|avi|mkv|webm)$/i;
const PHOTO = /\.(jpe?g|png|tiff?|heic|webp|dng)$/i;
// Satellite video is accepted so that the check can say what it needs (frames with RPC files).
const SATELLITE = /\.(tiff?|ntf|nitf|jp2|rpb|rpc|imd|xml|txt|json|geojson|mp4|mov|m4v|ts|mts|avi|mkv|webm)$/i;
const ACCEPT: Record<CaptureInput, RegExp> = { video: VIDEO, photos: PHOTO, satellite: SATELLITE };
/** Files in a capture that are not the pictures themselves but may come with them (camera data, notes). */
const SIDECAR = /\.(txt|json|csv|xml|srt|gpx|kml)$/i;
export const MAX_METHODS = 3;

/** Whether this file can be part of a capture of this kind. A zip is unpacked and its files checked again. */
export const captureFileOk = (input: CaptureInput, name: string): boolean => /\.zip$/i.test(name) || ACCEPT[input].test(name) || SIDECAR.test(name);

export const reconstructSchema = {
  type: "object",
  required: ["input", "goal", "methods", "preset"],
  properties: {
    input: { enum: ["video", "photos", "satellite"] },
    goal: { enum: ["scene", "surface", "area", "satellite"] },
    methods: { type: "array", minItems: 1, maxItems: MAX_METHODS, uniqueItems: true, items: { enum: SPLAT_METHODS.map((m) => m.id) } },
    preset: { enum: ["fast", "balanced", "high"] },
  },
  additionalProperties: false,
} as const;

export interface ReconstructOptions {
  workers: Record<string, string>;
  hardware: () => Promise<ServerHardware>;
  timeoutHours?: number;
  /** Scans the capture for viruses before a worker reads it (CLAMDSCAN); unset: not scanned. */
  scan?: (dir: string) => Promise<{ severity: string; title: string }>;
  /** Runs a worker's `--check` (splat-components.ts); by default each worker is checked at most every ten minutes. */
  check?: ReturnType<typeof componentChecker>;
  /** Where each training's redacted log is kept (training-log.ts); unset: no logs. */
  logDir?: string;
}

const checkers = new WeakMap<ReconstructOptions, ReturnType<typeof componentChecker>>();
/** One checker (and so one cache of answers) per set of options. */
export function checkerFor(opts: ReconstructOptions): ReturnType<typeof componentChecker> {
  if (opts.check) return opts.check;
  let c = checkers.get(opts);
  if (!c) checkers.set(opts, (c = componentChecker(opts.workers)));
  return c;
}

/** Why a reconstruct request cannot run here, or null. Checked when the upload is created, before any byte is sent. */
export async function reconstructProblem(r: ReconstructRequest, files: { path: string }[], opts: ReconstructOptions) {
  if (!goalsFor(r.input).includes(r.goal)) return problem("captureGoalMismatch", { input: r.input, goal: r.goal });
  const hw = await opts.hardware();
  for (const id of r.methods) {
    const m = methodById(id)!;
    if (!m.inputs.includes(r.input) || !m.goals.includes(r.goal)) return problem("captureMethodMismatch", { method: m.name });
    if (!opts.workers[id]) return problem("captureMethodNotInstalled", { method: m.name });
    if (cannotRun(m, hw)) return problem("captureMethodCannotRun", { method: m.name });
    const checked = await checkerFor(opts)(id);
    if (checked && (checked.environment === "broken" || checked.environment === "failed")) return problem("captureMethodBroken", { method: m.name, problem: checked.problems[0] ?? "" });
  }
  const bad = files.find((f) => !captureFileOk(r.input, f.path));
  if (bad) return problem("captureFileType", { file: bad.path });
  return null;
}

/** Queues the jobs for a submitted capture, one per method, in the caller's transaction. */
export async function queueReconstruct(q: Queryable, ingestId: string, r: ReconstructRequest): Promise<void> {
  await q.query("UPDATE ingests SET state = 'converting', updated_at = now() WHERE id = $1", [ingestId]);
  for (const method of r.methods) await enqueue(q, "reconstruct", { ingestId, method }, 2);
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

interface WorkerRun {
  code: number | null;
  stderr: string;
  /** Everything the worker said apart from progress lines, newest 2 MB. */
  log: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** Runs a worker: no shell, discrete arguments, a minimal environment, a time limit, and stderr kept short. */
export function runWorker(bin: string, args: string[], cwd: string, timeoutMs: number, onProgress: (fraction: number, stage: string) => void, signal?: AbortSignal): Promise<WorkerRun> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" };
    if (process.env.CUDA_VISIBLE_DEVICES) env.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let log = "";
    const keep = (t: string) => void (log = (log + t).slice(-2_000_000));
    let line = "";
    let timedOut = false;
    let cancelled = false;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      line += chunk;
      if (line.length > 65536) line = line.slice(-4096);
      let i: number;
      while ((i = line.indexOf("\n")) >= 0) {
        const text = line.slice(0, i).trim();
        const m = /^progress\s+([0-9.]+)\s*(\S*)/.exec(text);
        if (!m && text) keep(`${text}\n`);
        line = line.slice(i + 1);
        if (m) onProgress(Math.min(1, Math.max(0, Number(m[1]) || 0)), m[2]!.slice(0, 40));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
      keep(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      done();
      resolve({ code: -1, stderr: e.message, log: log + e.message, timedOut, cancelled });
    });
    child.on("close", (code) => {
      done();
      resolve({ code, stderr, log, timedOut, cancelled });
    });
  });
}

/** The worker's provenance.json, reduced to the fields HOLO records; anything else is ignored. */
async function readProvenance(file: string): Promise<{ tool?: string; toolVersion?: string; poses?: string; frames?: number; registeredViews?: number; georefNote?: string; fixture: boolean }> {
  const s = await stat(file).catch(() => null);
  if (!s || s.size > 64 * 1024) return { fixture: false };
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
    const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
    return { tool: str(j.tool), toolVersion: str(j.version), poses: str(j.poses), frames: count(j.frames), registeredViews: count(j.registeredViews), georefNote: str(j.georefNote), fixture: j.fixture === true };
  } catch {
    return { fixture: false };
  }
}

interface IngestRow {
  id: string;
  state: string;
  request: { files: { path: string; size: number }[]; reconstruct?: ReconstructRequest; model?: { name: string }; placement?: unknown; centre?: unknown; note?: string };
  ip: string;
  host: string;
}

/** The error a cancelled method's job ends with. */
export const CANCELLED = "Cancelled.";

/**
 * The last job of a capture tidies up: the capture's uploaded parts go, and the capture says how it
 * ended. `exceptJob` is the job that is finishing now and still counts as running.
 */
export async function finishCapture(db: Queryable, storage: Storage, ingestId: string, exceptJob = ""): Promise<void> {
  const [left] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1 AND state IN ('queued', 'running') AND id::text <> $2", [ingestId, exceptJob]);
  if (Number(left?.n ?? 0) > 0) return;
  const [made] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ingests WHERE request->>'parentIngest' = $1", [ingestId]);
  await db.query("UPDATE ingests SET state = $2, updated_at = now() WHERE id = $1", [ingestId, Number(made?.n ?? 0) > 0 ? "ready" : "failed"]);
  const ups = await db.query<{ id: string }>("SELECT id FROM uploads WHERE ingest_id = $1", [ingestId]);
  await Promise.all(ups.map((u) => rm(storage.uploadPart(u.id), { force: true })));
  await rm(path.join(storage.ingests, ingestId), { recursive: true, force: true });
}

/**
 * Cancels what is left of a capture: queued methods end now, a running one is asked to stop.
 * Returns false when there is no such capture. Methods already published stay as they are.
 */
export async function cancelCapture(db: Db, storage: Storage, ingestId: string, actor: { ip: string; host: string }): Promise<boolean> {
  const [ing] = await db.query<{ request: IngestRow["request"] }>("SELECT request FROM ingests WHERE id = $1", [ingestId]);
  if (!ing?.request.reconstruct) return false;
  const { stopped, running } = await db.tx(async (q) => {
    const stopped = await q.query<{ id: string }>(
      `UPDATE jobs SET state = 'failed', error = $2, payload = payload || '{"cancel":true}'::jsonb, lease_until = NULL, updated_at = now()
       WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1 AND state = 'queued' RETURNING id`,
      [ingestId, CANCELLED],
    );
    const running = await q.query<{ id: string }>(
      `UPDATE jobs SET payload = payload || '{"cancel":true}'::jsonb, updated_at = now()
       WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1 AND state = 'running' RETURNING id`,
      [ingestId],
    );
    if (stopped.length || running.length) await audit(q, { ...actor, action: "reconstruct.cancel", target: ingestId, detail: { queued: stopped.length, running: running.length } });
    return { stopped, running };
  });
  if (stopped.length && !running.length) await finishCapture(db, storage, ingestId);
  return true;
}

export function reconstructHandler(
  db: Db,
  storage: Storage,
  opts: ReconstructOptions,
  unpack: (part: string, uploadPath: string, dest: string) => Promise<void>,
): Handler {
  return async (job, ctx) => {
    const ingestId = String(job.payload.ingestId);
    const method = methodById(String(job.payload.method));
    if (!method) throw new PermanentError(`Unknown method ${String(job.payload.method)}.`);
    const [ing] = await db.query<IngestRow>("SELECT id, state, request, ip, host FROM ingests WHERE id = $1", [ingestId]);
    if (!ing?.request.reconstruct) throw new PermanentError(`Capture ${ingestId} does not exist.`);
    const r = ing.request.reconstruct;
    const actor = { ip: ing.ip, host: ing.host };
    const work = path.join(storage.ingests, ingestId, `make-${method.id}`);

    const finishIfLast = () => finishCapture(db, storage, ingestId, job.id);
    const cancelled = async () => {
      const [row] = await db.query<{ cancel: boolean }>("SELECT (payload->>'cancel') = 'true' AS cancel FROM jobs WHERE id = $1", [job.id]);
      return !!row?.cancel;
    };

    // A rerun after this method's splats were handed over only has to tidy up.
    const [done] = await db.query("SELECT 1 FROM ingests WHERE request->>'parentIngest' = $1 AND request->>'method' = $2", [ingestId, method.id]);
    if (done) return finishIfLast();

    // The run's log (training-log.ts): written redacted when the run ends, however it ends.
    const started = Date.now();
    const trace: string[] = [`HOLO training log`, `capture ${ingestId}, method ${method.id}, attempt ${job.attempts} of ${job.max_attempts}`, `input ${r.input}, goal ${r.goal}, preset ${r.preset}`, `started ${new Date(started).toISOString()}`];
    const note = (t: string) => trace.push(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${t}`);
    const abort = new AbortController();
    const watch = setInterval(() => void cancelled().then((c) => c && abort.abort(), () => undefined), 2000);
    try {
      if (await cancelled()) throw new PermanentError(CANCELLED);
      const bin = opts.workers[method.id];
      if (!bin) throw new PermanentError(`No worker is installed for ${method.name}.`);
      await ctx.progress({ step: "prepare", method: method.id });
      await rm(work, { recursive: true, force: true });
      const input = path.join(work, "in");
      const output = path.join(work, "out");
      await mkdir(input, { recursive: true });
      await mkdir(output, { recursive: true });
      const ups = await db.query<{ id: string; path: string }>("SELECT id, path FROM uploads WHERE ingest_id = $1", [ingestId]);
      for (const u of ups) await unpack(storage.uploadPart(u.id), u.path, input);
      const pictures = (await listFiles(input)).filter((f) => ACCEPT[r.input].test(f) && !SIDECAR.test(f));
      const kinds = new Map<string, number>();
      for (const f of await listFiles(input)) kinds.set(path.extname(f).toLowerCase() || "(none)", (kinds.get(path.extname(f).toLowerCase() || "(none)") ?? 0) + 1);
      note(`capture files: ${[...kinds].map(([k, n]) => `${n} × ${k}`).join(", ") || "none"}`);
      if (!pictures.length) throw new PermanentError(`The upload has no ${r.input === "video" ? "video" : "images"} to make splats from.`);
      // Satellite views need camera models and different directions: checked before any training.
      let satellite: SplatProvenance["satellite"];
      if (r.input === "satellite") {
        const pf = await satellitePreflight(input, await listFiles(input));
        if (pf.problem) throw new PermanentError(pf.problem);
        satellite = { views: pf.views.length, convergenceDeg: pf.convergenceDeg === null ? null : Math.round(pf.convergenceDeg * 10) / 10, warnings: pf.warnings };
        note(`satellite check: ${pf.views.length} views, RPC ${pf.views.map((v) => v.rpc ?? "missing").join("/")}, angles known for ${pf.views.filter((v) => v.azimuth !== undefined).length}, widest ${satellite.convergenceDeg ?? "unknown"}°, warnings ${pf.warnings.join(" ") || "none"}`);
      }
      // The capture is scanned before a worker opens it; the splats it makes are scanned again when published.
      if (opts.scan) {
        const scanned = await opts.scan(input);
        if (scanned.severity === "error") throw new PermanentError(scanned.title);
      }

      const hw = await opts.hardware();
      const settings = presetSettings(method, r.preset, hw);
      const args = [
        "--method", method.id,
        "--input", input,
        "--input-kind", r.input,
        "--goal", r.goal,
        "--output", output,
        "--preset", r.preset,
        "--iterations", String(settings.iterations),
        "--max-splats", String(settings.maxSplats),
        "--resolution", String(settings.resolution),
        "--sh-degree", String(settings.shDegree),
        "--video-fps", String(settings.videoFps),
        "--threads", String(settings.threads),
      ];
      const startedAt = new Date().toISOString();
      const g = [...hw.gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0];
      note(`hardware: ${hw.platform} ${hw.arch}, ${hw.cpuModel}, ${hw.cpus} threads, ${hw.ramGb} GB; GPU ${g ? `${g.name}, ${g.memoryGb} GB${g.freeGb !== undefined ? ` (${g.freeGb} GB free)` : ""}${g.driver ? `, driver ${g.driver}` : ""}` : "none"}`);
      note(`settings: ${JSON.stringify(settings)}`);
      note("worker started");
      let last = 0;
      const run = await runWorker(
        bin,
        args,
        work,
        (opts.timeoutHours ?? 12) * 3600_000,
        (fraction, stage) => {
          // At most one progress write a second.
          if (Date.now() - last < 1000 && fraction < 1) return;
          last = Date.now();
          void ctx.progress({ step: "train", method: method.id, fraction, stage });
        },
        abort.signal,
      );
      note(`worker ended: exit ${run.code}${run.timedOut ? ", timed out" : ""}${run.cancelled ? ", cancelled" : ""}`);
      trace.push("----- worker output -----", run.log.trimEnd(), "----- end of worker output -----");
      if (run.cancelled || (await cancelled())) throw new PermanentError(CANCELLED);
      if (run.timedOut) throw new PermanentError(`${method.name} did not finish in ${opts.timeoutHours ?? 12} hours.`);
      const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      if (run.code === 2) throw new PermanentError(`${method.name} could not use this capture${tail ? `: ${tail}` : "."}`);
      if (run.code !== 0) throw new Error(`${method.name} stopped (exit ${run.code})${tail ? `: ${tail}` : "."}`);

      const made = (await readdir(output)).filter((f) => /^splats\.(ply|spz)$/.test(f));
      if (made.length !== 1) throw new PermanentError(`${method.name} finished without writing splats.ply or splats.spz.`);
      const outFile = path.join(output, made[0]!);
      const size = (await stat(outFile)).size;
      const prov = await readProvenance(path.join(output, "provenance.json"));
      const georef = await readGeoref(path.join(output, "georef.json"));
      const gpu = [...hw.gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0];
      const provenance: SplatProvenance = {
        method: method.id,
        methodName: method.name,
        licence: method.licence,
        generative: !!method.generative,
        fixture: prov.fixture,
        input: r.input,
        goal: r.goal,
        settings,
        hardware: gpu ? `${gpu.name}, ${gpu.memoryGb} GB` : `${hw.cpuModel} (CPU), ${hw.ramGb} GB`,
        ...(prov.tool ? { tool: prov.tool } : {}),
        ...(prov.toolVersion ? { toolVersion: prov.toolVersion } : {}),
        ...(prov.poses ? { poses: prov.poses } : {}),
        ...(prov.frames !== undefined ? { frames: prov.frames } : {}),
        ...(prov.registeredViews !== undefined ? { registeredViews: prov.registeredViews } : {}),
        ...(georef ? { georef } : {}),
        ...(satellite ? { satellite } : {}),
        ...(prov.georefNote ? { georefNote: prov.georefNote } : {}),
        startedAt,
        finishedAt: new Date().toISOString(),
      };

      // Hand the splats to a normal ingest: checked, scanned, tiled and published like an upload.
      await ctx.progress({ step: "publish", method: method.id });
      const req = ing.request;
      const many = r.methods.length > 1;
      const childId = `i-${crypto.randomUUID()}`;
      const uploadId = crypto.randomUUID();
      const fileName = `${method.id}${path.extname(outFile)}`;
      await rename(outFile, storage.uploadPart(uploadId));
      const childReq = {
        files: [{ path: fileName, size }],
        ...(req.model ? { model: { ...req.model, name: many ? `${req.model.name} (${method.name})` : req.model.name } } : {}),
        // Placed by the worker from camera positions: metres east, north and up of its origin, a real size.
        ...(georef
          ? { placement: { lat: georef.origin.lat, lon: georef.origin.lon, height: georef.origin.height, scale: 1, upAxis: "z" as const, headingDeg: 0 }, centre: { lat: georef.origin.lat, lon: georef.origin.lon } }
          : { ...(req.placement ? { placement: req.placement } : {}), ...(req.centre ? { centre: req.centre } : {}) }),
        note: `${prov.fixture ? "TEST FIXTURE, not a real reconstruction. " : ""}Made with ${method.name} (${r.preset})${method.generative ? ", partly generated" : ""}${georef ? `, placed from ${georef.source}` : ""}.`,
        parentIngest: ingestId,
        method: method.id,
        provenance,
      };
      await db.tx(async (q) => {
        await q.query("INSERT INTO ingests (id, model_id, state, request, ip, host) VALUES ($1, NULL, 'queued', $2, $3, $4)", [childId, JSON.stringify(childReq), ing.ip, ing.host]);
        await q.query('INSERT INTO uploads (id, ingest_id, path, length, "offset") VALUES ($1, $2, $3, $4, $4)', [uploadId, childId, fileName, size]);
        await enqueue(q, "ingest", { ingestId: childId });
        await audit(q, { ...actor, action: "reconstruct.done", target: ingestId, detail: { ingest: childId, method: method.id, preset: r.preset, fixture: prov.fixture, splatsBytes: size } });
      });
      note(`handed over: ${made[0]}, ${size} bytes`);
      await rm(work, { recursive: true, force: true });
      await finishIfLast();
    } catch (e) {
      note(`failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      await rm(work, { recursive: true, force: true });
      const stopped = e instanceof PermanentError && e.message === CANCELLED;
      if (e instanceof PermanentError || job.attempts >= job.max_attempts) {
        // A cancel is audited when it is asked for; it is not a failure of the method.
        if (!stopped) await audit(db, { ...actor, action: "reconstruct.fail", target: ingestId, detail: { method: method.id, reason: e instanceof Error ? e.message : String(e) } });
        await finishIfLast();
      }
      throw e;
    } finally {
      clearInterval(watch);
      // Configured paths are named so they are removed even where they do not look like paths.
      if (opts.logDir) await writeTrainingLog(opts.logDir, `${method.id}-${ingestId.slice(0, 8)}`, trace, [storage.ingests, ...Object.values(opts.workers)]).catch(() => undefined);
    }
  };
}

export type MethodRun = {
  method: string;
  state: "queued" | "training" | "publishing" | "ready" | "failed" | "cancelled";
  fraction: number | null;
  stage: string | null;
  error: string | null;
  modelId: string | null;
  version: number | null;
};

/** Each method's state for one capture: its job while it trains, then the ingest that publishes its splats. */
export async function reconstructStatus(db: Queryable, ingestId: string): Promise<{ state: "working" | "ready" | "failed" | "cancelled"; methods: MethodRun[] } | null> {
  const [ing] = await db.query<{ state: string; request: IngestRow["request"] }>("SELECT state, request FROM ingests WHERE id = $1", [ingestId]);
  if (!ing?.request.reconstruct) return null;
  const jobs = await db.query<{ payload: { method: string; cancel?: boolean }; state: string; progress: { step?: string; fraction?: number; stage?: string }; error: string | null }>(
    "SELECT payload, state, progress, error FROM jobs WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1 ORDER BY id",
    [ingestId],
  );
  const kids = await db.query<{ request: { method: string }; state: string; error: string | null; model_id: string | null; version: number | null }>(
    "SELECT request, state, error, model_id, version FROM ingests WHERE request->>'parentIngest' = $1",
    [ingestId],
  );
  const methods = ing.request.reconstruct.methods.map((m): MethodRun => {
    const kid = kids.find((k) => k.request.method === m);
    const j = jobs.find((x) => x.payload.method === m);
    if (kid) {
      const state = kid.state === "ready" ? "ready" : kid.state === "failed" ? "failed" : "publishing";
      return { method: m, state, fraction: 1, stage: null, error: kid.error, modelId: kid.model_id, version: kid.version };
    }
    if (j?.state === "failed") return { method: m, state: j.payload.cancel && j.error === CANCELLED ? "cancelled" : "failed", fraction: null, stage: null, error: j.error, modelId: null, version: null };
    const p = j?.progress ?? {};
    const running = j?.state === "running" || (j?.state === "queued" && !!j.error);
    return { method: m, state: running ? "training" : "queued", fraction: typeof p.fraction === "number" ? p.fraction : null, stage: p.stage ?? p.step ?? null, error: null, modelId: null, version: null };
  });
  const ended = methods.every((m) => m.state === "ready" || m.state === "failed" || m.state === "cancelled");
  const state = !ended ? "working" : methods.some((m) => m.state === "ready") ? "ready" : methods.every((m) => m.state === "cancelled") ? "cancelled" : "failed";
  return { state, methods };
}

/** GET /api/splat-methods (the registry, what is installed, the hardware) and GET /api/captures/:id (progress). */
export function registerReconstruct(app: FastifyInstance, db: Db, opts: ReconstructOptions, files?: { storage: Storage; who: (req: FastifyRequest) => Promise<{ ip: string; host: string }> }): void {
  const gpu = closed({ vendor: text, name: text, memoryGb: { type: "number" }, freeGb: { type: "number" }, driver: text }, ["vendor", "name", "memoryGb"]);
  app.get(
    "/api/splat-methods",
    {
      schema: {
        tags: ["capture"],
        response: {
          200: closed(
            {
              hardware: closed({ platform: text, arch: text, cpuModel: text, cpus: { type: "integer" }, ramGb: { type: "number" }, gpus: { type: "array", items: gpu } }, ["platform", "arch", "cpuModel", "cpus", "ramGb", "gpus"]),
              installed: { type: "array", items: text },
              components: {
                type: "array",
                items: closed(
                  {
                    method: text,
                    configured: { type: "boolean" },
                    environment: { enum: ["ok", "broken", "failed", "unchecked"] },
                    revision: { anyOf: [text, { type: "null" }] },
                    version: { anyOf: [text, { type: "null" }] },
                    problems: { type: "array", items: text },
                    trained: { anyOf: [closed({ at: text, fixture: { type: "boolean" } }, ["at", "fixture"]), { type: "null" }] },
                    fixture: { type: "boolean" },
                  },
                  ["method", "configured", "environment", "revision", "version", "problems", "trained", "fixture"],
                ),
              },
            },
            ["hardware", "installed", "components"],
          ),
        },
      },
    },
    async () => {
      const components = await componentStates(db, opts.workers, checkerFor(opts));
      // Installed: a worker is configured and its own check did not fail.
      const installed = components.filter((c) => c.configured && (c.environment === "ok" || c.environment === "unchecked")).map((c) => c.method);
      return { hardware: await opts.hardware(), installed, components };
    },
  );
  const run = closed(
    {
      method: text,
      state: { enum: ["queued", "training", "publishing", "ready", "failed", "cancelled"] },
      fraction: { anyOf: [{ type: "number" }, { type: "null" }] },
      stage: { anyOf: [text, { type: "null" }] },
      error: { anyOf: [text, { type: "null" }] },
      modelId: { anyOf: [text, { type: "null" }] },
      version: { anyOf: [{ type: "integer" }, { type: "null" }] },
    },
    ["method", "state", "fraction", "stage", "error", "modelId", "version"],
  );
  const status = closed({ state: { enum: ["working", "ready", "failed", "cancelled"] }, methods: { type: "array", items: run } }, ["state", "methods"]);
  app.get<{ Params: { id: string } }>(
    "/api/captures/:id",
    { schema: { tags: ["capture"], params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } }, response: { 200: status } } },
    async (req, reply) => (await reconstructStatus(db, req.params.id)) ?? reply.status(404).send(problem("noUpload")),
  );
  if (!files) return;
  app.post<{ Params: { id: string } }>(
    "/api/captures/:id/cancel",
    { schema: { tags: ["capture"], params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } }, response: { 200: status } } },
    async (req, reply) => {
      if (!(await cancelCapture(db, files.storage, req.params.id, await files.who(req)))) return reply.status(404).send(problem("noUpload"));
      return reconstructStatus(db, req.params.id);
    },
  );
}
