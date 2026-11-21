import { describe, expect, it } from "vitest";
import { converterForEpsg } from "../geo/crs";
import { placementFrame } from "../geo/place";
import { compareElevation, splatBox, type ElevationRaster } from "./elevation";

// A 20 m square of splats at a known height, placed near Tel Aviv, against a UTM 36N grid.
const at = { lat: 32.08, lon: 34.78 };
const h0 = 40;
const M = placementFrame(at, h0);
function cloud(extraTop = 0) {
  const pos: number[] = [];
  const alphas: number[] = [];
  for (let e = -10; e <= 10; e += 0.25)
    for (let n = -10; n <= 10; n += 0.25) {
      // glTF frame: x east, y up, z towards the viewer (south).
      pos.push(e, 0, -n);
      alphas.push(255);
      // A roof one metre up over the north-east quarter, for the surface model to see.
      if (extraTop && e > 0 && n > 0) pos.push(e, extraTop, -n), alphas.push(255);
    }
  // A faint floater high above: left out.
  pos.push(0, 50, 0);
  alphas.push(10);
  return { count: alphas.length, pos: new Float32Array(pos), alphas: new Uint8Array(alphas) };
}
function grid(value: (x: number, y: number) => number): ElevationRaster {
  const crs = converterForEpsg(32636);
  const [cx, cy] = crs.fromLonLat(at.lon, at.lat);
  const res = 2;
  const ox = Math.floor((cx - 16) / res) * res;
  const oy = Math.ceil((cy + 16) / res) * res;
  const w = 16;
  const data = new Float32Array(w * w);
  for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) data[r * w + c] = value(ox + (c + 0.5) * res - cx, oy - (r + 0.5) * res - cy);
  data[0] = -9999;
  return { width: w, height: w, data, originX: ox, originY: oy, resX: res, resY: -res, noData: -9999, crs, epsg: 32636 };
}

describe("splat heights against an elevation model", () => {
  it("finds a constant offset, and the shape error apart from it", () => {
    const r = compareElevation(cloud(), M, grid(() => h0 - 0.5), { kind: "DSM" });
    expect(r.meanDifference).toBeCloseTo(0.5, 2);
    expect(r.rmsAfterShift).toBeLessThan(0.01);
    expect(r.cells).toBeGreaterThan(80);
    // The faint floater 50 m up did not count.
    expect(r.maxAbs).toBeLessThan(0.52);
  });
  it("adds the geoid height to a sea-level reference", () => {
    const r = compareElevation(cloud(), M, grid(() => h0 - 19.5), { kind: "DSM", referenceOffset: 19.5 });
    expect(Math.abs(r.meanDifference)).toBeLessThan(0.01);
  });
  it("takes the top for a surface model and the lowest splats for bare earth", () => {
    const dsm = compareElevation(cloud(1), M, grid(() => h0), { kind: "DSM" });
    expect(dsm.maxAbs).toBeCloseTo(1, 1);
    const dtm = compareElevation(cloud(1), M, grid(() => h0), { kind: "DTM" });
    expect(dtm.maxAbs).toBeLessThan(0.02);
  });
  it("says where the model is, and refuses a file that does not cover it", () => {
    const box = splatBox(cloud(), M);
    expect(box.west).toBeLessThan(at.lon);
    expect(box.east).toBeGreaterThan(at.lon);
    const far = { ...grid(() => h0), originX: 100000 };
    expect(() => compareElevation(cloud(), M, far, { kind: "DSM" })).toThrow(/No cell/);
  });
});
