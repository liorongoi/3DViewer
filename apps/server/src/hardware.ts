import { execFile } from "node:child_process";
import os from "node:os";
import type { GpuInfo, ServerHardware } from "@viewer/shared";

/**
 * What this server can train splats on (docs/GAUSSIAN_SPLATS.md, "Hardware"). Read once from the
 * operating system and nvidia-smi; nothing is installed or changed. The answer only chooses the
 * recommended method and the preset limits; a worker still fails cleanly if it cannot run.
 */

/**
 * Parses `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`.
 * The product name is the first field; the driver version is kept apart so a driver branch such
 * as "550.54" is never mistaken for the GPU model.
 */
export function parseNvidiaSmi(out: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const mib = Number(parts[1]);
    if (!Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({ vendor: "nvidia", name: parts[0], memoryGb: Math.round((mib / 1024) * 10) / 10, ...(parts[2] ? { driver: parts[2] } : {}) });
  }
  return gpus;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    // No shell, a short timeout and a small output limit: a missing or hung tool just means "none".
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Apple silicon shares memory between CPU and GPU; Metal lets one process use about three quarters of it. */
export function appleGpu(cpuModel: string, ramGb: number): GpuInfo {
  return { vendor: "apple", name: cpuModel.replace(/\s+/g, " ").trim() || "Apple silicon", memoryGb: Math.round(ramGb * 0.75 * 10) / 10 };
}

export async function probeHardware(opts: { nvidiaSmi?: string; timeoutMs?: number } = {}): Promise<ServerHardware> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() ?? "";
  const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const gpus: GpuInfo[] = [];
  if (process.platform === "darwin" && process.arch === "arm64") gpus.push(appleGpu(cpuModel, ramGb));
  else {
    const out = await run(opts.nvidiaSmi ?? "nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], opts.timeoutMs ?? 5000);
    if (out) gpus.push(...parseNvidiaSmi(out));
  }
  return { platform: process.platform, arch: process.arch, cpuModel, cpus: os.availableParallelism?.() ?? cpus.length, ramGb, gpus };
}

let cached: Promise<ServerHardware> | null = null;
/** Probed once per process: the hardware does not change while the server runs. */
export const serverHardware = (): Promise<ServerHardware> => (cached ??= probeHardware());
