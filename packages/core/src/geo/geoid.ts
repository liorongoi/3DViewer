import { EGM96_GRID_1DEG } from "./egm96-grid";

let grid: Int16Array | null = null;

function load(): Int16Array {
  if (grid) return grid;
  const bin = atob(EGM96_GRID_1DEG);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  grid = new Int16Array(bytes.length / 2);
  for (let i = 0; i < grid.length; i++) grid[i] = view.getInt16(i * 2, true);
  return grid;
}

/**
 * Height of the EGM96 geoid (mean sea level) above the WGS84 ellipsoid, in metres, at a point
 * in degrees. About +50 m in France, +20 m in Israel. Bilinear on a 1° grid: within 2 m of
 * the full model almost everywhere.
 */
export function geoidHeight(latDeg: number, lonDeg: number): number {
  const g = load();
  const y = Math.min(Math.max(90 - latDeg, 0), 180);
  const x = ((lonDeg % 360) + 360) % 360;
  const r = Math.min(Math.floor(y), 179);
  const c = Math.floor(x) % 360;
  const fy = y - r;
  const fx = x - Math.floor(x);
  const at = (rr: number, cc: number) => g[rr * 360 + (cc % 360)]! / 100;
  const top = at(r, c) + (at(r, c + 1) - at(r, c)) * fx;
  const bottom = at(r + 1, c) + (at(r + 1, c + 1) - at(r + 1, c)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * The shift that puts a georeferenced city on the terrain, from the measured gap (dataset
 * surface minus terrain at the chosen low quantile, metres) and the geoid height there.
 *
 * Terrain models (SRTM, Terrain Tiles) give heights above sea level, while 3D Tiles are drawn
 * in Earth-centred coordinates, so the two differ by the geoid height when the dataset is
 * ellipsoidal (most photomeshes), and not at all when it was already in sea-level heights.
 * The measured gap is a noisy estimate of that: a 30 m terrain model rounds off hills and
 * river banks, so on Fourvière it came out 12 m short and left the quays floating. When the
 * gap is close to one of the known datum differences, that exact difference is used;
 * otherwise the dataset is on some other datum and the measured gap is the best we have.
 */
export function datumShift(measuredGap: number, geoid: number): number {
  const shift = -measuredGap;
  // Half the geoid height keeps the choices apart where it is small (Israel, about 20 m).
  const tolerance = Math.max(3, Math.min(15, Math.abs(geoid) / 2));
  let best = shift;
  let bestDist = tolerance;
  for (const k of [-geoid, 0, geoid]) {
    const d = Math.abs(shift - k);
    if (d <= bestDist) [best, bestDist] = [k, d];
  }
  return best;
}
