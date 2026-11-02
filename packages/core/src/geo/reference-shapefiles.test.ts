import { describe, expect, it } from "vitest";
import shp from "shpjs";
import { converterForEpsg } from "./crs";
import { geodeticToEcef } from "./wgs84";

/**
 * WP 1.9 acceptance: 10 reference shapefiles (points, lines, polygons, 3 coordinate systems)
 * land within 1 m. Each is written here from known WGS 84 positions, projected with the EPSG
 * definition, and read back through shpjs with the .prj as GIS software writes it (ESRI WKT),
 * the same path the Data panel uses. The 10th is a multipart polygon with a hole and Hebrew
 * attributes in UTF-8, the awkward cases real files bring.
 */

type LonLat = [number, number];
type Shape = { kind: "point"; at: LonLat } | { kind: "line"; parts: LonLat[][] } | { kind: "polygon"; rings: LonLat[][] };

const TYPE = { point: 1, line: 3, polygon: 5 } as const;

/** .shp, .shx and .dbf for one shape type; one text field "name". */
function writeShapefile(shapes: Shape[], names: string[], project: (p: LonLat) => LonLat) {
  const kind = shapes[0]!.kind;
  const recs = shapes.map((s) => {
    if (s.kind === "point") {
      const [x, y] = project(s.at);
      const b = new DataView(new ArrayBuffer(20));
      b.setInt32(0, 1, true);
      b.setFloat64(4, x, true);
      b.setFloat64(12, y, true);
      return { bytes: b.buffer, xs: [x], ys: [y] };
    }
    const parts = (s.kind === "line" ? s.parts : s.rings).map((p) => p.map(project));
    const pts = parts.flat();
    const b = new DataView(new ArrayBuffer(44 + parts.length * 4 + pts.length * 16));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    b.setInt32(0, TYPE[s.kind], true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.setFloat64(4 + i * 8, v, true));
    b.setInt32(36, parts.length, true);
    b.setInt32(40, pts.length, true);
    let start = 0;
    parts.forEach((p, i) => (b.setInt32(44 + i * 4, start, true), (start += p.length)));
    pts.forEach(([x, y], i) => (b.setFloat64(44 + parts.length * 4 + i * 16, x, true), b.setFloat64(52 + parts.length * 4 + i * 16, y, true)));
    return { bytes: b.buffer, xs, ys };
  });
  const xs = recs.flatMap((r) => r.xs), ys = recs.flatMap((r) => r.ys);
  const header = (len: number) => {
    const h = new DataView(new ArrayBuffer(100));
    h.setInt32(0, 9994);
    h.setInt32(24, len / 2);
    h.setInt32(28, 1000, true);
    h.setInt32(32, TYPE[kind], true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => h.setFloat64(36 + i * 8, v, true));
    return new Uint8Array(h.buffer);
  };
  const shpLen = 100 + recs.reduce((t, r) => t + 8 + r.bytes.byteLength, 0);
  const shpOut = new Uint8Array(shpLen);
  const shx = new Uint8Array(100 + recs.length * 8);
  shpOut.set(header(shpLen));
  shx.set(header(shx.length));
  let o = 100;
  recs.forEach((r, i) => {
    const d = new DataView(shpOut.buffer, o, 8);
    d.setInt32(0, i + 1);
    d.setInt32(4, r.bytes.byteLength / 2);
    const x = new DataView(shx.buffer, 100 + i * 8, 8);
    x.setInt32(0, o / 2);
    x.setInt32(4, r.bytes.byteLength / 2);
    shpOut.set(new Uint8Array(r.bytes), o + 8);
    o += 8 + r.bytes.byteLength;
  });
  // dBASE III with one 60-byte character field, UTF-8 (declared in the .cpg).
  const enc = new TextEncoder();
  const W = 60, headerLen = 32 + 32 + 1, recLen = 1 + W;
  const dbf = new Uint8Array(headerLen + names.length * recLen + 1);
  const dv = new DataView(dbf.buffer);
  dbf[0] = 3;
  dv.setUint32(4, names.length, true);
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recLen, true);
  dbf.set(enc.encode("name"), 32);
  dbf[43] = "C".charCodeAt(0);
  dbf[48] = W;
  dbf[64] = 0x0d;
  names.forEach((n, i) => {
    const r = headerLen + i * recLen;
    dbf.fill(0x20, r, r + recLen);
    dbf.set(enc.encode(n).subarray(0, W), r + 1);
  });
  dbf[dbf.length - 1] = 0x1a;
  return { shp: shpOut.buffer, shx: shx.buffer, dbf: dbf.buffer, cpg: "UTF-8" };
}

function metres(a: LonLat, b: LonLat): number {
  const p = geodeticToEcef({ lat: a[1], lon: a[0], height: 0 });
  const q = geodeticToEcef({ lat: b[1], lon: b[0], height: 0 });
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

// .prj files as ArcGIS and QGIS write them.
const PRJ: Record<number, string> = {
  32636: 'PROJCS["WGS_1984_UTM_Zone_36N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",33.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
  2154: 'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]',
  2039: 'PROJCS["Israel 1993 / Israeli TM Grid",GEOGCS["Israel 1993",DATUM["Israel_1993",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[-24.0024,-17.1032,-17.8444,-0.33077,-1.85269,1.66969,5.4248]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",31.7343936111111],PARAMETER["central_meridian",35.2045169444444],PARAMETER["scale_factor",1.0000067],PARAMETER["false_easting",219529.584],PARAMETER["false_northing",626907.39],UNIT["metre",1]]',
};

/** Places in each system's own area, in WGS 84. */
const AREA: Record<number, { name: string; at: LonLat }[]> = {
  32636: [{ name: "Haifa port", at: [34.995, 32.82] }, { name: "Be'er Sheva", at: [34.79, 31.25] }, { name: "Tiberias", at: [35.53, 32.79] }, { name: "Eilat", at: [34.95, 29.56] }],
  2154: [{ name: "Lyon, Bellecour", at: [4.832, 45.7578] }, { name: "Paris, Notre-Dame", at: [2.3499, 48.853] }, { name: "Marseille", at: [5.3698, 43.2965] }, { name: "Brest", at: [-4.486, 48.3904] }],
  2039: [{ name: "Jerusalem", at: [35.2137, 31.7683] }, { name: "Tel Aviv", at: [34.7818, 32.0853] }, { name: "Haifa", at: [34.9896, 32.794] }, { name: "Dimona", at: [35.0331, 31.0697] }],
};

/** A closed ring (counter-clockwise when `ccw`) of ~1 km around a point. */
function square([lon, lat]: LonLat, km: number, ccw = false): LonLat[] {
  const dlat = km / 111.32, dlon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const r: LonLat[] = [[lon - dlon, lat - dlat], [lon - dlon, lat + dlat], [lon + dlon, lat + dlat], [lon + dlon, lat - dlat], [lon - dlon, lat - dlat]]; // clockwise: an outer ring
  return ccw ? r.reverse() : r;
}

interface Case { file: string; epsg: number; shapes: Shape[]; names: string[] }

const CASES: Case[] = [];
for (const epsg of [32636, 2154, 2039]) {
  const places = AREA[epsg]!;
  CASES.push({ file: `points-${epsg}`, epsg, shapes: places.map((p) => ({ kind: "point", at: p.at })), names: places.map((p) => p.name) });
  CASES.push({ file: `lines-${epsg}`, epsg, shapes: [{ kind: "line", parts: [places.map((p) => p.at)] }, { kind: "line", parts: [[places[0]!.at, places[2]!.at], [places[1]!.at, places[3]!.at]] }], names: ["Route", "Two legs"] });
  CASES.push({ file: `polygons-${epsg}`, epsg, shapes: places.slice(0, 3).map((p) => ({ kind: "polygon", rings: [square(p.at, 0.8)] })), names: places.slice(0, 3).map((p) => `Site ${p.name}`) });
}
// 10: two islands, the first with a courtyard, named in Hebrew.
const old = AREA[2039]![0]!.at;
CASES.push({ file: "multipart-hebrew-2039", epsg: 2039, shapes: [{ kind: "polygon", rings: [square(old, 1.2), square(old, 0.3, true), square([old[0] + 0.05, old[1]], 0.4)] }], names: ["העיר העתיקה, ירושלים"] });

/** Every vertex of a read feature, in order. */
function vertices(g: GeoJSON.Geometry): LonLat[] {
  if (g.type === "Point") return [g.coordinates as LonLat];
  if (g.type === "LineString") return g.coordinates as LonLat[];
  if (g.type === "MultiLineString" || g.type === "Polygon") return (g.coordinates as LonLat[][]).flat();
  if (g.type === "MultiPolygon") return (g.coordinates as LonLat[][][]).flat(2);
  throw new Error(g.type);
}
const shapeVertices = (s: Shape): LonLat[] => (s.kind === "point" ? [s.at] : (s.kind === "line" ? s.parts : s.rings).flat());

describe("10 reference shapefiles land within 1 m (WP 1.9 acceptance, GEO-02)", () => {
  expect(CASES).toHaveLength(10);
  for (const c of CASES) {
    it(c.file, async () => {
      const crs = converterForEpsg(c.epsg);
      const files = writeShapefile(c.shapes, c.names, ([lon, lat]) => crs.fromLonLat(lon, lat));
      const geo = (await shp({ ...files, prj: PRJ[c.epsg] } as never)) as GeoJSON.FeatureCollection;
      expect(geo.features).toHaveLength(c.shapes.length);
      let worst = 0;
      geo.features.forEach((f, i) => {
        expect(String(f.properties?.name).trim()).toBe(c.names[i]);
        const want = shapeVertices(c.shapes[i]!);
        const got = vertices(f.geometry);
        expect(got).toHaveLength(want.length);
        // GeoJSON may turn rings the other way round, so match each vertex to its nearest.
        got.forEach((p) => (worst = Math.max(worst, Math.min(...want.map((w) => metres(p, w))))));
      });
      expect(worst).toBeLessThan(1);
      if (c.file.startsWith("multipart")) {
        // Two parts, the first keeps its hole.
        const g = geo.features[0]!.geometry as GeoJSON.MultiPolygon;
        expect(g.type).toBe("MultiPolygon");
        expect(g.coordinates.map((p) => p.length).sort()).toEqual([1, 2]);
      }
    });
  }
});
