import { SplatError, type SplatCloud } from "./cloud";
import { decodePly } from "./ply";
import { decodeSpz } from "./spz";
import { splatTiles, type SplatTiles, type SplatTilesOptions } from "./tiles";

export * from "./cloud";
export { decodeSpz, encodeSpzV2, packRotationV3, sniffSpz, MAX_SPLATS, SPZ_MAGIC } from "./spz";
export { decodePly, readPlyHeader, plyInfo } from "./ply";
export { glbTilesetZip, glbToGltf, scaledCloud, splatToSpz, tilesetZip, zipFiles, type PlacementSidecar } from "./export";
export { compareElevation, readElevationRaster, splatBox, splatPositions, type ElevationComparison, type ElevationRaster } from "./elevation";
export { splatGlb, splatTiles, GS_EXTENSIONS, type SplatTiles, type SplatTilesOptions } from "./tiles";

export type SplatFormat = "spz" | "ply";

/** Where a splat model came from, recorded with the model (SRS GS-14). */
export interface SplatSourceInfo {
  format: SplatFormat;
  /** SPZ version of the upload (2 or 3); absent for PLY. */
  version?: number;
  count: number;
  shDegree: number;
  /** How the drawn tiles were made from the upload. */
  conversion: "unchanged" | "spz3-to-spz2" | "ply-to-spz2" | "retiled";
  /** Version 3 rotations are drawn with version 2's 8-bit precision. */
  reducedRotationPrecision?: boolean;
  /** PLY properties beyond the splat ones; they stay in the original only. */
  extraProperties?: string[];
}

export const splatFormatOf = (path: string): SplatFormat | null => (/\.spz$/i.test(path) ? "spz" : /\.ply$/i.test(path) ? "ply" : null);

/** Reads an SPZ or Gaussian splat PLY. Throws SplatError with a reason a person can act on. */
export function readSplatFile(path: string, data: Uint8Array): { cloud: SplatCloud; info: Omit<SplatSourceInfo, "conversion">; spzV2?: Uint8Array } {
  const format = splatFormatOf(path);
  if (format === "spz") {
    const { header, cloud } = decodeSpz(data);
    return {
      cloud,
      info: { format, version: header.version, count: cloud.count, shDegree: cloud.shDegree, ...(header.version === 3 ? { reducedRotationPrecision: true } : {}) },
      spzV2: header.version === 2 ? data : undefined,
    };
  }
  if (format === "ply") {
    const { cloud, info } = decodePly(data);
    return { cloud, info: { format, count: cloud.count, shDegree: cloud.shDegree, ...(info.extra.length ? { extraProperties: info.extra.slice(0, 20) } : {}) } };
  }
  throw new SplatError(`${path} is not an SPZ or PLY file.`);
}

/** An SPZ or PLY file as 3D Tiles, and what was done to it. */
export function splatFileToTiles(path: string, data: Uint8Array, opts: SplatTilesOptions = {}): SplatTiles & { info: SplatSourceInfo } {
  const r = readSplatFile(path, data);
  const t = splatTiles(r.cloud, { ...opts, originalSpzV2: r.spzV2 });
  const conversion: SplatSourceInfo["conversion"] = t.tiles > 1 ? "retiled" : r.spzV2 ? "unchanged" : r.info.format === "spz" ? "spz3-to-spz2" : "ply-to-spz2";
  return { ...t, info: { ...r.info, conversion } };
}
