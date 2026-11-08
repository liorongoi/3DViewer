import { fromUtm, toUtm } from "./utm";

export type CoordinateSystem = "wgs84" | "utm";

export interface FormattedCoordinate {
  /** Short parts for display, e.g. ["31.776712° N", "35.234519° E", "812.4 m"]. */
  parts: string[];
  /** One-line text for the clipboard. */
  text: string;
}

export function formatCoordinate(
  lat: number,
  lon: number,
  height: number,
  system: CoordinateSystem,
  utmZone?: number,
): FormattedCoordinate {
  const h = `${height.toFixed(1)} m`;
  if (system === "utm") {
    const u = toUtm(lat, lon, utmZone);
    const parts = [`${u.zone}${u.hemisphere}`, `${u.easting.toFixed(1)} E`, `${u.northing.toFixed(1)} N`, h];
    return { parts, text: parts.join(" ") };
  }
  const parts = [
    `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? "N" : "S"}`,
    `${Math.abs(lon).toFixed(6)}° ${lon >= 0 ? "E" : "W"}`,
    h,
  ];
  return { parts, text: `${lat.toFixed(7)}, ${lon.toFixed(7)}, ${height.toFixed(2)}` };
}

/**
 * Parses coordinates typed into the command palette, or pasted from the viewer.
 * Accepts "31.7767, 35.2345" (lat, lon, with an optional height after them) and UTM as
 * "36N 711230 3517450" or as the viewer copies it, "36N 711230.0 E 3517450.0 N 812.4 m".
 * N and S after the zone are the hemisphere (not MGRS latitude bands).
 */
export function parseCoordinateQuery(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  const dec = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*[, ]\s*-?\d+(?:\.\d+)?(?:\s*m)?)?$/);
  if (dec) {
    const lat = Number(dec[1]);
    const lon = Number(dec[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    return null;
  }
  const utm = s.match(/^(\d{1,2})\s*([NSns])\s*[, ]?\s*(\d{6}(?:\.\d+)?)\s*(?:m\s*)?E?\s*[, ]?\s*(\d{1,8}(?:\.\d+)?)\s*(?:m\s*)?N?(?:\s*[, ]?\s*-?\d+(?:\.\d+)?\s*m?)?$/);
  if (utm) {
    const zone = Number(utm[1]);
    const easting = Number(utm[3]);
    const northing = Number(utm[4]);
    if (zone < 1 || zone > 60 || easting < 100_000 || easting > 900_000 || northing < 0 || northing > 10_000_000) return null;
    const p = fromUtm({ zone, hemisphere: utm[2]!.toUpperCase() as "N" | "S", easting, northing });
    return Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
  }
  return null;
}
