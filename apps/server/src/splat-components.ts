import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { SPLAT_METHODS } from "@viewer/shared";
import type { Queryable } from "./db.ts";

/**
 * Component management for splat methods (SRS GS-33, docs/GAUSSIAN_SPLATS.md "Installing a method").
 *
 * Four states are kept apart, each from its own evidence, never guessed:
 *   source       the worker reports the upstream source revision it runs (`--check`)
 *   environment  the worker's own check passed: its programs and libraries load (`--check`)
 *   configured   SPLAT_WORKERS names a worker program for the method
 *   trained      a training with this method finished and was published on this server
 * HOLO never installs anything itself: GPU libraries stay out of the application's runtime.
 *
 * `<worker> --check --method <id>` prints one JSON object on stdout:
 *   { "ok": true|false, "tool": "...", "version": "...", "revision": "<git sha or release>",
 *     "problems": ["what is missing, in plain words"], "fixture": true when it is a test worker }
 */

export interface ComponentState {
  method: string;
  configured: boolean;
  /** unchecked: no worker, or its check has not answered yet; failed: the check could not run. */
  environment: "ok" | "broken" | "failed" | "unchecked";
  revision: string | null;
  version: string | null;
  problems: string[];
  /** The last training that finished here, real runs before test-fixture runs. */
  trained: { at: string; fixture: boolean } | null;
  fixture: boolean;
}

interface CheckResult {
  environment: ComponentState["environment"];
  revision: string | null;
  version: string | null;
  problems: string[];
  fixture: boolean;
}

/** Reads a worker's `--check` answer. Anything unexpected is "failed", with the reason kept short. */
export function parseCheck(stdout: string): CheckResult {
  const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  try {
    const j = JSON.parse(line ?? "") as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
    const problems = Array.isArray(j.problems) ? j.problems.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 300)).slice(0, 10) : [];
    return { environment: j.ok === true ? "ok" : "broken", revision: str(j.revision), version: str(j.version), problems, fixture: j.fixture === true };
  } catch {
    return { environment: "failed", revision: null, version: null, problems: ["The worker's check did not answer with JSON."], fixture: false };
  }
}

function runCheck(bin: string, method: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    // Same rules as a training run: no shell, a minimal environment, a time limit.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), LANG: "C.UTF-8" };
    if (process.env.CUDA_VISIBLE_DEVICES) env.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
    execFile(bin, ["--check", "--method", method], { timeout: timeoutMs, maxBuffer: 64 * 1024, env, cwd: tmpdir(), windowsHide: true }, (err, stdout) => {
      const r = parseCheck(String(stdout ?? ""));
      if (err && r.environment === "failed") r.problems = [`The worker's check did not run: ${err.message.slice(0, 200)}`];
      resolve(r);
    });
  });
}

/** Checks each configured worker at most every ten minutes; a check never blocks longer than its time limit. */
export function componentChecker(workers: Record<string, string>, opts: { timeoutMs?: number; maxAgeMs?: number } = {}) {
  const cache = new Map<string, { at: number; result: Promise<CheckResult> }>();
  return (method: string): Promise<CheckResult> | null => {
    const bin = workers[method];
    if (!bin) return null;
    const hit = cache.get(method);
    if (hit && Date.now() - hit.at < (opts.maxAgeMs ?? 600_000)) return hit.result;
    const result = runCheck(bin, method, opts.timeoutMs ?? 60_000);
    cache.set(method, { at: Date.now(), result });
    return result;
  };
}

/** Every registry method's four states on this server. */
export async function componentStates(db: Queryable, workers: Record<string, string>, check: (method: string) => Promise<CheckResult> | null): Promise<ComponentState[]> {
  const runs = await db.query<{ method: string; fixture: boolean; at: string }>(
    `SELECT DISTINCT ON (request->>'method', COALESCE(request->'provenance'->>'fixture', 'false'))
       request->>'method' AS method, COALESCE(request->'provenance'->>'fixture', 'false') = 'true' AS fixture, updated_at AS at
     FROM ingests WHERE request ? 'parentIngest' AND state = 'ready'
     ORDER BY request->>'method', COALESCE(request->'provenance'->>'fixture', 'false'), updated_at DESC`,
  );
  return Promise.all(
    SPLAT_METHODS.map(async (m): Promise<ComponentState> => {
      const c = await (check(m.id) ?? Promise.resolve<CheckResult>({ environment: "unchecked", revision: null, version: null, problems: [], fixture: false }));
      const mine = runs.filter((r) => r.method === m.id).sort((a, b) => Number(a.fixture) - Number(b.fixture));
      const last = mine[0];
      return {
        method: m.id,
        configured: !!workers[m.id],
        environment: c.environment,
        revision: c.revision,
        version: c.version,
        problems: c.problems,
        trained: last ? { at: new Date(last.at).toISOString(), fixture: !!last.fixture } : null,
        fixture: c.fixture,
      };
    }),
  );
}

/** A method can be offered when a worker is configured and its check did not report it broken. */
export const usable = (s: ComponentState): boolean => s.configured && s.environment !== "broken" && s.environment !== "failed";
