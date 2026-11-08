import { describe, expect, it } from "vitest";
import ref from "./fixtures/proj-utm-reference.json";
import { fromUtm, toUtm } from "./utm";
import { ecefToGeodetic, geodeticToEcef } from "./wgs84";
import { formatCoordinate, parseCoordinateQuery } from "./format";

// Against PROJ itself (scripts/proj-reference-utm.py; WP 2.6 "values match the PROJ reference").
describe(`coordinates against PROJ ${ref.proj}`, () => {
  for (const r of ref.utm) {
    it(`UTM ${r.zone}${r.hemisphere}: ${r.name}`, () => {
      const u = toUtm(r.lat, r.lon, r.forced ? r.zone : undefined);
      expect(u.zone).toBe(r.zone);
      expect(u.hemisphere).toBe(r.hemisphere);
      expect(Math.abs(u.easting - r.easting)).toBeLessThan(0.001);
      expect(Math.abs(u.northing - r.northing)).toBeLessThan(0.001);
      const back = fromUtm(u);
      // 1e-8° is about 1 mm.
      expect(Math.abs(back.lat - r.lat)).toBeLessThan(1e-8);
      expect(Math.abs(back.lon - r.lon)).toBeLessThan(1e-8);
    });
  }
  for (const r of ref.ecef) {
    it(`ECEF: ${r.name}`, () => {
      const p = geodeticToEcef({ lat: r.lat, lon: r.lon, height: r.height });
      expect(Math.hypot(p.x - r.x, p.y - r.y, p.z - r.z)).toBeLessThan(0.001);
      const g = ecefToGeodetic({ x: r.x, y: r.y, z: r.z });
      expect(Math.abs(g.lat - r.lat)).toBeLessThan(1e-8);
      expect(Math.abs(g.lon - r.lon)).toBeLessThan(1e-8);
      expect(Math.abs(g.height - r.height)).toBeLessThan(0.001);
    });
  }
  it("a UTM coordinate as shown reads back to the same place", () => {
    for (const r of ref.utm) {
      const f = formatCoordinate(r.lat, r.lon, 0, "utm", r.forced ? r.zone : undefined);
      const back = parseCoordinateQuery(f.text);
      expect(back).not.toBeNull();
      // Shown to 0.1 m: back within 0.1 m (about 1e-6°).
      expect(Math.abs(back!.lat - r.lat)).toBeLessThan(2e-6);
      expect(Math.abs(back!.lon - r.lon)).toBeLessThan(2e-6);
    }
  });
});

describe("typed coordinates (command palette)", () => {
  it("reads lat, lon with or without a height, and UTM in both forms", () => {
    expect(parseCoordinateQuery("31.7767, 35.2345")).toEqual({ lat: 31.7767, lon: 35.2345 });
    expect(parseCoordinateQuery("31.7767000, 35.2345000, 812.40")).toEqual({ lat: 31.7767, lon: 35.2345 });
    const a = parseCoordinateQuery("36N 711594 3517858")!;
    expect(a.lat).toBeCloseTo(31.7767, 5);
    expect(a.lon).toBeCloseTo(35.2345, 5);
    const b = parseCoordinateQuery("36n 711594.5 E 3517858.5 N 812.4 m")!;
    expect(b.lat).toBeCloseTo(31.7767, 5);
    const south = parseCoordinateQuery("34S 261878 6243186")!;
    expect(south.lat).toBeLessThan(0);
  });
  it("refuses what is not a place", () => {
    for (const q of ["36N 50 3517858", "61N 711594 3517858", "0N 711594 3517858", "95, 35", "hello", "36N 711594"]) expect(parseCoordinateQuery(q)).toBeNull();
  });
});
