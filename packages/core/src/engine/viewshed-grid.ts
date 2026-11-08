import proj4 from "proj4";
import { utmZoneFor } from "../geo/utm";

/**
 * The viewshed on a grid, on the CPU (VWR-ANL-03, plan WP 2.9): what the GPU overlay shows,
 * as numbers, for the visible area and the GeoTIFF export.
 *
 * The grid is square, in the UTM zone of the observer, with the observer in the middle cell, so
 * the export is a plain projected raster. A cell is seen when nothing between the eye and the
 * cell's ground rises above the straight line to it, with earth curvature and refraction; the
 * ground is sampled every half cell, bilinear between cell centres, along rays from the eye.
 * It works on the ground only (the DEM or terrain), as gdal_viewshed does; the GPU overlay also
 * takes buildings and models into account.
 */

const R_EARTH = 6371000;

export interface HeightGrid {
  /** Cells per side, odd: the observer is in the middle cell. */
  size: number;
  /** Cell size, metres. */
  cell: number;
  /** Ground heights, row by row from the north-west corner. NaN where unknown. */
  heights: Float64Array;
}

export interface ViewshedGridResult {
  size: number;
  cell: number;
  /** Per cell, row by row from the north-west corner: 1 seen, 0 hidden, 255 outside the radius or unknown. */
  visible: Uint8Array;
  visibleCells: number;
  /** Cells within the radius with a known height. */
  cells: number;
  /** Square metres. */
  visibleArea: number;
  area: number;
}

export interface ViewshedGridOptions {
  /** Height of the target above its ground, metres (0: the ground itself is seen). */
  targetHeight?: number;
  /** Refraction coefficient; 0 for earth curvature alone. */
  k?: number;
}

/** Viewshed from an eye at an absolute height over the middle cell, within a radius in metres. */
export function computeViewshedGrid(g: HeightGrid, eyeHeight: number, radius: number, o: ViewshedGridOptions = {}): ViewshedGridResult {
  const { size, cell, heights } = g;
  const m = (size - 1) / 2;
  const tz = o.targetHeight ?? 0;
  const curve = (1 - (o.k ?? 0.13)) / (2 * R_EARTH);
  const out = new Uint8Array(size * size).fill(255);
  // How close the ray that decided each cell passed to its centre: the closest ray wins.
  const near = new Float32Array(size * size).fill(Infinity);
  const at = (fx: number, fy: number): number => {
    const ix = Math.min(size - 2, Math.max(0, Math.floor(fx)));
    const iy = Math.min(size - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - ix));
    const ty = Math.min(1, Math.max(0, fy - iy));
    const r0 = iy * size + ix;
    const r1 = r0 + size;
    return (heights[r0]! * (1 - tx) + heights[r0 + 1]! * tx) * (1 - ty) + (heights[r1]! * (1 - tx) + heights[r1 + 1]! * tx) * ty;
  };
  const rm = radius / cell; // the radius in cells
  const step = 0.5;
  const ray = (ex: number, ey: number) => {
    const len = Math.hypot(ex, ey);
    const ux = ex / len;
    const uy = ey / len;
    let horizon = -Infinity;
    for (let r = step; r <= Math.min(len, rm + 1); r += step) {
      const fx = m + ux * r;
      const fy = m + uy * r;
      const h = at(fx, fy);
      if (!Number.isFinite(h)) continue;
      const d = r * cell;
      const below = curve * d * d + eyeHeight; // the earth's drop plus the eye, to subtract
      const ground = (h - below) / d;
      const ci = Math.round(fx);
      const cj = Math.round(fy);
      const k = cj * size + ci;
      const off = Math.hypot(fx - ci, fy - cj);
      if (off < near[k]! && Math.hypot(ci - m, cj - m) <= rm && Number.isFinite(heights[k]!)) {
        near[k] = off;
        out[k] = (h + tz - below) / d >= horizon ? 1 : 0;
      }
      if (ground > horizon) horizon = ground;
    }
  };
  // One ray to every cell on the edge of the square (the R2 method): every cell within the
  // radius is passed within half a cell by one of them, and each ray carries its horizon
  // outwards, so the whole grid costs about as much as R3 would spend on one row.
  for (let i = 0; i < size - 1; i++) {
    ray(i - m, -m);
    ray(m, i - m);
    ray(m - i, m);
    ray(-m, m - i);
  }
  out[m * size + m] = Number.isFinite(heights[m * size + m]!) ? 1 : 255;
  let seen = 0;
  let cells = 0;
  for (let k = 0; k < out.length; k++) {
    if (out[k] === 255) continue;
    cells++;
    seen += out[k]!;
  }
  return { size, cell, visible: out, visibleCells: seen, cells, visibleArea: seen * cell * cell, area: cells * cell * cell };
}

/** The UTM grid around an observer: where each cell centre is, to sample the ground there. */
export function viewshedGridFrame(lon: number, lat: number, radius: number, cell: number) {
  const zone = utmZoneFor(lat, lon);
  const south = lat < 0;
  const epsg = (south ? 32700 : 32600) + zone;
  const conv = proj4("EPSG:4326", `+proj=utm +zone=${zone} ${south ? "+south " : ""}+datum=WGS84 +units=m +no_defs`);
  const [e0, n0] = conv.forward([lon, lat]) as [number, number];
  const m = Math.ceil(radius / cell);
  const size = 2 * m + 1;
  /** Lon/lat (degrees) of every cell centre, row by row from the north-west corner. */
  const centres = (): { lon: number; lat: number }[] => {
    const pts: { lon: number; lat: number }[] = [];
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const [x, y] = conv.inverse([e0 + (i - m) * cell, n0 - (j - m) * cell]) as [number, number];
        pts.push({ lon: x, lat: y });
      }
    return pts;
  };
  return { epsg, zone, south, size, cell, easting: e0, northing: n0, centres };
}

/** A cell size that keeps the grid near 400 cells across: 1, 2, 2.5 or 5 times a power of ten. */
export function viewshedCellFor(radius: number): number {
  const raw = Math.max(0.5, (2 * radius) / 400);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 5, 10]) if (raw <= f * p) return f * p;
  return 10 * p;
}

/**
 * The result as a GeoTIFF in the grid's UTM zone: one byte per cell, 1 seen, 0 hidden,
 * 255 (no data) outside the radius. Opens in QGIS and ArcGIS as it is.
 */
export async function viewshedToGeoTiff(r: ViewshedGridResult, frame: { epsg: number; easting: number; northing: number }): Promise<ArrayBuffer> {
  const { writeArrayBuffer } = await import("geotiff");
  const m = (r.size - 1) / 2;
  // The north-west corner of the north-west cell.
  const west = frame.easting - (m + 0.5) * r.cell;
  const north = frame.northing + (m + 0.5) * r.cell;
  return writeArrayBuffer(r.visible, {
    width: r.size,
    height: r.size,
    ModelPixelScale: [r.cell, r.cell, 0],
    ModelTiepoint: [0, 0, 0, west, north, 0],
    ProjectedCSTypeGeoKey: frame.epsg,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    GDAL_NODATA: "255\u0000",
  }) as ArrayBuffer;
}
