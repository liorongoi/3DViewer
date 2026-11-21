/**
 * "Check this computer": can this PC show HOLO's models well? Read in the page (WebGL, the
 * browser's own hints) and, in the Windows app, from the operating system. Nothing is sent
 * anywhere; the result is shown to the user only.
 */

export interface ComputerFacts {
  /** The graphics renderer WebGL reports, such as "ANGLE (NVIDIA, NVIDIA RTX A4000 Direct3D11 ...)". */
  renderer: string | null;
  webgl2: boolean;
  maxTextureSize: number | null;
  /** Memory in GB: exact in the Windows app; in a browser, its rounded hint (at most 8). */
  ramGb: number | null;
  ramIsHint: boolean;
  cores: number | null;
  cpuModel?: string | null;
  /** Free disk where the app keeps its files, in GB (Windows app only). */
  freeDiskGb?: number | null;
  os?: string | null;
}

export type CheckLevel = "ok" | "limit" | "no";
export interface CheckRow {
  key: "graphics" | "memory" | "processor" | "disk";
  level: CheckLevel;
  /** What was found, for display. */
  value: string;
  /** i18n key under help.computer.notes for what it means, when it is not ok. */
  note?: "software" | "noWebgl2" | "integrated" | "smallTextures" | "lowMemory" | "tooLittleMemory" | "fewCores" | "lowDisk";
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|microsoft basic render|software rasterizer|mesa offscreen/i;
const DISCRETE = /nvidia|geforce|quadro|rtx|radeon\s*(rx|pro)|radeon\s+\d{3,4}|arc\s*a\d{3}|apple\s*m\d/i;
const INTEGRATED = /intel|uhd|iris|radeon\(tm\)\s*graphics|vega\s*\d+\s*graphics|adreno|mali/i;

/** The renderer name without ANGLE's wrapping, such as "NVIDIA RTX A4000". */
export function gpuName(renderer: string): string {
  let name = renderer;
  const angle = /^ANGLE \((.*)\)$/.exec(renderer.trim());
  if (angle) {
    const parts = (angle[1] ?? "").split(", ");
    name = parts[1] ?? parts[0] ?? renderer;
  }
  return name.split(/\s+\(0x[0-9a-f]+\)|\s+(?:Direct3D|D3D1|OpenGL|Vulkan|Metal|vs_\d)/i)[0]!.replace(/\s+/g, " ").trim();
}

export function checkComputer(f: ComputerFacts): { rows: CheckRow[]; level: CheckLevel } {
  const rows: CheckRow[] = [];
  if (!f.renderer && !f.webgl2) rows.push({ key: "graphics", level: "no", value: "—", note: "noWebgl2" });
  else {
    const name = f.renderer ? gpuName(f.renderer) : "WebGL 2";
    if (!f.webgl2) rows.push({ key: "graphics", level: "no", value: name, note: "noWebgl2" });
    else if (f.renderer && SOFTWARE.test(f.renderer)) rows.push({ key: "graphics", level: "no", value: `Software (${SOFTWARE.exec(f.renderer)?.[0] ?? "no driver"})`, note: "software" });
    else if (f.maxTextureSize !== null && f.maxTextureSize < 8192) rows.push({ key: "graphics", level: "limit", value: name, note: "smallTextures" });
    else if (f.renderer && !DISCRETE.test(f.renderer) && INTEGRATED.test(f.renderer)) rows.push({ key: "graphics", level: "limit", value: name, note: "integrated" });
    else rows.push({ key: "graphics", level: "ok", value: name });
  }
  if (f.ramGb !== null) {
    const v = `${f.ramIsHint && f.ramGb >= 8 ? "8+" : f.ramGb} GB`;
    if (f.ramGb < 4) rows.push({ key: "memory", level: "no", value: v, note: "tooLittleMemory" });
    else if (f.ramGb < 8 || (!f.ramIsHint && f.ramGb < 12)) rows.push({ key: "memory", level: "limit", value: v, note: "lowMemory" });
    else rows.push({ key: "memory", level: "ok", value: v });
  }
  if (f.cores !== null) {
    const v = `${f.cpuModel ? `${f.cpuModel.replace(/\s+/g, " ").trim()}, ` : ""}${f.cores}`;
    rows.push(f.cores < 4 ? { key: "processor", level: "limit", value: v, note: "fewCores" } : { key: "processor", level: "ok", value: v });
  }
  if (f.freeDiskGb !== undefined && f.freeDiskGb !== null) {
    const v = `${Math.floor(f.freeDiskGb)} GB`;
    rows.push(f.freeDiskGb < 5 ? { key: "disk", level: "limit", value: v, note: "lowDisk" } : { key: "disk", level: "ok", value: v });
  }
  const level: CheckLevel = rows.some((r) => r.level === "no") ? "no" : rows.some((r) => r.level === "limit") ? "limit" : "ok";
  return { rows, level };
}
