import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PermanentError } from "./permanent.ts";
import type { TileOptions } from "./tiler.ts";

/**
 * The conversion sandbox (NFR-14, plan section 4: "workers sandboxed, no network").
 *
 * Every step that reads an uploaded file with more than a header check runs in a container of its
 * own: converting an FBX (a native program), the official validators, tiling and optimising. The
 * container is rootless Podman with:
 *   - no network at all (--network=none: only a loopback interface);
 *   - a read-only root that holds only the C libraries (the bundle's sandbox/rootfs), and the
 *     program (Node.js, the server, FBX2glTF) mounted read-only;
 *   - one writable folder, the upload's own work folder, and a small /tmp;
 *   - no capabilities, no new privileges, a time limit, and the server's own user (rootless), so
 *     it can reach nothing the server could not.
 * A broken or hostile file can then crash or hang only its own container; it cannot reach the
 * network, the library, the database or another upload.
 */
export type Step =
  | { task: "fbx"; bin: string; input: string; outDir: string }
  | { task: "validate"; kind: "3dtiles" | "gltf"; file: string; timeoutMs: number }
  | { task: "tile"; file: string; outDir: string; opts: TileOptions }
  | { task: "optimise"; file: string; outFile: string }
  | { task: "probe"; work: string };

export interface RunOptions {
  timeoutMs: number;
  onProgress?: (p: { done: number; total: number }) => void;
}

export interface Sandbox {
  readonly kind: string;
  /** Runs one step with `work` as the only writable folder. Resolves to the step's result. */
  run<T>(step: Step, work: string, opts: RunOptions): Promise<T>;
}

export interface PodmanOptions {
  /** The podman program. */
  podman: string;
  /** The container's root: the C libraries Node.js and FBX2glTF need, nothing else. */
  rootfs: string;
  /** Where podman keeps its state (rootless: a folder the server owns). */
  stateDir: string;
  /** Folders mounted read-only at the same path (the program); found by default. */
  mounts?: string[];
  /** Memory limit in MB for one step; needs cgroup delegation (rootless under systemd may not have it). */
  memoryMb?: number;
}

/** The step runner: dist/convert-step.js beside the built server (from source, tests build it first). */
const STEP = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/convert-step.js" : "./convert-step.js", import.meta.url));

/** The folders a step needs to read: Node.js and the server with its packages. */
export async function programMounts(extra: string[] = []): Promise<string[]> {
  const node = path.dirname(path.dirname(await realpath(process.execPath)));
  const server = path.dirname(path.dirname(await realpath(STEP)));
  const all = await Promise.all([node, server, ...extra].map((p) => realpath(p).catch(() => p)));
  // A folder inside another is mounted with it.
  return [...new Set(all)].sort().filter((p, i, a) => !a.slice(0, i).some((q) => p === q || p.startsWith(q + path.sep)));
}

export class PodmanSandbox implements Sandbox {
  readonly kind = "podman";
  private mounts: Promise<string[]>;
  private opts: PodmanOptions;
  private root: Promise<string> | undefined;
  constructor(opts: PodmanOptions) {
    this.opts = opts;
    this.mounts = programMounts(opts.mounts);
  }

  /**
   * The root the containers use: a copy of the release's, under the state folder. podman writes
   * into a root before it mounts it read-only (the /etc/mtab link, the mount points), and the
   * release folder is read-only to the server under systemd. The container still cannot write it.
   */
  private rootfs(): Promise<string> {
    this.root ??= (async () => {
      const dest = path.join(this.opts.stateDir, "rootfs");
      await rm(dest, { recursive: true, force: true });
      await cp(this.opts.rootfs, dest, { recursive: true, verbatimSymlinks: true });
      // The copy keeps the release's modes; its folders must be the server's to write.
      for (const f of [".", ...(await readdir(dest, { recursive: true }))]) {
        const st = await lstat(path.join(dest, f));
        if (st.isDirectory()) await chmod(path.join(dest, f), st.mode | 0o700);
      }
      return dest;
    })();
    return this.root;
  }

  /**
   * podman's own options: state under the server's data folder, and nothing that needs a login
   * session (systemd user manager, journald) or a device (fuse): the root is a plain folder.
   */
  private global(): string[] {
    const s = this.opts.stateDir;
    return ["--root", path.join(s, "storage"), "--runroot", path.join(s, "run"), "--tmpdir", path.join(s, "tmp"), "--storage-driver", "vfs", "--cgroup-manager", "cgroupfs", "--events-backend", "none"];
  }

  async args(step: Step, work: string, name: string, timeoutMs: number): Promise<string[]> {
    const ro = (await this.mounts).flatMap((m) => ["--volume", `${m}:${m}:ro`]);
    return [
      ...this.global(),
      "run", "--rm", "--name", name,
      "--network", "none",
      "--read-only", "--read-only-tmpfs=false",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
      "--cap-drop", "all",
      "--security-opt", "no-new-privileges",
      "--user", "0:0",
      ...(this.opts.memoryMb ? ["--memory", `${this.opts.memoryMb}m`] : []),
      "--ulimit", "core=0",
      "--timeout", String(Math.ceil(timeoutMs / 1000)),
      "--env", "HOME=/tmp",
      "--env", "NODE_ENV=production",
      "--log-driver", "none",
      ...ro,
      "--volume", `${work}:${work}:rw`,
      "--workdir", work,
      "--rootfs", await this.rootfs(),
      // Real paths: only those are mounted (/opt/viewer is a link to the release in use).
      await realpath(process.execPath), await realpath(STEP), JSON.stringify(step.task === "fbx" ? { ...step, bin: await realpath(step.bin) } : step),
    ];
  }

  async run<T>(step: Step, work: string, opts: RunOptions): Promise<T> {
    for (const d of ["storage", "run", "tmp"]) await mkdir(path.join(this.opts.stateDir, d), { recursive: true });
    // podman's defaults set a network sysctl in each container; a step with no network needs
    // none, and where /proc/sys is read-only setting it would fail.
    const conf = path.join(this.opts.stateDir, "containers.conf");
    await writeFile(conf, "[containers]\ndefault_sysctls = []\n");
    const name = `viewer-step-${randomUUID().slice(0, 12)}`;
    const args = await this.args(step, work, name, opts.timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.opts.podman, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.opts.stateDir, XDG_RUNTIME_DIR: path.join(this.opts.stateDir, "run"), CONTAINERS_CONF_OVERRIDE: conf } });
      let buf = "";
      let err = "";
      let result: { type: "done"; result: T } | { type: "error"; message: string; permanent?: boolean } | null = null;
      const timer = setTimeout(() => {
        // The container's own --timeout stops it too; this also covers podman itself hanging.
        spawn(this.opts.podman, [...this.global(), "rm", "--force", "--time", "0", name], { stdio: "ignore" });
        child.kill("SIGKILL");
      }, opts.timeoutMs + 15_000);
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (m.type === "progress") opts.onProgress?.(m);
            else if (m.type === "done" || m.type === "error") result = m;
          } catch {
            /* not one of ours */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
      child.once("error", (e) => (clearTimeout(timer), reject(new Error(`The conversion sandbox could not start podman: ${e.message}`))));
      child.once("close", (code) => {
        clearTimeout(timer);
        if (result?.type === "done") return resolve(result.result);
        if (result?.type === "error") return reject(result.permanent ? new PermanentError(result.message) : new Error(result.message));
        const why = err.trim().split("\n").slice(-3).join(" ");
        reject(new Error(code === 137 || code === 255 ? `The step was stopped after ${Math.round(opts.timeoutMs / 60_000)} minutes.` : `The conversion sandbox stopped (exit code ${code})${why ? `: ${why}` : ""}`));
      });
    });
  }
}

/** What the sandbox lets a step do; the server refuses to start with a sandbox that leaks. */
export interface ProbeResult {
  network: string;
  dns: string;
  rootWritable: boolean;
  workWritable: boolean;
}

export async function probeSandbox(sandbox: Sandbox, work: string): Promise<{ ok: boolean; problems: string[]; result?: ProbeResult }> {
  await mkdir(work, { recursive: true });
  let r: ProbeResult;
  try {
    r = await sandbox.run<ProbeResult>({ task: "probe", work }, work, { timeoutMs: 60_000 });
  } catch (e) {
    return { ok: false, problems: [`the sandbox does not run: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const problems: string[] = [];
  // With no network there is no route at all; anything else (even a refusal) means there is one.
  if (r.network !== "ENETUNREACH") problems.push(`a step can reach the network (${r.network})`);
  if (r.dns === "resolved") problems.push("a step can look up names");
  if (r.rootWritable) problems.push("a step can write outside its work folder");
  if (!r.workWritable) problems.push("a step cannot write its work folder");
  return { ok: problems.length === 0, problems, result: r };
}
