import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Local FBX (WP 5.2, decision D-3): the desktop app converts FBX to GLB with the same
 * FBX2glTF the server uses, so a file opens offline and looks the same as once published.
 *
 * The converter is a native program that parses an untrusted file, so it runs on its own:
 * no shell, its own empty work folder as current directory and temp folder, an environment
 * with nothing of the user's in it, a time limit, a cap on what it may print, one conversion
 * at a time, and it is killed if the app quits. It reads only the FBX (and textures beside it)
 * and writes only into its work folder.
 */

const BIN = process.platform === "win32" ? "FBX2glTF.exe" : "FBX2glTF";
const PLATFORM_DIR: Record<string, string> = { win32: "Windows_NT", linux: "Linux", darwin: "Darwin" };

/** Where FBX2glTF is: next to the app when installed; in development VIEWER_FBX2GLTF, or the npm package. */
export function findConverter(o: { env: Record<string, string | undefined>; packaged: boolean; resourcesPath: string; here: string }): string | null {
  const candidates: string[] = [];
  if (o.packaged) candidates.push(path.join(o.resourcesPath, "bin", BIN));
  else {
    if (o.env.VIEWER_FBX2GLTF) candidates.push(o.env.VIEWER_FBX2GLTF);
    try {
      const pkg = createRequire(path.join(o.here, "x.js")).resolve("fbx2gltf/package.json");
      candidates.push(path.join(path.dirname(pkg), "bin", PLATFORM_DIR[process.platform] ?? process.platform, BIN));
    } catch {
      /* not installed */
    }
  }
  for (const c of candidates) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      if (process.platform !== "win32") {
        try {
          fs.accessSync(c, fs.constants.X_OK);
        } catch {
          // pnpm unpacks the package's programs without the execute bit (development only).
          fs.chmodSync(c, 0o755);
        }
      }
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export type ConvertResult = { ok: true; glb: string; ms: number } | { ok: false; reason: "failed" | "timeout"; detail: string };

export interface ConvertOptions {
  /** Folder of its own for this conversion; created empty. */
  workDir: string;
  timeoutMs?: number;
}

/** What the converter may see of the environment: only what Windows needs to start a program. */
function sandboxEnv(workDir: string): Record<string, string> {
  const keep = process.platform === "win32" ? ["SystemRoot", "windir", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"] : [];
  const env: Record<string, string> = { TEMP: workDir, TMP: workDir, TMPDIR: workDir, HOME: workDir, USERPROFILE: workDir };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const running = new Set<{ kill: () => void }>();
/** Stops every conversion (the app is quitting). */
export function stopAll(): void {
  for (const r of running) r.kill();
}

let queue: Promise<unknown> = Promise.resolve();

/** Converts one FBX to a GLB in `workDir`, one at a time. */
export function convertFbx(bin: string, input: string, o: ConvertOptions): Promise<ConvertResult> {
  const job = queue.then(() => convertNow(bin, input, o));
  queue = job.catch(() => undefined);
  return job;
}

async function convertNow(bin: string, input: string, o: ConvertOptions): Promise<ConvertResult> {
  await fs.promises.rm(o.workDir, { recursive: true, force: true });
  await fs.promises.mkdir(o.workDir, { recursive: true });
  const name = path.basename(input).replace(/\.fbx$/i, "") || "model";
  const base = path.join(o.workDir, name);
  const t0 = Date.now();
  const r = await new Promise<{ code: number | string | null; out: string; timedOut: boolean }>((resolve) => {
    const child = execFile(
      bin,
      ["--binary", "--input", input, "--output", base],
      { cwd: o.workDir, env: sandboxEnv(o.workDir), timeout: o.timeoutMs ?? 10 * 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        running.delete(handle);
        const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({ code: e ? (e.code ?? -1) : 0, out: `${stdout}${stderr}`.trim(), timedOut: !!e?.killed && e.signal === "SIGKILL" });
      },
    );
    const handle = { kill: () => child.kill("SIGKILL") };
    running.add(handle);
  });
  const glb = `${base}.glb`;
  if (r.timedOut) return { ok: false, reason: "timeout", detail: "" };
  const size = await fs.promises.stat(glb).then((s) => s.size, () => 0);
  if (r.code !== 0 || !size) return { ok: false, reason: "failed", detail: r.out.split("\n").slice(-3).join(" ").slice(0, 400) || `exit code ${String(r.code)}` };
  return { ok: true, glb, ms: Date.now() - t0 };
}
