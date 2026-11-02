import { toUtm } from "./utm";

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
 * Parses coordinates typed into the command palette.
 * Accepts "31.7767, 35.2345" (lat, lon) or "36N 711230 3517450" (UTM).
 */
export function parseCoordinateQuery(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  const dec = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (dec) {
    const lat = Number(dec[1]);
    const lon = Number(dec[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    return null;
  }
  return null;
}
