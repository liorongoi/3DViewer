import { fromBlob } from "geotiff";
import { converterForEpsg, type CrsConverter } from "../geo/crs";
import { ecefToGeodetic } from "../geo/wgs84";
import type { SplatCloud } from "./cloud";

/**
 * Splat heights against an independent elevation model (SRS GS-06, docs/GAUSSIAN_SPLATS.md).
 *
 * The splats are placed on the globe with the model's matrix, binned into the reference raster's
 * own cells, and each cell's splat height (the highest splat for a DSM, the lowest for a DTM, which
 * is bare earth) is compared with the reference. Cells with too few splats are left out, and so are
 * faint splats (floaters left by training). The result is a statement about this placement against
 * this reference, nothing more: splats are not a measured surface.
 */

const GEOGRAPHIC = new Set([4326, 4979, 4258, 4269]);

export interface ElevationRaster {
  width: number;
  height: number;
  /** Heights, row by row from the top. */
  data: ArrayLike<number>;
  /** Raster CRS coordinates of the top-left corner of the top-left cell. */
  originX: number;
  originY: number;
  /** Cell size in raster CRS units; resY is negative for north-up rasters. */
  resX: number;
  resY: number;
  noData: number | null;
  crs: CrsConverter;
  epsg: number;
}

export interface ElevationComparison {
  kind: "DSM" | "DTM";
  /** Metres added to every reference height before comparing (geoid height for a sea-level reference). */
  referenceOffset: number;
  splatsUsed: number;
  /** Cells with enough splats and a valid reference height. */
  cells: number;
  /** Model minus reference, in metres. */
  meanDifference: number;
  rms: number;
  /** RMS after removing the mean difference: the shape error, apart from a vertical shift. */
  rmsAfterShift: number;
  maxAbs: number;
  p95Abs: number;
  minSplatsPerCell: number;
  cellSize: number;
  epsg: number;
}

/** Reads one band of a GeoTIFF elevation file, only the window around a lon/lat box (with a margin). */
export async function readElevationRaster(file: Blob, box: { west: number; south: number; east: number; north: number }, maxCells = 25_000_000): Promise<ElevationRaster> {
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const keys = image.getGeoKeys() as Record<string, number> | null;
  const epsg = keys?.ProjectedCSTypeGeoKey ?? keys?.GeographicTypeGeoKey;
  if (!epsg || epsg === 32767) throw new Error("The elevation file does not say its coordinate system with an EPSG code.");
  const crs = converterForEpsg(epsg);
  const [ox, oy] = image.getOrigin() as [number, number];
  const [rx, ry] = image.getResolution() as [number, number];
  // The box's corners and edge midpoints in the raster's CRS, to its pixel window.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const lon of [box.west, (box.west + box.east) / 2, box.east])
    for (const lat of [box.south, (box.south + box.north) / 2, box.north]) {
      const [x, y] = crs.fromLonLat(lon, lat);
      xs.push((x - ox) / rx);
      ys.push((y - oy) / ry);
    }
  const W = image.getWidth();
  const H = image.getHeight();
  const c0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const r0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const c1 = Math.min(W, Math.ceil(Math.max(...xs)) + 2);
  const r1 = Math.min(H, Math.ceil(Math.max(...ys)) + 2);
  if (c1 <= c0 || r1 <= r0) throw new Error("The elevation file does not cover the model.");
  if ((c1 - c0) * (r1 - r0) > maxCells) throw new Error("The elevation file's cells are too small for an area this size. Use a coarser file, or cut it to the model's area.");
  const [band] = (await image.readRasters({ window: [c0, r0, c1, r1], samples: [0] })) as unknown as ArrayLike<number>[];
  const nd = image.getGDALNoData();
  return { width: c1 - c0, height: r1 - r0, data: band!, originX: ox + c0 * rx, originY: oy + r0 * ry, resX: rx, resY: ry, noData: nd ?? null, crs, epsg };
}

/** Each splat's Earth position: glTF frame (y up) to the tileset frame (z up), then the model matrix (column-major). */
export function splatPositions(cloud: Pick<SplatCloud, "count" | "pos">, modelMatrix: readonly number[]): Float64Array {
  const m = modelMatrix;
  const out = new Float64Array(cloud.count * 3);
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.pos[i * 3]!;
    const y = -cloud.pos[i * 3 + 2]!;
    const z = cloud.pos[i * 3 + 1]!;
    out[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return out;
}

/** The lon/lat box the splats cover (faint splats left out). */
export function splatBox(cloud: Pick<SplatCloud, "count" | "pos" | "alphas">, modelMatrix: readonly number[], minAlpha = 128) {
  const ecef = splatPositions(cloud, modelMatrix);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < cloud.count; i++) {
    if (cloud.alphas[i]! < minAlpha) continue;
    const g = ecefToGeodetic({ x: ecef[i * 3]!, y: ecef[i * 3 + 1]!, z: ecef[i * 3 + 2]! });
    west = Math.min(west, g.lon);
    east = Math.max(east, g.lon);
    south = Math.min(south, g.lat);
    north = Math.max(north, g.lat);
  }
  if (!Number.isFinite(west)) throw new Error("The model has no solid splats to compare.");
  return { west, south, east, north };
}

export function compareElevation(
  cloud: Pick<SplatCloud, "count" | "pos" | "alphas">,
  modelMatrix: readonly number[],
  ref: ElevationRaster,
  opts: { kind: "DSM" | "DTM"; referenceOffset?: number; minSplatsPerCell?: number; minAlpha?: number },
): ElevationComparison {
  const minN = opts.minSplatsPerCell ?? 3;
  const minAlpha = opts.minAlpha ?? 128;
  const offset = opts.referenceOffset ?? 0;
  const ecef = splatPositions(cloud, modelMatrix);
  const n = ref.width * ref.height;
  const count = new Uint32Array(n);
  const height = new Float64Array(n).fill(opts.kind === "DSM" ? -Infinity : Infinity);
  let used = 0;
  for (let i = 0; i < cloud.count; i++) {
    if (cloud.alphas[i]! < minAlpha) continue;
    const g = ecefToGeodetic({ x: ecef[i * 3]!, y: ecef[i * 3 + 1]!, z: ecef[i * 3 + 2]! });
    const [x, y] = ref.crs.fromLonLat(g.lon, g.lat);
    const c = Math.floor((x - ref.originX) / ref.resX);
    const r = Math.floor((y - ref.originY) / ref.resY);
    if (c < 0 || r < 0 || c >= ref.width || r >= ref.height) continue;
    const k = r * ref.width + c;
    count[k]!++;
    height[k] = opts.kind === "DSM" ? Math.max(height[k]!, g.height) : Math.min(height[k]!, g.height);
    used++;
  }
  const diffs: number[] = [];
  for (let k = 0; k < n; k++) {
    if (count[k]! < minN) continue;
    const v = Number(ref.data[k]);
    if (!Number.isFinite(v) || (ref.noData !== null && v === ref.noData)) continue;
    diffs.push(height[k]! - (v + offset));
  }
  if (!diffs.length) throw new Error("No cell of the elevation file has enough splats in it to compare. Check that the model is placed where the file is.");
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const rms = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length);
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    kind: opts.kind,
    referenceOffset: offset,
    splatsUsed: used,
    cells: diffs.length,
    meanDifference: r3(mean),
    rms: r3(rms),
    rmsAfterShift: r3(sd),
    maxAbs: r3(abs[abs.length - 1]!),
    p95Abs: r3(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))]!),
    minSplatsPerCell: minN,
    // Metres on the ground; a geographic raster's cells are in degrees of latitude.
    cellSize: Math.round(Math.abs(ref.resY) * (GEOGRAPHIC.has(ref.epsg) ? 111_320 : 1) * 100) / 100,
    epsg: ref.epsg,
  };
}
