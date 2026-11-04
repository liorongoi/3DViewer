import { describe, expect, it } from "vitest";
import shp from "shpjs";
import { converterForEpsg } from "./crs";
import { fromUtm } from "./utm";
import { geodeticToEcef } from "./wgs84";

/** A point shapefile (.shp + .dbf) in memory: the smallest valid files, one numeric field "id". */
function pointShapefile(points: [number, number][]): { shp: ArrayBuffer; dbf: ArrayBuffer } {
  const n = points.length;
  const shpBuf = new ArrayBuffer(100 + n * 28);
  const v = new DataView(shpBuf);
  v.setInt32(0, 9994);
  v.setInt32(24, shpBuf.byteLength / 2);
  v.setInt32(28, 1000, true);
  v.setInt32(32, 1, true); // point
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((b, i) => v.setFloat64(36 + i * 8, b, true));
  points.forEach(([x, y], i) => {
    const o = 100 + i * 28;
    v.setInt32(o, i + 1);
    v.setInt32(o + 4, 10);
    v.setInt32(o + 8, 1, true);
    v.setFloat64(o + 12, x, true);
    v.setFloat64(o + 20, y, true);
  });
  const headerLen = 32 + 32 + 1;
  const recLen = 1 + 8;
  const dbf = new Uint8Array(headerLen + n * recLen + 1);
  const d = new DataView(dbf.buffer);
  dbf[0] = 3;
  d.setUint32(4, n, true);
  d.setUint16(8, headerLen, true);
  d.setUint16(10, recLen, true);
  dbf.set(new TextEncoder().encode("id"), 32);
  dbf[32 + 11] = "N".charCodeAt(0);
  dbf[32 + 16] = 8;
  dbf[64] = 0x0d;
  points.forEach((_, i) => {
    const o = headerLen + i * recLen;
    dbf[o] = 0x20;
    dbf.set(new TextEncoder().encode(String(i).padStart(8, " ")), o + 1);
  });
  dbf[dbf.length - 1] = 0x1a;
  return { shp: shpBuf, dbf: dbf.buffer };
}

async function read(points: [number, number][], prj: string): Promise<[number, number][]> {
  const geo = (await shp({ ...pointShapefile(points), prj } as never)) as GeoJSON.FeatureCollection;
  return geo.features.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
}

/** Ground distance in metres between two lon/lat points (straight line through ECEF, fine at these scales). */
function metres(a: [number, number], b: [number, number]): number {
  const p = geodeticToEcef({ lat: a[1], lon: a[0], height: 0 });
  const q = geodeticToEcef({ lat: b[1], lon: b[0], height: 0 });
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

const UTM36N = 'PROJCS["WGS_1984_UTM_Zone_36N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",33.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
const LAMBERT93 = 'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]';
// EPSG:2039 with the Israel 1993 → WGS 84 shift written in (EPSG:1074, in WKT1 position-vector signs).
const ITM = 'PROJCS["Israel 1993 / Israeli TM Grid",GEOGCS["Israel 1993",DATUM["Israel_1993",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",31.7343936111111],PARAMETER["central_meridian",35.2045169444444],PARAMETER["scale_factor",1.0000067],PARAMETER["false_easting",219529.584],PARAMETER["false_northing",626907.39],UNIT["metre",1]]';

describe("shapefiles land where they should (WP 1.9, GEO-02)", () => {
  it("UTM 36N points match the viewer's own UTM maths within 1 m", async () => {
    const pts: [number, number][] = [[684000, 3628000], [700500, 3550200], [670123.4, 3700987.6], [500000, 3500000]];
    const got = await read(pts, UTM36N);
    pts.forEach(([e, n], i) => {
      const want = fromUtm({ zone: 36, hemisphere: "N", easting: e, northing: n });
      expect(metres(got[i]!, [want.lon, want.lat])).toBeLessThan(1);
    });
  });

  it("Lambert-93 puts its false origin at 3° E, 46.5° N", async () => {
    const [p] = await read([[700000, 6600000]], LAMBERT93);
    expect(metres(p!, [3, 46.5])).toBeLessThan(1);
  });

  it("Israeli TM Grid matches the viewer's EPSG:2039 within 1 m, datum shift included", async () => {
    const pts: [number, number][] = [[219529.584, 626907.39], [178000, 664000], [200000, 560000], [248000, 750000]];
    const got = await read(pts, ITM);
    const c = converterForEpsg(2039);
    pts.forEach(([x, y], i) => expect(metres(got[i]!, c.toLonLat(x, y))).toBeLessThan(1));
    // The shift from Israel 1993 to WGS 84 is real (a few metres here): a reader that dropped it would miss.
    const noShift = await read([pts[0]!], ITM.replace(/,TOWGS84\[[^\]]*\]/, ""));
    expect(metres(noShift[0]!, got[0]!)).toBeGreaterThan(1);
  });
});
