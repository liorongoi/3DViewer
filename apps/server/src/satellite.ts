import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Checks a satellite capture before any training starts (SRS GS-09, GS-10).
 *
 * A satellite worker needs a camera model (RPC) for every view and views from different
 * directions: two pictures taken from almost the same direction give no height. This reads only
 * small text sidecars and TIFF tag tables, never the pixels, and answers in plain words what is
 * missing, so an unusable capture fails in seconds instead of after hours of training.
 */

export interface SatelliteView {
  file: string;
  rpc: "sidecar" | "embedded" | null;
  /** Satellite azimuth and elevation of the view, in degrees, from its metadata (IMD or XML). */
  azimuth?: number;
  elevation?: number;
}

export interface SatellitePreflight {
  views: SatelliteView[];
  /** The widest angle between two views' directions, in degrees, or null when no view says where it looked from. */
  convergenceDeg: number | null;
  /** Why the capture cannot be used, or null. */
  problem: string | null;
  /** Things to say about a usable capture, as check keys: satVideoIgnored, satNoAngles. */
  warnings: ("satVideoIgnored" | "satNoAngles")[];
}

const IMAGE = /\.(tiff?|ntf|nitf|jp2)$/i;
const VIDEO = /\.(mp4|mov|m4v|ts|mts|avi|mkv|webm)$/i;
/** Two views must look at the ground from directions at least this far apart for heights. */
export const MIN_CONVERGENCE_DEG = 5;

const stem = (f: string) => f.replace(/\.[^./]+$/, "");

/** Whether a classic or Big TIFF carries the RPC coefficients tag (50844) in its first directory. */
export async function tiffHasRpc(file: string): Promise<boolean> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) return false;
  try {
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    const le = head.toString("latin1", 0, 2) === "II";
    if (!le && head.toString("latin1", 0, 2) !== "MM") return false;
    const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const magic = u16(head, 2);
    if (magic === 42) {
      const ifd = le ? head.readUInt32LE(4) : head.readUInt32BE(4);
      const nb = Buffer.alloc(2);
      await fh.read(nb, 0, 2, ifd);
      const n = Math.min(u16(nb, 0), 1000);
      const table = Buffer.alloc(n * 12);
      await fh.read(table, 0, table.length, ifd + 2);
      for (let k = 0; k < n; k++) if (u16(table, k * 12) === 50844) return true;
    } else if (magic === 43) {
      const ifd = Number(le ? head.readBigUInt64LE(8) : head.readBigUInt64BE(8));
      const nb = Buffer.alloc(8);
      await fh.read(nb, 0, 8, ifd);
      const n = Math.min(Number(le ? nb.readBigUInt64LE(0) : nb.readBigUInt64BE(0)), 1000);
      const table = Buffer.alloc(n * 20);
      await fh.read(table, 0, table.length, ifd + 8);
      for (let k = 0; k < n; k++) if (u16(table, k * 20) === 50844) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** Satellite azimuth and elevation from Maxar .IMD or .XML, or Airbus DIMAP metadata text. */
export function viewAngles(text: string): { azimuth: number; elevation: number } | null {
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : NaN;
  };
  let az = num(/meanSatAz\s*=\s*(-?[\d.]+)/i);
  let el = num(/meanSatEl\s*=\s*(-?[\d.]+)/i);
  if (!Number.isFinite(az)) az = num(/<MEANSATAZ>\s*(-?[\d.]+)/i);
  if (!Number.isFinite(el)) el = num(/<MEANSATEL>\s*(-?[\d.]+)/i);
  // DIMAP gives the satellite's azimuth and its incidence (angle from the vertical).
  if (!Number.isFinite(az)) az = num(/<AZIMUTH_ANGLE[^>]*>\s*(-?[\d.]+)/i);
  if (!Number.isFinite(el)) {
    const inc = num(/<INCIDENCE_ANGLE[^>]*>\s*(-?[\d.]+)/i);
    if (Number.isFinite(inc)) el = 90 - inc;
  }
  return Number.isFinite(az) && Number.isFinite(el) && el > 0 && el <= 90 ? { azimuth: az, elevation: el } : null;
}

/** The angle between two views' directions, in degrees. */
export function convergence(a: { azimuth: number; elevation: number }, b: { azimuth: number; elevation: number }): number {
  const v = (x: { azimuth: number; elevation: number }) => {
    const az = (x.azimuth * Math.PI) / 180;
    const el = (x.elevation * Math.PI) / 180;
    return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
  };
  const p = v(a);
  const q = v(b);
  const d = Math.min(1, Math.max(-1, p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!));
  return (Math.acos(d) * 180) / Math.PI;
}

async function smallText(file: string): Promise<string | null> {
  const s = await stat(file).catch(() => null);
  return s && s.size <= 4 * 1024 * 1024 ? readFile(file, "latin1") : null;
}

/** Checks the files of a satellite capture (paths relative to `dir`). */
export async function satellitePreflight(dir: string, files: string[]): Promise<SatellitePreflight> {
  const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const images = files.filter((f) => IMAGE.test(f));
  const videos = files.filter((f) => VIDEO.test(f));
  const views: SatelliteView[] = [];
  for (const f of images) {
    const s = stem(f).toLowerCase();
    const sidecar = [`${s}.rpb`, `${s}_rpc.txt`, `${s}.rpc`, `${s}_rpc.rpb`].some((x) => byLower.has(x));
    const rpc = sidecar ? "sidecar" : /\.tiff?$/i.test(f) && (await tiffHasRpc(path.join(dir, f))) ? "embedded" : null;
    const metaName = [`${s}.imd`, `${s}.xml`, `dim_${path.basename(s)}.xml`].map((x) => byLower.get(x)).find(Boolean);
    const meta = metaName ? await smallText(path.join(dir, metaName)) : null;
    const angles = meta ? viewAngles(meta) : null;
    views.push({ file: f, rpc, ...(angles ?? {}) });
  }
  const warnings: SatellitePreflight["warnings"] = [];
  const done = (problem: string | null, convergenceDeg: number | null = null): SatellitePreflight => ({ views, convergenceDeg, problem, warnings });

  if (videos.length && !images.length)
    return done(
      "A satellite video needs a camera model for every frame it uses. Send the frames as images, each with its RPC file (for example frame TIFFs with _RPC.TXT, as SkySat video delivers them), not only the video.",
    );
  if (videos.length) warnings.push("satVideoIgnored");
  const calibrated = views.filter((v) => v.rpc);
  const missing = views.filter((v) => !v.rpc);
  if (missing.length)
    return done(
      `${missing.length === 1 ? "This image has" : `${missing.length} images have`} no RPC camera model: ${missing
        .slice(0, 3)
        .map((v) => path.basename(v.file))
        .join(", ")}. Add each one's .RPB or _RPC.TXT file with the same name, or use images with the RPC inside.`,
    );
  if (calibrated.length < 2) return done("At least two satellite views of the same area are needed, each with its RPC file. One view gives no heights.");

  const angled = calibrated.filter((v) => v.azimuth !== undefined && v.elevation !== undefined) as Required<SatelliteView>[];
  let widest: number | null = null;
  for (let i = 0; i < angled.length; i++) for (let j = i + 1; j < angled.length; j++) widest = Math.max(widest ?? 0, convergence(angled[i]!, angled[j]!));
  if (widest !== null && angled.length >= 2 && widest < MIN_CONVERGENCE_DEG)
    return done(
      `The views look at the ground from almost the same direction (at most ${widest.toFixed(1)}° apart), so heights cannot be measured. Add views at least ${MIN_CONVERGENCE_DEG}° apart, for example from another pass.`,
      widest,
    );
  if (angled.length < 2) warnings.push("satNoAngles");
  return done(null, widest);
}
