/**
 * Making Gaussian splats from a capture (docs/GAUSSIAN_SPLATS.md, "Making a splat").
 *
 * The methods a server can run, what each is good for, what hardware it needs, and a
 * deterministic recommendation from what the operator has (video, photos, satellite images),
 * what they want (a scene to look around, a surface to measure, a large area, terrain from
 * orbit) and the server's hardware. The recommendation never depends on anything else, so the
 * same answers always give the same method and settings, and tests can pin them down.
 *
 * A method only runs where a worker for it is installed (SPLAT_WORKERS on the server). Training
 * code is not part of HOLO: each worker wraps one upstream project under its own licence.
 */

export const CAPTURE_INPUTS = ["video", "photos", "satellite"] as const;
export type CaptureInput = (typeof CAPTURE_INPUTS)[number];

export const SPLAT_GOALS = ["scene", "surface", "area", "satellite"] as const;
export type SplatGoal = (typeof SPLAT_GOALS)[number];

export const SPLAT_PRESETS = ["fast", "balanced", "high"] as const;
export type SplatPreset = (typeof SPLAT_PRESETS)[number];

/** What the method needs to run at all: an NVIDIA GPU (CUDA), any modern GPU (WebGPU / Metal / Vulkan), or a CPU. */
export type MethodNeeds = "nvidia" | "gpu" | "cpu";

export interface SplatMethod {
  id: string;
  /** Upstream project name, shown as is. */
  name: string;
  goals: SplatGoal[];
  inputs: CaptureInput[];
  needs: MethodNeeds;
  /** GPU memory (or unified memory on Apple) below which the method is not offered, in GB. */
  minMemoryGb: number;
  /** SPDX id, or "research" for code whose licence forbids commercial use or has not been confirmed. */
  licence: string;
  commercialUse: boolean;
  /** Output is partly invented by a generative model, not measured: it is labelled so everywhere. */
  generative?: boolean;
  /** Produces geometry suited to measuring (surface-aligned splats). */
  surfaces?: boolean;
  url: string;
}

/**
 * The registry, best first within each goal. Chosen from current published results and code
 * that can be installed today (research notes and sources in docs/GAUSSIAN_SPLATS.md).
 */
export const SPLAT_METHODS: readonly SplatMethod[] = [
  { id: "gsplat", name: "gsplat (MCMC)", goals: ["scene", "area"], inputs: ["video", "photos"], needs: "nvidia", minMemoryGb: 6, licence: "Apache-2.0", commercialUse: true, url: "https://github.com/nerfstudio-project/gsplat" },
  { id: "gsplat-2dgs", name: "gsplat 2DGS", goals: ["surface"], inputs: ["video", "photos"], needs: "nvidia", minMemoryGb: 8, licence: "Apache-2.0", commercialUse: true, surfaces: true, url: "https://github.com/nerfstudio-project/gsplat" },
  { id: "brush", name: "Brush", goals: ["scene"], inputs: ["video", "photos"], needs: "gpu", minMemoryGb: 4, licence: "Apache-2.0", commercialUse: true, url: "https://github.com/ArthurBrussee/brush" },
  { id: "opensplat", name: "OpenSplat", goals: ["scene"], inputs: ["video", "photos"], needs: "cpu", minMemoryGb: 0, licence: "AGPL-3.0", commercialUse: true, url: "https://github.com/pierotofy/OpenSplat" },
  { id: "citygaussian-v2", name: "CityGaussianV2", goals: ["area", "surface"], inputs: ["video", "photos"], needs: "nvidia", minMemoryGb: 24, licence: "research", commercialUse: false, surfaces: true, url: "https://github.com/Linketic/CityGaussian" },
  { id: "eogs-plus", name: "EOGS++", goals: ["satellite"], inputs: ["satellite"], needs: "nvidia", minMemoryGb: 12, licence: "research", commercialUse: false, surfaces: true, url: "https://gardiens.github.io/EOGS2/" },
  { id: "skyfall-gs", name: "Skyfall-GS", goals: ["satellite"], inputs: ["satellite"], needs: "nvidia", minMemoryGb: 24, licence: "research", commercialUse: false, generative: true, url: "https://skyfall-gs.jayinnn.dev/" },
];

export const methodById = (id: string): SplatMethod | undefined => SPLAT_METHODS.find((m) => m.id === id);

export interface GpuInfo {
  vendor: "nvidia" | "apple" | "amd" | "intel" | "other";
  /** The product name as the driver reports it (for NVIDIA, the name field of nvidia-smi, never the driver version). */
  name: string;
  /** Memory the GPU can use, in GB. On Apple silicon this is the share of unified memory Metal lets one process use. */
  memoryGb: number;
  /** Memory free when it was read (NVIDIA only): another program may be using the rest. */
  freeGb?: number;
  driver?: string;
}

export interface ServerHardware {
  platform: string;
  arch: string;
  cpuModel: string;
  cpus: number;
  ramGb: number;
  gpus: GpuInfo[];
}

/**
 * Parses `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits`.
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
    const gb = (m: number) => Math.round((m / 1024) * 10) / 10;
    const free = parts.length >= 4 ? Number(parts[2]) : NaN;
    const driver = parts.length >= 4 ? parts[3] : parts[2];
    gpus.push({ vendor: "nvidia", name: parts[0], memoryGb: gb(mib), ...(Number.isFinite(free) && free >= 0 && parts[2] !== "" ? { freeGb: gb(free) } : {}), ...(driver ? { driver } : {}) });
  }
  return gpus;
}

/** Goals that fit an input: satellite images only make terrain; ground captures make the rest. */
export const goalsFor = (input: CaptureInput): SplatGoal[] => (input === "satellite" ? ["satellite"] : ["scene", "surface", "area"]);

const bestGpu = (hw: ServerHardware): GpuInfo | undefined => [...hw.gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0];

/** Why a method cannot run on this hardware, or null when it can. */
export function cannotRun(m: SplatMethod, hw: ServerHardware): "needsNvidia" | "needsGpu" | "tooLittleMemory" | null {
  const nvidia = hw.gpus.filter((g) => g.vendor === "nvidia").sort((a, b) => b.memoryGb - a.memoryGb)[0];
  if (m.needs === "nvidia") {
    if (!nvidia) return "needsNvidia";
    return nvidia.memoryGb < m.minMemoryGb ? "tooLittleMemory" : null;
  }
  if (m.needs === "gpu") {
    const g = bestGpu(hw);
    if (!g) return "needsGpu";
    return g.memoryGb < m.minMemoryGb ? "tooLittleMemory" : null;
  }
  return hw.ramGb < 8 ? "tooLittleMemory" : null;
}

export interface PresetSettings {
  preset: SplatPreset;
  /** Training steps. */
  iterations: number;
  /** Most splats the training may grow to; bounded by memory so a run cannot exhaust it. */
  maxSplats: number;
  /** Longest image side used for training, in pixels. */
  resolution: number;
  shDegree: number;
  /** Frames taken from a video, per second of video. */
  videoFps: number;
  /** CPU threads the worker may use: all but one, so the server keeps answering. */
  threads: number;
}

/** Memory the training can use, in GB: the GPU's, or a quarter of RAM for a CPU run. */
function trainingMemoryGb(m: SplatMethod, hw: ServerHardware): number {
  if (m.needs === "cpu") return hw.ramGb / 4;
  const g = m.needs === "nvidia" ? hw.gpus.filter((x) => x.vendor === "nvidia").sort((a, b) => b.memoryGb - a.memoryGb)[0] : bestGpu(hw);
  // Another program holding GPU memory leaves less for training: plan for what is free.
  return g ? Math.min(g.memoryGb, g.freeGb ?? g.memoryGb) : 0;
}

/**
 * Settings for a preset, fitted to the hardware. About 250,000 splats per GB of training memory
 * leaves room for the optimiser state and images; fewer on a CPU, where time is the limit.
 */
export function presetSettings(m: SplatMethod, preset: SplatPreset, hw: ServerHardware): PresetSettings {
  const base = { fast: { iterations: 7000, cap: 1_000_000, resolution: 1280, shDegree: 1, videoFps: 2 }, balanced: { iterations: 15000, cap: 3_000_000, resolution: 1600, shDegree: 3, videoFps: 3 }, high: { iterations: 30000, cap: 6_000_000, resolution: 2400, shDegree: 3, videoFps: 4 } }[preset];
  const mem = trainingMemoryGb(m, hw);
  const perGb = m.needs === "cpu" ? 60_000 : 250_000;
  const byMemory = Math.max(100_000, Math.floor((mem * perGb) / 100_000) * 100_000);
  let resolution = base.resolution;
  if (m.needs !== "cpu" && mem < 8) resolution = Math.min(resolution, 1280);
  if (m.needs === "cpu") resolution = Math.min(resolution, 1024);
  return {
    preset,
    iterations: m.needs === "cpu" ? Math.min(base.iterations, preset === "high" ? 15000 : 7000) : base.iterations,
    maxSplats: Math.min(base.cap, byMemory),
    resolution,
    shDegree: base.shDegree,
    videoFps: base.videoFps,
    threads: Math.max(1, hw.cpus - 1),
  };
}

export interface Recommendation {
  /** The method to use, or null when nothing installed can run here. */
  method: string | null;
  preset: SplatPreset;
  /** Reason keys (splat.make.why.*), in order. */
  why: string[];
  /** Other methods that can run here for this goal, best first, for an A/B comparison. */
  alternatives: string[];
}

/**
 * The method for this input and goal on this hardware. Among the methods made for the goal, the
 * first that can run here and is installed wins; a method that can run but is not installed is
 * named in the reasons so the operator knows what to ask for. Balanced is the default preset;
 * a CPU-only server gets Fast, because Balanced would take days there.
 */
export function recommend(hw: ServerHardware, input: CaptureInput, goal: SplatGoal, installed: readonly string[]): Recommendation {
  const why: string[] = [];
  const fits = SPLAT_METHODS.filter((m) => m.inputs.includes(input) && m.goals.includes(goal));
  const runnable = fits.filter((m) => !cannotRun(m, hw));
  const ready = runnable.filter((m) => installed.includes(m.id));
  // Surfaces: a surface method first; else the best scene method, with a warning.
  let pick = ready[0];
  if (!pick && goal === "surface") {
    pick = SPLAT_METHODS.find((m) => m.inputs.includes(input) && m.goals.includes("scene") && !cannotRun(m, hw) && installed.includes(m.id));
    if (pick) why.push("surfaceFallback");
  }
  if (runnable[0] && runnable[0] !== pick && !installed.includes(runnable[0].id)) why.push("notInstalled");
  if (!pick) return { method: null, preset: "balanced", why: [...why, runnable.length ? "nothingInstalled" : "nothingRuns"], alternatives: [] };
  const gpu = bestGpu(hw);
  why.unshift(pick.needs === "nvidia" ? "nvidia" : pick.needs === "gpu" ? (gpu?.vendor === "apple" ? "apple" : "gpu") : "cpuOnly");
  if (pick.generative) why.push("generative");
  if (!pick.commercialUse) why.push("research");
  return { method: pick.id, preset: pick.needs === "cpu" ? "fast" : "balanced", why, alternatives: ready.filter((m) => m !== pick).map((m) => m.id) };
}
