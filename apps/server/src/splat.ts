import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { splatFileToTiles, type SplatSourceInfo } from "@viewer/core/splat";
import { PermanentError } from "./permanent.ts";

/**
 * Gaussian splat uploads (SPZ, splat PLY) as 3D Tiles for the library (docs/GAUSSIAN_SPLATS.md).
 * Runs on a worker thread or in the conversion sandbox, like tiling: reading a large PLY takes
 * the CPU for seconds. The upload itself is only read; what is drawn is written beside it.
 */
export interface SplatResult {
  files: string[];
  tiles: number;
  levels: number;
  info: SplatSourceInfo;
  /** Bounds without floaters, glTF frame (y up), in file units. */
  focus: { min: number[]; max: number[] };
}

export async function splatToTiles(file: string, outDir: string): Promise<SplatResult> {
  const data = new Uint8Array(await readFile(file));
  let t: ReturnType<typeof splatFileToTiles>;
  try {
    t = splatFileToTiles(file, data);
  } catch (e) {
    // The reader's reasons are for people (a damaged or unsupported file): the job stops, it is not retried.
    throw new PermanentError(e instanceof Error ? e.message : String(e));
  }
  await mkdir(outDir, { recursive: true });
  for (const f of t.files) {
    const dest = path.join(outDir, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.data);
  }
  return { files: t.files.map((f) => f.path), tiles: t.tiles, levels: t.levels, info: t.info, focus: t.focus };
}
