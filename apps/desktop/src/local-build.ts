import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * "Build on this PC": Gaussian splats from a video or photos, made on this computer's own graphics
 * card with the building add-on (scripts/make-building-bundle-windows.sh), then opened in HOLO.
 *
 * The add-on is a zip the user picks once. It is unpacked into the user's own app data, checked
 * file by file against its SHA256SUMS, and used from there; nothing is installed system-wide and
 * no administrator is needed. A build runs HOLO's own building steps (worker/holo-splat-worker.mjs)
 * with the add-on's Node.js: no shell, an environment with only what the tools need, its own work
 * folder, one build at a time, stopped with everything it started if the user stops it or quits.
 * The user's files are read where they are (linked, or copied when they cannot be), never changed.
 */

const EXE = process.platform === "win32" ? ".exe" : "";

/** What a capture may hold: one video, or photos. */
export const CAPTURE_VIDEO = /\.(mp4|mov|m4v|lrv|ts|mts|avi|mkv|webm)$/i;
export const CAPTURE_PHOTO = /\.(jpe?g|png|tiff?|webp)$/i;

export interface Addon {
  dir: string;
  version: string;
}

/** The parts an unpacked add-on must have. */
export const addonParts = (dir: string) => ({
  node: path.join(dir, "node", `node${EXE}`),
  python: path.join(dir, "python", `python${EXE}`),
  ffmpeg: path.join(dir, "ffmpeg", `ffmpeg${EXE}`),
  brush: path.join(dir, "brush", `brush_app${EXE}`),
  masks: path.join(dir, "models", "yolox_s.onnx"),
  worker: path.join(dir, "worker", "holo-splat-worker.mjs"),
});

/** The add-on in `dir`, or null when it is not a complete one. */
export function readAddon(dir: string): Addon | null {
  try {
    const first = fs.readFileSync(path.join(dir, "VERSION"), "utf8").split(/\r?\n/)[0] ?? "";
    const m = /^holo-building (\S+)/.exec(first);
    if (!m) return null;
    const p = addonParts(dir);
    for (const f of [p.node, p.python, p.ffmpeg, p.brush, p.worker]) if (!fs.statSync(f).isFile()) return null;
    return { dir, version: m[1]! };
  } catch {
    return null;
  }
}

/** The add-on HOLO was told to use (building.json in the app's data), if it is still complete. */
export function currentAddon(dataDir: string): Addon | null {
  try {
    const { dir } = JSON.parse(fs.readFileSync(path.join(dataDir, "building.json"), "utf8")) as { dir?: unknown };
    return typeof dir === "string" ? readAddon(dir) : null;
  } catch {
    return null;
  }
}

/** Checks every file listed in SHA256SUMS ("<hex>  ./path" lines). Returns the first problem, or null. */
export async function verifySums(dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(dir, "SHA256SUMS"), "utf8");
  } catch {
    return "The add-on has no SHA256SUMS: it is not a HOLO building add-on.";
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return "The add-on's SHA256SUMS is empty.";
  const root = path.resolve(dir);
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) return "The add-on's SHA256SUMS cannot be read.";
    const file = path.resolve(root, m[2]!);
    if (!file.startsWith(root + path.sep)) return "The add-on's SHA256SUMS names a file outside it.";
    const hash = createHash("sha256");
    try {
      await new Promise<void>((resolve, reject) => fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject));
    } catch {
      return `The add-on is missing ${m[2]}.`;
    }
    if (hash.digest("hex") !== m[1]) return `The add-on's ${m[2]} is damaged; download it again.`;
  }
  return null;
}

const tarExe = () => (process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar");

/**
 * Unpacks the add-on zip into `baseDir`, checks it, and makes it the one HOLO uses. An earlier
 * add-on stays until the new one has passed its checks.
 */
export async function installAddon(zip: string, baseDir: string, dataDir: string): Promise<{ ok: true; addon: Addon } | { ok: false; reason: string }> {
  if (!/\.zip$/i.test(zip)) return { ok: false, reason: "Choose the holo-building-…-windows-x64.zip file." };
  await fs.promises.mkdir(baseDir, { recursive: true });
  const tmp = await fs.promises.mkdtemp(path.join(baseDir, ".unpack-"));
  try {
    // Windows' own tar (bsdtar) reads zip files; no shell, a time limit.
    await new Promise<void>((resolve, reject) =>
      execFile(tarExe(), ["-xf", zip, "-C", tmp], { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())),
    );
    const top = (await fs.promises.readdir(tmp)).filter((n) => /^holo-building-.+-x64$/.test(n));
    if (top.length !== 1) return { ok: false, reason: "That zip is not a HOLO building add-on." };
    const unpacked = path.join(tmp, top[0]!);
    const bad = await verifySums(unpacked);
    if (bad) return { ok: false, reason: bad };
    if (!readAddon(unpacked)) return { ok: false, reason: "That add-on is incomplete, or is not the Windows one." };
    const dest = path.join(baseDir, top[0]!);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(unpacked, dest);
    const addon = readAddon(dest)!;
    await fs.promises.writeFile(path.join(dataDir, "building.json"), JSON.stringify({ dir: dest }));
    // Older add-ons are no longer used.
    for (const n of await fs.promises.readdir(baseDir)) if (n !== top[0] && /^holo-building-/.test(n)) await fs.promises.rm(path.join(baseDir, n), { recursive: true, force: true });
    return { ok: true, addon };
  } catch (e) {
    return { ok: false, reason: `The add-on could not be unpacked (${e instanceof Error ? e.message.split("\n")[0] : String(e)}).` };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** What nvidia-smi says about the NVIDIA cards (the page parses it), or "" when there are none. */
export function nvidiaSmi(): Promise<string> {
  const exe = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe") : "nvidia-smi";
  return new Promise((resolve) =>
    execFile(exe, ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5000 }, (e, out) => resolve(e ? "" : String(out))),
  );
}

/** The worker's settings for this add-on: its own programs, and the masks detector when it has one. */
export function workerConfig(addon: Addon): Record<string, unknown> {
  const p = addonParts(addon.dir);
  return {
    _note: "Written by HOLO for Windows for Build on this PC.",
    ffmpeg: p.ffmpeg,
    sfm: "pycolmap",
    python: p.python,
    sfmGpu: false,
    ...(fs.existsSync(p.masks) ? { masks: p.masks } : {}),
    methods: { brush: { program: p.brush, revision: addon.version } },
  };
}

export interface BuildRequest {
  /** The user's files, by path, as HOLO resolved them from what was opened. */
  files: string[];
  inputKind: "video" | "photos";
  name: string;
  /** Only a check of the capture (report.json), nothing built. */
  checkOnly: boolean;
  iterations: number;
  maxSplats: number;
  resolution: number;
  shDegree: number;
  videoFps: number;
  threads: number;
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** The request as the page sent it, with every number held to a sane range. */
export function cleanRequest(r: Partial<BuildRequest>, files: string[]): BuildRequest {
  return {
    files,
    inputKind: r.inputKind === "photos" ? "photos" : "video",
    name: String(r.name ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Splat",
    checkOnly: r.checkOnly === true,
    iterations: clamp(r.iterations, 500, 60_000, 15_000),
    maxSplats: clamp(r.maxSplats, 100_000, 10_000_000, 1_000_000),
    resolution: clamp(r.resolution, 320, 4096, 1600),
    shDegree: clamp(r.shDegree, 0, 3, 3),
    videoFps: clamp(r.videoFps, 1, 10, 3),
    threads: clamp(r.threads, 1, os.availableParallelism(), Math.max(1, os.availableParallelism() - 1)),
  };
}

/** The user's file in the input folder: a hard link when it can be (same drive), else a copy. */
async function place(file: string, dir: string, n: number): Promise<void> {
  const dest = path.join(dir, `${String(n).padStart(4, "0")}-${path.basename(file)}`);
  try {
    await fs.promises.link(file, dest);
  } catch {
    await fs.promises.copyFile(file, dest);
  }
}

export interface Progress {
  fraction: number;
  stage: string;
}

export interface BuildResult {
  ok: boolean;
  /** The finished splats (or report.json for a check), in the user's HOLO builds folder. */
  file?: string;
  folder?: string;
  report?: unknown;
  reason?: string;
  stopped?: boolean;
}

/** Stops a program and everything it started (Brush, Python, ffmpeg). */
function stopTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  else child.kill("SIGTERM");
}

/**
 * One build. `workRoot` holds the build's own folders (removed afterwards); the result goes into
 * `outRoot/<name> <date>/`. Progress comes from the worker's "progress <fraction> <stage>" lines.
 */
export function startBuild(addon: Addon, req: BuildRequest, workRoot: string, outRoot: string, onProgress: (p: Progress) => void): { done: Promise<BuildResult>; stop: () => void } {
  let child: ChildProcess | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (child) stopTree(child);
  };
  const done = (async (): Promise<BuildResult> => {
    const job = await fs.promises.mkdtemp(path.join(workRoot, "build-"));
    try {
      const input = path.join(job, "input");
      const out = path.join(job, "out");
      await fs.promises.mkdir(input, { recursive: true });
      await fs.promises.mkdir(out, { recursive: true });
      let n = 0;
      for (const f of req.files) await place(f, input, ++n);
      const cfgFile = path.join(job, "holo-worker.json");
      await fs.promises.writeFile(cfgFile, JSON.stringify(workerConfig(addon)));
      const p = addonParts(addon.dir);
      const args = req.checkOnly
        ? ["--assess", "--input", input, "--input-kind", req.inputKind, "--output", out, "--threads", String(req.threads)]
        : ["--method", "brush", "--input", input, "--input-kind", req.inputKind, "--goal", "scene", "--output", out, "--iterations", String(req.iterations), "--max-splats", String(req.maxSplats), "--resolution", String(req.resolution), "--sh-degree", String(req.shDegree), "--video-fps", String(req.videoFps), "--threads", String(req.threads)];
      // Only what the tools need: Windows' own folders (the graphics driver's Vulkan loader is there).
      const env: Record<string, string> = { HOLO_WORKER_CONFIG: cfgFile, TEMP: job, TMP: job, PYTHONNOUSERSITE: "1", PYTHONIOENCODING: "utf-8" };
      for (const k of ["SystemRoot", "SystemDrive", "WINDIR", "PATH", "Path", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[k]) env[k] = process.env[k]!;
      let tail = "";
      const code = await new Promise<number | null>((resolve, reject) => {
        if (stopped) return resolve(null);
        child = spawn(p.node, [p.worker, ...args], { cwd: job, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const onData = (chunk: Buffer) => {
          const s = chunk.toString("utf8");
          tail = (tail + s).slice(-8000);
          for (const line of s.split(/\r?\n/)) {
            const m = /^progress ([0-9.]+) (\S+)/.exec(line);
            if (m) onProgress({ fraction: Math.min(1, Number(m[1])), stage: m[2]! });
          }
        };
        child.stdout!.on("data", onData);
        child.stderr!.on("data", onData);
        child.on("error", reject);
        child.on("close", resolve);
      });
      await fs.promises.writeFile(path.join(job, "out", "build.log"), tail).catch(() => undefined);
      if (stopped) return { ok: false, stopped: true };
      if (code !== 0) {
        // Brush found no graphics card it can use: Vulkan comes with the graphics driver.
        if (/No possible adapter available/.test(tail)) return { ok: false, reason: "HOLO could not use the graphics card (no Vulkan driver found). Update the NVIDIA driver, restart the PC, and try again." };
        const last = tail.trim().split(/\r?\n/).filter((l) => !/^progress /.test(l)).slice(-1)[0] ?? "";
        return { ok: false, reason: last.replace(/^\S+Z /, "").slice(0, 400) || `The build stopped (exit ${code}).` };
      }
      if (req.checkOnly) {
        const report = JSON.parse(await fs.promises.readFile(path.join(out, "report.json"), "utf8")) as unknown;
        return { ok: true, report };
      }
      const ply = (await fs.promises.readdir(out)).find((f) => /\.ply$/i.test(f));
      if (!ply) return { ok: false, reason: "The build finished without splats." };
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
      const folder = path.join(outRoot, `${req.name} ${stamp}`);
      await fs.promises.mkdir(folder, { recursive: true });
      for (const f of await fs.promises.readdir(out)) await fs.promises.copyFile(path.join(out, f), path.join(folder, f === ply ? "splats.ply" : f));
      return { ok: true, file: path.join(folder, "splats.ply"), folder };
    } catch (e) {
      return stopped ? { ok: false, stopped: true } : { ok: false, reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
    } finally {
      child = null;
      await fs.promises.rm(job, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  return { done, stop };
}

/**
 * The build folder (`root/<name> <date>`) that holds every one of these files, or null when they
 * are not all inside one build folder. Used to move a finished build to the Recycle Bin when its
 * model is deleted from the library: only a folder HOLO made, never one the page names.
 */
export function buildFolderOf(files: string[], root: string): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let folder: string | null = null;
  for (const f of files) {
    const rel = path.relative(realRoot, f);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    // A file inside a build folder, not a file at the top of the builds folder.
    if (parts.length < 2 || !parts[0]) return null;
    const here = path.join(realRoot, parts[0]);
    if (folder && folder !== here) return null;
    folder = here;
  }
  return folder;
}
