import proj4 from "proj4";

/**
 * Coordinate systems the viewer can read from user files (GeoTIFF keys, shapefile .prj).
 * proj4 knows EPSG:4326 and EPSG:3857 itself; the rest are listed here so the app works
 * with no internet access (plan WP 1.9). Admins can add more in the same way.
 */
const DEFS: Record<number, string> = {
  // Israel Transverse Mercator (ITM, Israel 1993 / Israeli TM Grid). The datum shift is EPSG's
  // "Israel 1993 to WGS 84 (2)" (EPSG:1074, 0.5 m; proj4 takes the rotations position-vector
  // style, so their signs are flipped from EPSG's coordinate-frame values). Checked against PROJ.
  2039:
    "+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 +towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs",
  // Israeli Grid 05/12 (IG05/12): the same grid on the Survey of Israel's GNSS-based datum
  6991:
    "+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 +towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs",
  // RGF93 / Lambert-93 (France)
  2154: "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  // ETRS89 / LAEA Europe
  3035: "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  // ETRS89 geographic
  4258: "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs",
  // NAD83 geographic
  4269: "+proj=longlat +datum=NAD83 +no_defs",
};

/** proj4 definition for an EPSG code, or null when the viewer does not know it. */
export function epsgDef(code: number): string | null {
  if (code === 4326 || code === 4979) return "EPSG:4326";
  if (code === 3857 || code === 900913 || code === 3785) return "EPSG:3857";
  // WGS 84 / UTM north 32601–32660, south 32701–32760
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  // ETRS89 / UTM 25828–25838
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  return DEFS[code] ?? null;
}

/** A converter from a source CRS to lon/lat degrees and back. */
export interface CrsConverter {
  label: string;
  toLonLat: (x: number, y: number) => [number, number];
  fromLonLat: (lon: number, lat: number) => [number, number];
}

export function converter(def: string, label: string): CrsConverter {
  if (def === "EPSG:4326") return { label, toLonLat: (x, y) => [x, y], fromLonLat: (lon, lat) => [lon, lat] };
  const c = proj4(def, "EPSG:4326");
  return {
    label,
    toLonLat: (x, y) => c.forward([x, y]) as [number, number],
    fromLonLat: (lon, lat) => c.inverse([lon, lat]) as [number, number],
  };
}

export function converterForEpsg(code: number): CrsConverter {
  const def = epsgDef(code);
  if (!def) throw new Error(`The coordinate system EPSG:${code} is not in the viewer's list. Reproject the file to WGS 84 (EPSG:4326) or ask the admin to add EPSG:${code}.`);
  return converter(def, `EPSG:${code}`);
}
