import { describe, expect, it } from "vitest";
import { ecefToGeodetic, geodeticToEcef } from "./wgs84";
import { fromUtm, toUtm, utmZoneFor } from "./utm";
import { formatCoordinate, parseCoordinateQuery } from "./format";

describe("WGS84", () => {
  it("round-trips geodetic ↔ ECEF to sub-millimetre", () => {
    for (const g of [
      { lat: 31.7767, lon: 35.2345, height: 812.4 },
      { lat: -33.86, lon: 151.2, height: -20 },
      { lat: 89.9, lon: -120, height: 3000 },
      { lat: 0, lon: 0, height: 0 },
    ]) {
      const back = ecefToGeodetic(geodeticToEcef(g));
      expect(back.lat).toBeCloseTo(g.lat, 9);
      expect(back.lon).toBeCloseTo(g.lon, 9);
      expect(Math.abs(back.height - g.height)).toBeLessThan(1e-3);
    }
  });

  it("matches the known ECEF of the equator / prime meridian", () => {
    const p = geodeticToEcef({ lat: 0, lon: 0, height: 0 });
    expect(p.x).toBeCloseTo(6378137, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });
});

describe("UTM", () => {
  it("detects zones including the Norway and Svalbard exceptions", () => {
    expect(utmZoneFor(31.77, 35.23)).toBe(36);
    expect(utmZoneFor(60, 5)).toBe(32);
    expect(utmZoneFor(78, 15)).toBe(33);
    expect(utmZoneFor(-33.9, 18.4)).toBe(34);
  });

  it("round-trips WGS84 ↔ UTM to 1 mm", () => {
    const u = toUtm(31.7767, 35.2345);
    expect(u.zone).toBe(36);
    expect(u.hemisphere).toBe("N");
    const back = fromUtm(u);
    expect(back.lat).toBeCloseTo(31.7767, 8);
    expect(back.lon).toBeCloseTo(35.2345, 8);
  });

  it("puts the central meridian at easting 500 000", () => {
    expect(toUtm(10, 33).easting).toBeCloseTo(500000, 3);
  });
});

describe("coordinate formatting and parsing", () => {
  it("formats WGS84 with hemispheres", () => {
    expect(formatCoordinate(31.5, -0.25, 10, "wgs84").parts).toEqual(["31.500000° N", "0.250000° W", "10.0 m"]);
  });
  it("parses decimal lat, lon", () => {
    expect(parseCoordinateQuery("31.7767, 35.2345")).toEqual({ lat: 31.7767, lon: 35.2345 });
    expect(parseCoordinateQuery("hello")).toBeNull();
    expect(parseCoordinateQuery("95, 10")).toBeNull();
  });
});
