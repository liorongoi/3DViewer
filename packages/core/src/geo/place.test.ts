import { describe, expect, it } from "vitest";
import { converterForEpsg } from "./crs";
import { gridFactors, placementFrame, placementFromGrid, transformPoint } from "./place";
import { geodeticToEcef } from "./wgs84";
import ref from "./fixtures/proj-reference.json";

/**
 * WP 1.3 acceptance at maths level: models land within 10 cm of surveyed positions.
 * The reference is PROJ (scripts/proj-reference.py), the EPSG reference implementation,
 * written independently of proj4js which the viewer uses.
 */

describe("coordinate systems agree with PROJ", () => {
  for (const p of ref.points) {
    it(`EPSG:${p.epsg} at ${p.site}`, () => {
      const c = converterForEpsg(p.epsg);
      const [x, y] = c.fromLonLat(p.lon, p.lat);
      expect(Math.hypot(x - p.x, y - p.y)).toBeLessThan(0.01);
      const [lon, lat] = c.toLonLat(p.x, p.y);
      // 1e-7° is about 1 cm.
      expect(Math.abs(lon - p.lon)).toBeLessThan(1e-7);
      expect(Math.abs(lat - p.lat)).toBeLessThan(1e-7);
      // Grid north and grid scale, measured from the projection, match PROJ's own factors for a
      // conformal grid (LAEA is not one, so it has no single grid north). Ours is measured on
      // WGS 84, after the datum shift, which turns it by up to 0.0001° (0.5 mm in 300 m) and, for
      // ITM, scales it by the shift's 5.4 ppm (0.5 mm in 100 m).
      if (p.epsg === 3035) return;
      const f = gridFactors(p.epsg, p.x, p.y);
      expect(Math.abs(f.northDeg - p.convergenceDeg)).toBeLessThan(1e-4);
      expect(Math.abs(f.groundPerGrid * p.scale - 1)).toBeLessThan(1e-5);
    });
  }
});

const ecef = (lat: number, lon: number, h: number) => geodeticToEcef({ lat, lon, height: h });
const dist = (a: [number, number, number], b: { x: number; y: number; z: number }) => Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z);

/** Where the viewer puts a vertex of a model built in grid coordinates around the origin (Z up). */
function land(s: (typeof ref.surveys)[number], pt: (typeof ref.surveys)[number]["points"][number], fold = true) {
  const p = placementFromGrid({ epsg: s.epsg, x: s.origin.x, y: s.origin.y, height: s.origin.h, upAxis: "z" });
  const used = fold ? p : { ...p, headingDeg: 0, scale: 1 };
  const k = used.scale ?? 1;
  return transformPoint(placementFrame(used, used.height), [(pt.x - s.origin.x) * k, (pt.y - s.origin.y) * k, pt.h - s.origin.h]);
}

describe("a surveyed model lands within 10 cm", () => {
  for (const s of ref.surveys) {
    it(`EPSG:${s.epsg} at ${s.site}`, () => {
      let worst = 0;
      for (const pt of s.points) worst = Math.max(worst, dist(land(s, pt), ecef(pt.lat, pt.lon, pt.h)));
      expect(worst).toBeLessThan(0.1);
    });
  }

  it("needs grid north and grid scale to get there", () => {
    // Without them a 400 m site in the Golan is out by about 1 m at its corners.
    const s = ref.surveys.find((x) => x.epsg === 2039 && x.site === "Mount Hermon")!;
    const worst = Math.max(...s.points.map((pt) => dist(land(s, pt, false), ecef(pt.lat, pt.lon, pt.h))));
    expect(worst).toBeGreaterThan(0.5);
  });
});

describe("placementFrame", () => {
  it("turns clockwise from north by the heading", () => {
    const m = placementFrame({ lat: 31.77, lon: 35.21, headingDeg: 90 }, 0);
    const o = ecef(31.77, 35.21, 0);
    // The model's north (+y) now points east.
    const east = placementFrame({ lat: 31.77, lon: 35.21 }, 0);
    const a = transformPoint(m, [0, 100, 0]);
    const b = transformPoint(east, [100, 0, 0]);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-6);
    expect(dist(transformPoint(m, [0, 0, 0]), o)).toBeLessThan(1e-6);
  });

  it("keeps latitude and longitude entered directly as they are", () => {
    const p = placementFromGrid({ epsg: 4326, x: 35.21, y: 31.77, height: 12, headingDeg: 30, scale: 0.01 });
    expect(p).toMatchObject({ lat: 31.77, lon: 35.21, height: 12, headingDeg: 30, scale: 0.01 });
    expect(p.grid).toBeUndefined();
  });

  it("records the grid entry beside the folded heading and scale", () => {
    const p = placementFromGrid({ epsg: 2039, x: 280171.88, y: 813577.48, height: 2000, headingDeg: 10, scale: 1 });
    expect(p.grid).toMatchObject({ epsg: 2039, x: 280171.88, y: 813577.48 });
    expect(p.headingDeg).toBeCloseTo(10 + p.grid!.northDeg, 9);
    expect(p.lat).toBeCloseTo(33.4163, 6);
  });
});

describe("a model placed from a projected grid keeps true heights (WP 2.7)", () => {
  it("puts every surveyed corner of the accuracy block where PROJ puts it, to 1 mm", async () => {
    const survey = (await import("../../../../scripts/fixtures/survey-reference.json")).default as unknown as {
      epsg: number;
      origin: [number, number, number];
      points: { name: string; grid: [number, number, number]; ecef: [number, number, number] }[];
    };
    const [e0, n0, h0] = survey.origin;
    const p = placementFromGrid({ epsg: survey.epsg, x: e0, y: n0, height: h0 });
    // Grid scale stretches distances along the ground only.
    expect(p.verticalFactor).toBeCloseTo(1 / p.scale!, 12);
    const frame = placementFrame(p, h0);
    for (const c of survey.points) {
      const [e, n, h] = c.grid;
      // Model frame (x east, y north, z up), in file metres: scale, then heights by verticalFactor.
      const local: [number, number, number] = [(e - e0) * p.scale!, (n - n0) * p.scale!, (h - h0) * p.scale! * p.verticalFactor!];
      const w = transformPoint(frame, local);
      expect(Math.hypot(w[0] - c.ecef[0], w[1] - c.ecef[1], w[2] - c.ecef[2])).toBeLessThan(0.001);
    }
  });
});
