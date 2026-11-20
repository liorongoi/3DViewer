import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { cannotRun, goalsFor, methodById, presetSettings, SPLAT_METHODS, type CaptureInput, type ServerHardware, type SplatGoal, type SplatPreset } from "@viewer/shared";
import { audit } from "./audit.ts";
import type { Db, Queryable } from "./db.ts";
import { enqueue, PermanentError, type Handler } from "./jobs.ts";
import { closed, text } from "./schemas.ts";
import { Storage } from "./storage.ts";
import { problem } from "./errors.ts";

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
 * output/splats.spz, and may write output/provenance.json ({ tool, version, poses, fixture }).
 * Exit 0 is success; exit 2 means the input cannot be reconstructed (not retried); anything else
 * is retried once. One job runs at a time per server, so jobs never compete for the GPU.
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
  startedAt: string;
  finishedAt: string;
}

const VIDEO = /\.(mp4|mov|m4v|avi|mkv|webm|mts)$/i;
const PHOTO = /\.(jpe?g|png|tiff?|heic|webp|dng)$/i;
const SATELLITE = /\.(tiff?|ntf|nitf|jp2|rpb|rpc|xml|txt|json|geojson)$/i;
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
  timedOut: boolean;
}

/** Runs a worker: no shell, discrete arguments, a minimal environment, a time limit, and stderr kept short. */
export function runWorker(bin: string, args: string[], cwd: string, timeoutMs: number, onProgress: (fraction: number, stage: string) => void): Promise<WorkerRun> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" };
    if (process.env.CUDA_VISIBLE_DEVICES) env.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let line = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      line += chunk;
      if (line.length > 65536) line = line.slice(-4096);
      let i: number;
      while ((i = line.indexOf("\n")) >= 0) {
        const m = /^progress\s+([0-9.]+)\s*(\S*)/.exec(line.slice(0, i).trim());
        line = line.slice(i + 1);
        if (m) onProgress(Math.min(1, Math.max(0, Number(m[1]) || 0)), m[2]!.slice(0, 40));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr = (stderr + chunk).slice(-4000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

/** The worker's provenance.json, reduced to the fields HOLO records; anything else is ignored. */
async function readProvenance(file: string): Promise<{ tool?: string; toolVersion?: string; poses?: string; fixture: boolean }> {
  const s = await stat(file).catch(() => null);
  if (!s || s.size > 64 * 1024) return { fixture: false };
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
    return { tool: str(j.tool), toolVersion: str(j.version), poses: str(j.poses), fixture: j.fixture === true };
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

    /** The last job of a capture tidies up: the capture's uploaded parts go, and the capture says how it ended. */
    const finishIfLast = async () => {
      const [left] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1 AND state IN ('queued', 'running') AND id <> $2", [ingestId, job.id]);
      if (Number(left?.n ?? 0) > 0) return;
      const [made] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ingests WHERE request->>'parentIngest' = $1", [ingestId]);
      await db.query("UPDATE ingests SET state = $2, updated_at = now() WHERE id = $1", [ingestId, Number(made?.n ?? 0) > 0 ? "ready" : "failed"]);
      const ups = await db.query<{ id: string }>("SELECT id FROM uploads WHERE ingest_id = $1", [ingestId]);
      await Promise.all(ups.map((u) => rm(storage.uploadPart(u.id), { force: true })));
      await rm(path.join(storage.ingests, ingestId), { recursive: true, force: true });
    };

    // A rerun after this method's splats were handed over only has to tidy up.
    const [done] = await db.query("SELECT 1 FROM ingests WHERE request->>'parentIngest' = $1 AND request->>'method' = $2", [ingestId, method.id]);
    if (done) return finishIfLast();

    try {
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
      if (!pictures.length) throw new PermanentError(`The upload has no ${r.input === "video" ? "video" : "images"} to make splats from.`);

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
      let last = 0;
      const run = await runWorker(bin, args, work, (opts.timeoutHours ?? 12) * 3600_000, (fraction, stage) => {
        // At most one progress write a second.
        if (Date.now() - last < 1000 && fraction < 1) return;
        last = Date.now();
        void ctx.progress({ step: "train", method: method.id, fraction, stage });
      });
      if (run.timedOut) throw new PermanentError(`${method.name} did not finish in ${opts.timeoutHours ?? 12} hours.`);
      const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      if (run.code === 2) throw new PermanentError(`${method.name} could not use this capture${tail ? `: ${tail}` : "."}`);
      if (run.code !== 0) throw new Error(`${method.name} stopped (exit ${run.code})${tail ? `: ${tail}` : "."}`);

      const made = (await readdir(output)).filter((f) => /^splats\.(ply|spz)$/.test(f));
      if (made.length !== 1) throw new PermanentError(`${method.name} finished without writing splats.ply or splats.spz.`);
      const outFile = path.join(output, made[0]!);
      const size = (await stat(outFile)).size;
      const prov = await readProvenance(path.join(output, "provenance.json"));
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
        ...(req.placement ? { placement: req.placement } : {}),
        ...(req.centre ? { centre: req.centre } : {}),
        note: `${prov.fixture ? "TEST FIXTURE, not a real reconstruction. " : ""}Made with ${method.name} (${r.preset})${method.generative ? ", partly generated" : ""}.`,
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
      await rm(work, { recursive: true, force: true });
      await finishIfLast();
    } catch (e) {
      await rm(work, { recursive: true, force: true });
      if (e instanceof PermanentError || job.attempts >= job.max_attempts) {
        await audit(db, { ...actor, action: "reconstruct.fail", target: ingestId, detail: { method: method.id, reason: e instanceof Error ? e.message : String(e) } });
        await finishIfLast();
      }
      throw e;
    }
  };
}

export type MethodRun = {
  method: string;
  state: "queued" | "training" | "publishing" | "ready" | "failed";
  fraction: number | null;
  stage: string | null;
  error: string | null;
  modelId: string | null;
  version: number | null;
};

/** Each method's state for one capture: its job while it trains, then the ingest that publishes its splats. */
export async function reconstructStatus(db: Queryable, ingestId: string): Promise<{ state: string; methods: MethodRun[] } | null> {
  const [ing] = await db.query<{ state: string; request: IngestRow["request"] }>("SELECT state, request FROM ingests WHERE id = $1", [ingestId]);
  if (!ing?.request.reconstruct) return null;
  const jobs = await db.query<{ payload: { method: string }; state: string; progress: { step?: string; fraction?: number; stage?: string }; error: string | null }>(
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
    if (j?.state === "failed") return { method: m, state: "failed", fraction: null, stage: null, error: j.error, modelId: null, version: null };
    const p = j?.progress ?? {};
    const running = j?.state === "running" || (j?.state === "queued" && !!j.error);
    return { method: m, state: running ? "training" : "queued", fraction: typeof p.fraction === "number" ? p.fraction : null, stage: p.stage ?? p.step ?? null, error: null, modelId: null, version: null };
  });
  const state = methods.every((m) => m.state === "ready" || m.state === "failed") ? (methods.some((m) => m.state === "ready") ? "ready" : "failed") : "working";
  return { state, methods };
}

/** GET /api/splat-methods (the registry, what is installed, the hardware) and GET /api/captures/:id (progress). */
export function registerReconstruct(app: FastifyInstance, db: Db, opts: ReconstructOptions): void {
  const gpu = closed({ vendor: text, name: text, memoryGb: { type: "number" }, driver: text }, ["vendor", "name", "memoryGb"]);
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
            },
            ["hardware", "installed"],
          ),
        },
      },
    },
    async () => ({ hardware: await opts.hardware(), installed: Object.keys(opts.workers).filter((id) => !!methodById(id)) }),
  );
  const run = closed(
    {
      method: text,
      state: { enum: ["queued", "training", "publishing", "ready", "failed"] },
      fraction: { anyOf: [{ type: "number" }, { type: "null" }] },
      stage: { anyOf: [text, { type: "null" }] },
      error: { anyOf: [text, { type: "null" }] },
      modelId: { anyOf: [text, { type: "null" }] },
      version: { anyOf: [{ type: "integer" }, { type: "null" }] },
    },
    ["method", "state", "fraction", "stage", "error", "modelId", "version"],
  );
  app.get<{ Params: { id: string } }>(
    "/api/captures/:id",
    { schema: { tags: ["capture"], params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 200 } } }, response: { 200: closed({ state: { enum: ["working", "ready", "failed"] }, methods: { type: "array", items: run } }, ["state", "methods"]) } } },
    async (req, reply) => (await reconstructStatus(db, req.params.id)) ?? reply.status(404).send(problem("noUpload")),
  );
}
