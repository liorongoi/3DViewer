import os from "node:os";
import type { Queryable } from "./db.ts";
import type { ReconstructOptions } from "./reconstruct.ts";
import { redactor } from "./redact.ts";
import { componentStates } from "./splat-components.ts";
import { readTrainingLogs } from "./training-log.ts";

/**
 * One text file an administrator can take away to report a problem (docs/OPERATIONS.md,
 * "Debug log"). It keeps what helps debugging: versions, hardware, which methods are set up and
 * what their checks said, recent captures and jobs with their timings and errors, and the newest
 * training logs. It never includes environment variables, settings values, file names from
 * captures, client addresses or audit entries, and the whole text goes through the redactor
 * (redact.ts) last, so a stray address or path in an error message is removed too.
 */
export async function debugLog(db: Queryable, opts: ReconstructOptions, check: Parameters<typeof componentStates>[2]): Promise<string> {
  const out: string[] = [];
  const section = (t: string) => out.push("", `=== ${t} ===`);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : "-");
  const secs = (a: unknown, b: unknown) => (a && b ? `${Math.round((new Date(b as string).getTime() - new Date(a as string).getTime()) / 1000)} s` : "-");

  out.push("HOLO debug log", `made ${new Date().toISOString()}`, "Addresses, machine and user names, domains, paths and settings values are replaced with placeholders.");

  section("Server");
  const hw = await opts.hardware();
  out.push(`node ${process.version}, ${process.platform} ${process.arch}, ${os.type()} ${os.release()}`);
  out.push(`up ${Math.round(process.uptime())} s; memory ${Math.round(process.memoryUsage().rss / 1048576)} MB used by HOLO, ${Math.round(os.freemem() / 1073741824)} of ${Math.round(os.totalmem() / 1073741824)} GB free`);
  out.push(`CPU ${hw.cpuModel}, ${hw.cpus} threads, ${hw.ramGb} GB`);
  for (const g of hw.gpus) out.push(`GPU ${g.vendor} ${g.name}, ${g.memoryGb} GB${g.freeGb !== undefined ? `, ${g.freeGb} GB free` : ""}${g.driver ? `, driver ${g.driver}` : ""}`);
  if (!hw.gpus.length) out.push("GPU none found (nvidia-smi did not answer)");
  out.push(`CUDA_VISIBLE_DEVICES ${process.env.CUDA_VISIBLE_DEVICES === undefined ? "not set" : "set"}; training time limit ${opts.timeoutHours ?? 12} h; virus scan ${opts.scan ? "on" : "off"}`);

  section("Splat methods");
  for (const c of await componentStates(db, opts.workers, check))
    out.push(`${c.method}: configured ${c.configured ? "yes" : "no"}, environment ${c.environment}, version ${c.version ?? "-"}, revision ${c.revision ?? "-"}, trained here ${c.trained ? `${c.trained.at}${c.trained.fixture ? " (test fixture)" : ""}` : "never"}${c.problems.length ? `\n    problems: ${c.problems.join(" | ")}` : ""}`);

  section("Recent captures (newest 20)");
  const caps = await db.query<{ id: string; state: string; request: { reconstruct?: { input: string; goal: string; preset: string; methods: string[] }; files?: { size: number }[] }; error: string | null; created_at: string; updated_at: string }>(
    "SELECT id, state, request, error, created_at, updated_at FROM ingests WHERE request ? 'reconstruct' ORDER BY created_at DESC LIMIT 20",
  );
  for (const c of caps) {
    const r = c.request.reconstruct!;
    const bytes = (c.request.files ?? []).reduce((s, f) => s + (f.size ?? 0), 0);
    out.push(`${c.id} ${c.state}: ${r.input}, goal ${r.goal}, preset ${r.preset}, methods ${r.methods.join(" ")}, ${(c.request.files ?? []).length} files, ${Math.round(bytes / 1048576)} MB, created ${iso(c.created_at)}, last change after ${secs(c.created_at, c.updated_at)}${c.error ? `\n    error: ${c.error}` : ""}`);
  }
  if (!caps.length) out.push("none");

  section("Recent jobs that failed or are running (newest 30)");
  const jobs = await db.query<{ id: string; kind: string; state: string; attempts: number; max_attempts: number; payload: Record<string, unknown>; progress: Record<string, unknown>; error: string | null; created_at: string; updated_at: string }>(
    "SELECT id, kind, state, attempts, max_attempts, payload, progress, error, created_at, updated_at FROM jobs WHERE state IN ('failed', 'running') OR error IS NOT NULL ORDER BY updated_at DESC LIMIT 30",
  );
  for (const j of jobs) {
    const what = [j.payload.ingestId && `capture ${String(j.payload.ingestId)}`, j.payload.method && `method ${String(j.payload.method)}`].filter(Boolean).join(", ");
    out.push(`job ${j.id} ${j.kind} ${j.state}, attempt ${j.attempts}/${j.max_attempts}${what ? `, ${what}` : ""}, step ${String(j.progress.step ?? j.progress.stage ?? "-")}, ${iso(j.created_at)} + ${secs(j.created_at, j.updated_at)}${j.error ? `\n    error: ${j.error}` : ""}`);
  }
  if (!jobs.length) out.push("none");

  section("Training logs (newest 10)");
  const logs = opts.logDir ? await readTrainingLogs(opts.logDir, 10) : [];
  for (const l of logs) out.push(`--- ${l.name} ---`, l.text.trimEnd());
  if (!logs.length) out.push("none");

  return redactor([...Object.values(opts.workers), ...(opts.logDir ? [opts.logDir] : [])])(out.join("\n")) + "\n";
}
