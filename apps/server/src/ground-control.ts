import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { converter, converterForEpsg, type CrsConverter } from "@viewer/core/loaders";

/**
 * Surveyed ground control points for a capture (SRS GS-08), in the gcp_list.txt layout that
 * OpenDroneMap and WebODM's GCP tool write:
 *
 *   EPSG:2039                                   <- first line: the points' coordinate system
 *   219500.12 626900.55 812.40 2016 1512 IMG_0101.JPG gcp1
 *   geo_x     geo_y     geo_z   px_x px_y image        name (optional)
 *
 * One line per sighting of a point in a picture. The first line may be EPSG:<code> (any code the
 * viewer knows, ITM 2039 included), "WGS84 UTM 36N", or a proj4 string. For EPSG:4326 geo_x is the
 * longitude and geo_y the latitude. Heights are kept as surveyed and their datum is recorded as
 * "as surveyed". The server turns the file into ground-control.json (WGS 84 degrees) for the
 * worker; nothing in the capture is changed.
 */

export interface GroundControlPoint {
  name: string;
  lat: number;
  lon: number;
  height: number;
  observations: { image: string; x: number; y: number }[];
}

export interface GroundControl {
  crs: string;
  points: GroundControlPoint[];
}

/** File names that hold ground control in a capture (any folder, any case). */
export const GCP_FILE = /^(gcp_list|ground[-_]control)\.txt$/i;

function crsOf(header: string): CrsConverter | null {
  const h = header.trim();
  const epsg = /^EPSG:(\d{4,5})$/i.exec(h);
  if (epsg) return converterForEpsg(Number(epsg[1]));
  const utm = /^WGS\s?84\s+UTM\s+(\d{1,2})\s*([NS])$/i.exec(h);
  if (utm) {
    const zone = Number(utm[1]);
    if (zone < 1 || zone > 60) return null;
    return converter(`+proj=utm +zone=${zone}${utm[2]!.toUpperCase() === "S" ? " +south" : ""} +datum=WGS84 +units=m +no_defs`, `WGS 84 / UTM ${zone}${utm[2]!.toUpperCase()}`);
  }
  if (h.startsWith("+proj=")) return converter(h, h.slice(0, 120));
  return null;
}

/** Reads gcp_list.txt text. Throws an Error whose message says what to fix. */
export function parseGroundControl(text: string): GroundControl {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("The ground control file is empty.");
  let crs: CrsConverter | null;
  try {
    crs = crsOf(lines[0]!);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  if (!crs) throw new Error(`The first line of the ground control file must name its coordinate system, for example EPSG:2039 or WGS84 UTM 36N. It says "${lines[0]!.slice(0, 60)}".`);
  const byName = new Map<string, GroundControlPoint>();
  lines.slice(1).forEach((line, i) => {
    const f = line.split(/\s+/);
    const nums = f.slice(0, 5).map(Number);
    if (f.length < 6 || nums.some((v) => !Number.isFinite(v))) throw new Error(`Line ${i + 2} of the ground control file is not "x y z pixel_x pixel_y image [name]".`);
    const [gx, gy, gz, px, py] = nums as [number, number, number, number, number];
    const [lon, lat] = crs!.toLonLat(gx, gy);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || Math.abs(gz) > 10000) throw new Error(`Line ${i + 2} of the ground control file is not a place on Earth in ${crs!.label}.`);
    if (px < 0 || py < 0) throw new Error(`Line ${i + 2} of the ground control file has a negative pixel position.`);
    const image = path.basename(f[5]!);
    // Without a name, the same surveyed coordinates are the same point.
    const name = f[6] ?? `${gx.toFixed(3)} ${gy.toFixed(3)} ${gz.toFixed(3)}`;
    const p = byName.get(name);
    if (p) {
      if (Math.hypot(p.lat - lat, p.lon - lon) > 1e-7 || Math.abs(p.height - gz) > 0.001) throw new Error(`Ground control point ${name} has two different positions in the file.`);
      p.observations.push({ image, x: px, y: py });
    } else byName.set(name, { name, lat, lon, height: gz, observations: [{ image, x: px, y: py }] });
  });
  if (!byName.size) throw new Error("The ground control file names no points.");
  return { crs: crs.label, points: [...byName.values()] };
}

/**
 * Finds a ground control file among the capture's files (relative to `dir`), checks it, and writes
 * ground-control.json to `outFile`. Returns null when the capture has none.
 */
export async function prepareGroundControl(dir: string, files: string[], outFile: string): Promise<GroundControl | null> {
  const found = files.filter((f) => GCP_FILE.test(path.basename(f)));
  if (!found.length) return null;
  if (found.length > 1) throw new Error(`The capture has ${found.length} ground control files; send one.`);
  const file = path.join(dir, found[0]!);
  if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error("The ground control file is larger than 2 MB.");
  const gc = parseGroundControl(await readFile(file, "utf8"));
  await writeFile(outFile, JSON.stringify(gc));
  return gc;
}
