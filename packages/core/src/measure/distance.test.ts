import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../geo/wgs84";
import { convertLength, formatLength, measurePath, measureSegment } from "./distance";

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
