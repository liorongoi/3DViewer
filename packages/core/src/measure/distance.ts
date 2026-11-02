import geodesic from "geographiclib-geodesic";
import { dot, ecefToGeodetic, ellipsoidNormal, length, sub, type Vec3 } from "../geo/wgs84";

const WGS84 = geodesic.Geodesic.WGS84;

export interface SegmentResult {
  /** Straight-line distance in ECEF, metres. */
  distance3d: number;
  /** Geodesic distance on the WGS84 ellipsoid between the two footprints, metres. */
  horizontal: number;
  /** Height difference along the local vertical at the first point, metres (positive = up). */
  heightDelta: number;
}

export interface PathResult {
  segments: SegmentResult[];
  total3d: number;
  totalHorizontal: number;
  /** Height of the last point relative to the first, along the first point's vertical. */
  heightDelta: number;
}

/** Measurement maths from SRS section 6.4. Inputs are ECEF positions in metres. */
export function measureSegment(a: Vec3, b: Vec3): SegmentResult {
  const ga = ecefToGeodetic(a);
  const gb = ecefToGeodetic(b);
  const d = sub(b, a);
  const inverse = WGS84.Inverse(ga.lat, ga.lon, gb.lat, gb.lon);
  return {
    distance3d: length(d),
    horizontal: inverse.s12 ?? 0,
    heightDelta: dot(d, ellipsoidNormal(ga.lat, ga.lon)),
  };
}

export function measurePath(points: Vec3[]): PathResult {
  const segments: SegmentResult[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push(measureSegment(points[i - 1]!, points[i]!));
  }
  const first = points[0];
  const last = points[points.length - 1];
  let heightDelta = 0;
  if (first && last && points.length > 1) {
    const g = ecefToGeodetic(first);
    heightDelta = dot(sub(last, first), ellipsoidNormal(g.lat, g.lon));
  }
  return {
    segments,
    total3d: segments.reduce((s, x) => s + x.distance3d, 0),
    totalHorizontal: segments.reduce((s, x) => s + x.horizontal, 0),
    heightDelta,
  };
}

export type LengthUnit = "m" | "ft";
export const METRES_PER_FOOT = 0.3048;

export function convertLength(metres: number, unit: LengthUnit): number {
  return unit === "ft" ? metres / METRES_PER_FOOT : metres;
}

/** Formats a length with sensible precision: mm under 10 m, cm under 1 km, km above. */
export function formatLength(metres: number, unit: LengthUnit, locale = "en"): string {
  const v = convertLength(metres, unit);
  const abs = Math.abs(v);
  if (unit === "m" && abs >= 1000) {
    return `${(v / 1000).toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} km`;
  }
  const digits = abs < 10 ? 3 : 2;
  return `${v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
}
