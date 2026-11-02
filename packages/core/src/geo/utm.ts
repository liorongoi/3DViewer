import proj4 from "proj4";

export interface UtmCoordinate {
  zone: number;
  hemisphere: "N" | "S";
  easting: number;
  northing: number;
}

/** Standard UTM zone for a position, including the Norway and Svalbard exceptions. */
export function utmZoneFor(lat: number, lon: number): number {
  const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  let zone = Math.floor((normLon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  if (lat >= 56 && lat < 64 && normLon >= 3 && normLon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (normLon >= 0 && normLon < 9) zone = 31;
    else if (normLon >= 9 && normLon < 21) zone = 33;
    else if (normLon >= 21 && normLon < 33) zone = 35;
    else if (normLon >= 33 && normLon < 42) zone = 37;
  }
  return zone;
}

function utmDef(zone: number, hemisphere: "N" | "S"): string {
  return `+proj=utm +zone=${zone} ${hemisphere === "S" ? "+south " : ""}+datum=WGS84 +units=m +no_defs`;
}

/** WGS84 lat/lon (degrees) to UTM. Zone is detected unless given. */
export function toUtm(lat: number, lon: number, zone?: number): UtmCoordinate {
  const z = zone ?? utmZoneFor(lat, lon);
  const hemisphere = lat >= 0 ? "N" : "S";
  const [easting, northing] = proj4("EPSG:4326", utmDef(z, hemisphere), [lon, lat]) as [number, number];
  return { zone: z, hemisphere, easting, northing };
}

export function fromUtm({ zone, hemisphere, easting, northing }: UtmCoordinate): { lat: number; lon: number } {
  const [lon, lat] = proj4(utmDef(zone, hemisphere), "EPSG:4326", [easting, northing]) as [number, number];
  return { lat, lon };
}
