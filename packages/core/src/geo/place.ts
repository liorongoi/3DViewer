import geodesic from "geographiclib-geodesic";
import type { ModelSummary } from "@viewer/shared";
import { converterForEpsg } from "./crs";
import { geodeticToEcef, WGS84_A, WGS84_E2 } from "./wgs84";

/**
 * Where a model stands on the Earth (plan 4.1, WP 1.3), in double precision and independent of
 * the renderer, so the server, the tests and the viewer use the same numbers.
 *
 * The model frame is the survey convention: x east, y north, z up, once the file's up axis is
 * applied (a Y-up glTF has east +X, north −Z and up +Y, as Blender and most tools write it).
 */
export type Placement = NonNullable<ModelSummary["placement"]>;

const WGS84 = geodesic.Geodesic.WGS84;
const DEG = Math.PI / 180;

/**
 * Model frame to ECEF as a column-major 4×4: the local east-north-up frame at the placement,
 * turned clockwise (seen from above) by the heading.
 */
export function placementFrame(p: { lat: number; lon: number; headingDeg?: number }, height: number): number[] {
  const o = geodeticToEcef({ lat: p.lat, lon: p.lon, height });
  const phi = p.lat * DEG;
  const lam = p.lon * DEG;
  const e = [-Math.sin(lam), Math.cos(lam), 0];
  const n = [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)];
  const u = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
  const h = (p.headingDeg ?? 0) * DEG;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const x = [0, 1, 2].map((i) => e[i]! * c - n[i]! * s);
  const y = [0, 1, 2].map((i) => e[i]! * s + n[i]! * c);
  return [...x, 0, ...y, 0, ...u, 0, o.x, o.y, o.z, 1];
}

/** Applies a column-major 4×4 to a point. */
export function transformPoint(m: readonly number[], [x, y, z]: readonly [number, number, number]): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** How a projected grid sits on the Earth at a point. */
export interface GridFactors {
  lat: number;
  lon: number;
  /** Direction of grid north, in degrees clockwise from true north. */
  northDeg: number;
  /** Metres on the ground per grid metre (1 / the point scale factor). */
  groundPerGrid: number;
}

/** Measured from the CRS itself, so it holds for any projection proj4 knows. */
export function gridFactors(epsg: number, x: number, y: number): GridFactors {
  const c = converterForEpsg(epsg);
  const [lon, lat] = c.toLonLat(x, y);
  if (epsg === 4326 || epsg === 4979) return { lat, lon, northDeg: 0, groundPerGrid: 1 };
  const d = 5;
  const [lonS, latS] = c.toLonLat(x, y - d);
  const [lonN, latN] = c.toLonLat(x, y + d);
  const [lonW, latW] = c.toLonLat(x - d, y);
  const [lonE, latE] = c.toLonLat(x + d, y);
  const ns = WGS84.Inverse(latS, lonS, latN, lonN);
  const we = WGS84.Inverse(latW, lonW, latE, lonE);
  // A conformal grid has one scale in every direction; the mean also covers one that is not quite.
  return { lat, lon, northDeg: ns.azi1!, groundPerGrid: (ns.s12! + we.s12!) / (4 * d) };
}

/** A position typed in, or read from a sidecar file, in a known coordinate system. */
export interface GridPosition {
  epsg: number;
  /** Easting or longitude. */
  x: number;
  /** Northing or latitude. */
  y: number;
  height: number;
  /** Turn of the model, clockwise from grid north (true north for latitude / longitude). */
  headingDeg?: number;
  /** Metres per file unit, and any extra scale. */
  scale?: number;
  aboveGround?: number;
  upAxis?: "y" | "z";
}

/**
 * Placement for a model whose axes follow a projected grid (ITM, UTM…). Grid north is not true
 * north away from the central meridian (up to about 1.3° in ITM, 2° at the edge of a UTM zone),
 * and a grid metre is not a ground metre (the projection's scale, and the site's height above
 * the ellipsoid), so both are folded into the heading and scale; the grid entry is kept beside
 * them. The model is then flat on the tangent plane at its origin, which drops away from the
 * ellipsoid by 0.8 cm at 300 m and 8 cm at 1 km: sites wider than 2 km belong in 3D Tiles.
 */
export function placementFromGrid(g: GridPosition): Placement {
  const f = gridFactors(g.epsg, g.x, g.y);
  const projected = !(g.epsg === 4326 || g.epsg === 4979);
  // Grid distances are on the ellipsoid; a site 800 m up is 1.3 cm per 100 m wider than that.
  const sin = Math.sin(f.lat * DEG);
  const w = 1 - WGS84_E2 * sin * sin;
  const radius = (WGS84_A * Math.sqrt(1 - WGS84_E2)) / w;
  const elevation = projected ? 1 + g.height / radius : 1;
  return {
    lat: f.lat,
    lon: f.lon,
    height: g.height,
    ...(g.aboveGround !== undefined ? { aboveGround: g.aboveGround } : {}),
    headingDeg: (g.headingDeg ?? 0) + f.northDeg,
    scale: (g.scale ?? 1) * f.groundPerGrid * elevation,
    ...(g.upAxis === "z" ? { upAxis: "z" as const } : {}),
    ...(projected ? { grid: { epsg: g.epsg, x: g.x, y: g.y, northDeg: f.northDeg, groundPerGrid: f.groundPerGrid * elevation } } : {}),
  };
}
