import { describe, expect, it } from "vitest";
import { datumShift, geoidHeight } from "./geoid";

/** VWR-GEO-01: georeferenced cities meet the terrain whatever height datum they use. */

describe("EGM96 geoid height", () => {
  it("matches the full 15' model at the sample cities (within 0.5 m)", () => {
    // Values from the full EGM96 15' grid, bilinear.
    expect(geoidHeight(45.7646, 4.8239)).toBeCloseTo(49.85, 0); // Lyon, Fourvière
    expect(geoidHeight(48.5818, 7.7509)).toBeCloseTo(48.48, 0); // Strasbourg
    expect(geoidHeight(50.637, 3.063)).toBeCloseTo(44.71, 0); // Lille
    expect(geoidHeight(31.77, 35.21)).toBeCloseTo(20.1, 0); // Jerusalem
  });

  it("handles the poles, the antimeridian and west longitudes", () => {
    expect(Number.isFinite(geoidHeight(90, 0))).toBe(true);
    expect(Number.isFinite(geoidHeight(-90, 0))).toBe(true);
    expect(geoidHeight(10, -179.5)).toBeCloseTo(geoidHeight(10, 180.5), 6);
    expect(geoidHeight(0, 359.99)).toBeCloseTo(geoidHeight(0, -0.01), 6);
    // The geoid's low south of India (about −100 m) and high over New Guinea (about +80 m).
    expect(geoidHeight(5, 78)).toBeLessThan(-90);
    expect(geoidHeight(-5, 145)).toBeGreaterThan(60);
  });
});

describe("choosing the datum shift", () => {
  it("snaps an ellipsoidal city on sea-level terrain to the geoid height", () => {
    // Fourvière: the streets measured 38 m above the 30 m terrain; the datum gap is 49.85 m.
    expect(datumShift(38.04, 49.85)).toBe(-49.85);
    // Strasbourg: 42 m measured, 48.5 m geoid.
    expect(datumShift(42, 48.48)).toBe(-48.48);
  });

  it("leaves a city already in sea-level heights where it is", () => {
    expect(datumShift(4, 49.85)).toBe(0);
    expect(datumShift(-6, 49.85)).toBe(0);
  });

  it("raises a sea-level city drawn on ellipsoidal terrain", () => {
    expect(datumShift(-45, 49.85)).toBe(49.85);
  });

  it("falls back to the measured gap for any other datum", () => {
    expect(datumShift(231, 49.85)).toBe(-231);
    expect(datumShift(25, 49.85)).toBe(-25);
  });

  it("keeps the choices apart where the geoid is low", () => {
    expect(datumShift(14, 20.1)).toBe(-20.1);
    expect(datumShift(6, 20.1)).toBe(0);
    // Tolerance is half the geoid height, so 0 and the geoid height never compete.
    expect(datumShift(-30.5, 20.1)).toBe(30.5);
  });
});
