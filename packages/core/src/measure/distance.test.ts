import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../geo/wgs84";
import { convertLength, formatLength, formatModelLength, measurePath, measureSegment } from "./distance";

describe("measureSegment", () => {
  it("measures a pure vertical segment", () => {
    const a = geodeticToEcef({ lat: 31.77, lon: 35.23, height: 100 });
    const b = geodeticToEcef({ lat: 31.77, lon: 35.23, height: 142.5 });
    const r = measureSegment(a, b);
    expect(r.distance3d).toBeCloseTo(42.5, 6);
    expect(r.horizontal).toBeCloseTo(0, 6);
    expect(r.heightDelta).toBeCloseTo(42.5, 6);
  });

  it("measures one arc-minute of latitude close to the known value (~1843 m at 31.77°N)", () => {
    const a = geodeticToEcef({ lat: 31.77, lon: 35.23, height: 0 });
    const b = geodeticToEcef({ lat: 31.77 + 1 / 60, lon: 35.23, height: 0 });
    const r = measureSegment(a, b);
    // Meridional arc length per minute at this latitude.
    expect(r.horizontal).toBeGreaterThan(1846);
    expect(r.horizontal).toBeLessThan(1849);
    // The chord is shorter than the arc, by well under a millimetre at this scale.
    expect(r.horizontal - r.distance3d).toBeGreaterThan(0);
    expect(r.horizontal - r.distance3d).toBeLessThan(0.01);
  });

  it("keeps the right-angle relation for short segments (NFR-07: 0.1% or 1 cm)", () => {
    const a = geodeticToEcef({ lat: 48.58, lon: 7.75, height: 150 });
    const b = geodeticToEcef({ lat: 48.5803, lon: 7.7504, height: 171 });
    const r = measureSegment(a, b);
    const pythagoras = Math.hypot(r.horizontal, r.heightDelta);
    expect(Math.abs(pythagoras - r.distance3d)).toBeLessThan(Math.max(0.01, r.distance3d * 0.001));
  });
});

describe("measurePath", () => {
  it("sums segments and reports overall height change", () => {
    const pts = [0, 10, 25].map((h, i) => geodeticToEcef({ lat: 31.77 + i * 0.0001, lon: 35.23, height: 100 + h }));
    const r = measurePath(pts);
    expect(r.segments).toHaveLength(2);
    expect(r.total3d).toBeCloseTo(r.segments[0]!.distance3d + r.segments[1]!.distance3d, 9);
    expect(r.heightDelta).toBeCloseTo(25, 1);
  });
});

describe("units", () => {
  it("converts metres to feet exactly", () => {
    expect(convertLength(0.3048, "ft")).toBeCloseTo(1, 12);
  });
  it("formats with sensible precision", () => {
    expect(formatLength(4.2, "m")).toBe("4.200 m");
    expect(formatLength(42.181, "m")).toBe("42.18 m");
    expect(formatLength(1234.5, "m")).toBe("1.235 km");
  });
});

describe("model units (MSR-06)", () => {
  it("names the unit in words and never switches to km", () => {
    expect(formatModelLength(2.5, "model units")).toBe("2.500 model units");
    expect(formatModelLength(12345.678, "model units")).toBe("12,345.68 model units");
  });
});

// Reference values from outside this code (NFR-07: 0.1 % or 1 cm, whichever is larger).
describe("against published references", () => {
  const tol = (d: number) => Math.max(0.01, d * 0.001);

  it("horizontal: Karney's Wellington to Salamanca geodesic (Algorithms for geodesics, 2013)", () => {
    // s12 = 19 959 679.267 m on WGS84 (GeographicLib documentation, example 2).
    const a = geodeticToEcef({ lat: -41.32, lon: 174.81, height: 0 });
    const b = geodeticToEcef({ lat: 40.96, lon: -5.5, height: 0 });
    expect(Math.abs(measureSegment(a, b).horizontal - 19959679.267)).toBeLessThan(0.001);
  });

  it("horizontal: one degree of longitude on the equator is a / 1 rad × π / 180", () => {
    const a = geodeticToEcef({ lat: 0, lon: 34, height: 0 });
    const b = geodeticToEcef({ lat: 0, lon: 35, height: 0 });
    expect(Math.abs(measureSegment(a, b).horizontal - (6378137 * Math.PI) / 180)).toBeLessThan(0.001);
  });

  it("3D: the polar radius b = 6 356 752.3142 m (NIMA TR8350.2)", () => {
    const centre = { x: 0, y: 0, z: 0 };
    const pole = geodeticToEcef({ lat: 90, lon: 0, height: 0 });
    expect(Math.abs(measureSegment(centre, pole).distance3d - 6356752.3142)).toBeLessThan(0.001);
  });

  it("3D, horizontal and height on a building-sized box at Jerusalem agree with plane geometry", () => {
    // A 40 m × 30 m footprint and a 25 m rise, laid out with the local east-north-up frame.
    const o = { lat: 31.7683, lon: 35.2137, height: 780 };
    const p = geodeticToEcef(o);
    const n = geodeticToEcef({ ...o, height: o.height + 1 });
    const up = [n.x - p.x, n.y - p.y, n.z - p.z];
    const lon = (o.lon * Math.PI) / 180;
    const east = [-Math.sin(lon), Math.cos(lon), 0];
    const north = [up[1]! * east[2]! - up[2]! * east[1]!, up[2]! * east[0]! - up[0]! * east[2]!, up[0]! * east[1]! - up[1]! * east[0]!];
    const q = { x: p.x + 40 * east[0]! + 30 * north[0]! + 25 * up[0]!, y: p.y + 40 * east[1]! + 30 * north[1]! + 25 * up[1]!, z: p.z + 40 * east[2]! + 30 * north[2]! + 25 * up[2]! };
    const r = measureSegment(p, q);
    expect(Math.abs(r.distance3d - Math.hypot(40, 30, 25))).toBeLessThan(tol(r.distance3d));
    // The ground distance is measured at height 0, 780 m below: shorter by 780 / R, about 6 mm.
    expect(Math.abs(r.horizontal - 50)).toBeLessThan(tol(50));
    expect(Math.abs(r.heightDelta - 25)).toBeLessThan(tol(25));
  });
});
