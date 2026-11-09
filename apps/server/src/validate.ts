import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { checkItem, type CheckItem } from "@viewer/core/loaders";
import type { Sandbox } from "./sandbox.ts";

/**
 * The official Khronos and Cesium validators (WP 3.3, UPL-02): gltf-validator for glTF and GLB,
 * 3d-tiles-validator for tilesets (it also runs gltf-validator on every tile's content).
 *
 * They run in a child process so a huge tileset cannot block the API or its memory, and so a
 * run that takes too long can be stopped. (Not a worker thread: the validator loads sharp,
 * whose native module loads only once per process.) The shared loader check stays the gate: real tilesets that every
 * viewer shows often break a rule (Lyon's has 72 misaligned b3dm tiles), so by default the
 * validator's errors are listed as warnings. STRICT_VALIDATION makes them block publishing.
 */
export interface ValidateOptions {
  /** Validator errors block publishing. */
  strict?: boolean;
  /** Stop the validator after this long and say so in the report. */
  timeoutMs?: number;
  /** Run it in the conversion sandbox, with this folder writable (sandbox.ts). */
  sandbox?: Sandbox;
  sandboxWork?: string;
}

/** One problem as the validators report it, with its causes flattened. */
export interface Issue {
  severity: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
  path: string;
}

const require = createRequire(import.meta.url);

/** The child: plain CommonJS, given the two packages' resolved paths as JSON in argv. */
const WORKER = `
const workerData = JSON.parse(process.argv[1]);
const done = (m) => process.send(m, () => process.exit(0));
const fs = require("node:fs");
const path = require("node:path");
const out = [];
function walk(r, file) {
  if (!r) return;
  const causes = r.causes || [];
  // A content error is a wrapper; its causes say what is wrong.
  if (!/^CONTENT_VALIDATION_/.test(r.type) || causes.length === 0) out.push({ severity: r.severity, code: r.type, message: r.message, path: r.path || file });
  for (const c of causes) walk({ ...c, path: c.path && c.path.startsWith("/") ? (r.path || file) + " " + c.path : c.path }, r.path || file);
}
(async () => {
  const { kind, file, tiles, gltf } = workerData;
  if (kind === "3dtiles") {
    const { Validators } = require(tiles);
    const r = await Validators.validateTilesetFile(file);
    for (let i = 0; i < r.length; i++) { const x = r.get(i); walk(typeof x.toJson === "function" ? x.toJson() : x, path.basename(file)); }
  } else {
    const gv = require(gltf);
    const dir = path.dirname(file);
    const report = await gv.validateBytes(new Uint8Array(fs.readFileSync(file)), {
      uri: path.basename(file),
      maxIssues: 0,
      externalResourceFunction: (uri) => {
        const p = path.resolve(dir, decodeURIComponent(uri.split(/[?#]/)[0]));
        if (!p.startsWith(dir + path.sep)) return Promise.reject(new Error("outside the model folder"));
        return fs.promises.readFile(p).then((b) => new Uint8Array(b));
      },
    });
    const sev = ["ERROR", "WARNING", "INFO", "INFO"];
    for (const m of report.issues.messages) out.push({ severity: sev[m.severity] || "INFO", code: m.code, message: m.message, path: path.basename(file) + (m.pointer ? " " + m.pointer : "") });
  }
  done(out);
})().catch((e) => done({ failed: String((e && e.message) || e) }));
`;

function resolveOrNull(id: string): string | null {
  try {
    return require.resolve(id);
  } catch {
    return null;
  }
}

export type ValidatorRun = Issue[] | { failed: string } | "timeout";

/** Runs the validator for this format. Resolves to the issues, or to why it could not run. */
export function runValidator(kind: "3dtiles" | "gltf", file: string, timeoutMs: number): Promise<ValidatorRun> {
  const tiles = resolveOrNull("3d-tiles-validator");
  const gltf = resolveOrNull("gltf-validator");
  if (!(kind === "3dtiles" ? tiles : gltf)) return Promise.resolve({ failed: `${kind === "3dtiles" ? "3d-tiles-validator" : "gltf-validator"} is not installed` });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", WORKER, JSON.stringify({ kind, file, tiles, gltf })], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let err = "";
    let settled = false;
    const finish = (v: ValidatorRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(v);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.once("message", (m) => finish(m as Issue[] | { failed: string }));
    child.once("error", (e: Error) => finish({ failed: e.message }));
    child.once("exit", (code) => finish({ failed: err.trim().split("\n").slice(-3).join(" ") || `The validator stopped (exit code ${code}).` }));
  });
}

/** Same problem in many files is one line: "×72 The byte length must be aligned to 8 bytes (tiles/122.b3dm, …)". */
export function summarise(issues: Issue[], severity: Issue["severity"], max = 12): string {
  const groups = new Map<string, { message: string; paths: string[] }>();
  for (const i of issues.filter((x) => x.severity === severity)) {
    const key = `${i.code} ${i.message.replace(/\d+/g, "#")}`;
    const g = groups.get(key) ?? { message: i.message, paths: [] };
    g.paths.push(i.path);
    groups.set(key, g);
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.paths.length - a.paths.length)
    .map((g) => {
      const where = g.paths.slice(0, 3).join(", ") + (g.paths.length > 3 ? ", …" : "");
      return `${g.paths.length > 1 ? `×${g.paths.length} ` : ""}${g.message} (${where})`;
    });
  return lines.slice(0, max).join("\n") + (lines.length > max ? `\n…and ${lines.length - max} more kinds of problem` : "");
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The report line for the official validator of this format. */
export async function validateOfficial(format: "3dtiles" | "gltf" | "glb", file: string, opts: ValidateOptions = {}): Promise<CheckItem> {
  const kind = format === "3dtiles" ? "3dtiles" : "gltf";
  const name = kind === "3dtiles" ? "3D Tiles" : "glTF";
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const r = opts.sandbox ? await opts.sandbox.run<ValidatorRun>({ task: "validate", kind, file, timeoutMs }, opts.sandboxWork ?? path.dirname(file), { timeoutMs: timeoutMs + 60_000 }) : await runValidator(kind, file, timeoutMs);
  if (r === "timeout") return checkItem("validator", "warning", "validatorTimeout", { format: name, minutes: Math.round(timeoutMs / 60_000) });
  if (!Array.isArray(r)) return checkItem("validator", "warning", "validatorFailed", { format: name }, r.failed);
  const errors = r.filter((i) => i.severity === "ERROR").length;
  const warnings = r.filter((i) => i.severity === "WARNING").length;
  if (errors) {
    const detail = summarise(r, "ERROR") + (warnings ? `\nAlso ${plural(warnings, "warning")}.` : "");
    return opts.strict
      ? checkItem("validator", "error", "validatorErrors", { format: name, count: errors }, detail)
      : checkItem("validator", "warning", "validatorErrorsLoads", { format: name, count: errors }, detail);
  }
  if (warnings) return checkItem("validator", "ok", "validatorWarnings", { format: name, count: warnings }, summarise(r, "WARNING"));
  return checkItem("validator", "ok", "validatorPassed", { format: name });
}
