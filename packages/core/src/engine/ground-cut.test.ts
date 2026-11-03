import { Cartesian3, Cartographic, Ellipsoid, Rectangle } from "cesium";
import { describe, expect, it } from "vitest";
import { CUT_MARGIN, decodeDistances, dilateMin, groundCut, mergeUndersides, MinPyramid, type Underside } from "./ground-cut";
import { createLayeredTerrain, type LayerableTerrain } from "./terrain";

/** WP 1.6: the terrain under the open model is lowered to just below the model, never raised. */

describe("reading the capture", () => {
  it("decodes 24-bit distances and leaves empty pixels out", () => {
    const scale = 1000; // 1 mm steps
    const enc = (m: number) => {
      const v = Math.floor(m * scale) + 1;
      return [v >> 16, (v >> 8) & 255, v & 255, 255];
    };
    const rgba = new Uint8ClampedArray([...enc(0), ...enc(12.345), ...enc(4000.5), 0, 0, 0, 255]);
    const d = decodeDistances(rgba, scale);
    expect(d[0]).toBeCloseTo(0, 2);
    expect(d[1]).toBeCloseTo(12.345, 2);
    expect(d[2]).toBeCloseTo(4000.5, 2);
    expect(d[3]).toBeNaN();
  });

  it("spreads the lowest value a few pixels past the outline", () => {
    const w = 7, h = 5;
    const src = new Float32Array(w * h).fill(NaN);
    src[2 * w + 3] = 5;
    src[2 * w + 4] = 2;
    const out = dilateMin(src, w, h, 1);
    expect(out[2 * w + 2]).toBe(5);
    expect(out[1 * w + 3]).toBe(2);
    expect(out[3 * w + 5]).toBe(2);
    expect(out[0]).toBeNaN();
    expect(out[2 * w + 6]).toBeNaN();
  });
});

describe("the cut", () => {
  // A capture 100 × 100 px at 1 m/px from 20 m below a point near Lyon, looking up.
  const centre = Cartesian3.fromDegrees(4.83, 45.77, 150);
  const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(centre, new Cartesian3());
  const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, normal, new Cartesian3()), new Cartesian3());
  const north = Cartesian3.cross(normal, east, new Cartesian3());
  const camPos = Cartesian3.add(centre, Cartesian3.multiplyByScalar(normal, -20, new Cartesian3()), new Cartesian3());
  const W = 100, H = 100;
  const dist = new Float32Array(W * H).fill(NaN);
  // The model covers the middle 40 × 40 px; its underside is 20 m above the camera, so at 150 m.
  for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) dist[y * W + x] = 20;
  const u: Underside = {
    dist, width: W, height: H, mpp: 1, camPos, right: Cartesian3.negate(east, new Cartesian3()), up: north,
    camHeight: Cartographic.fromCartesian(camPos).height,
    rectangle: Rectangle.fromCartographicArray([
      Cartographic.fromDegrees(4.829, 45.769), Cartographic.fromDegrees(4.831, 45.771),
    ]),
  };
  const c = Cartographic.fromCartesian(centre);
  const m = 1 / 6371000; // radians per metre of latitude

  it("is just under the model inside its outline and absent outside", async () => {
    let shift = 0;
    const cut = groundCut(u, () => shift);
    const rect = new Rectangle(c.longitude - 50 * m / Math.cos(c.latitude), c.latitude - 50 * m, c.longitude + 50 * m / Math.cos(c.latitude), c.latitude + 50 * m);
    const g = (await cut.heightGrid(rect, 11))!;
    // The middle sample is under the model.
    expect(g[5 * 11 + 5]).toBeCloseTo(150 - CUT_MARGIN, 1);
    // The corners are 50 m out, beyond the 20 m half-width.
    expect(g[0]).toBeNaN();
    expect(g[120]).toBeNaN();
    // The model moved up 3 m: the cut follows without a new capture.
    shift = 3;
    const g2 = (await cut.heightGrid(rect, 11))!;
    expect(g2[5 * 11 + 5]).toBeCloseTo(153 - CUT_MARGIN, 1);
  });

  it("only lowers the terrain", async () => {
    const flat = (h: number): LayerableTerrain => {
      const tileHeights = async () => new Float32Array(65 * 65).fill(h);
      return Object.assign(createLayeredTerrain(null, []), { tileHeights, samples: 65 });
    };
    const cut = groundCut(u, () => 0);
    // A deep tile around the model (level 16 is about 300 m across here).
    const level = 16;
    const n = 2 ** level;
    const x = Math.floor(((c.longitude + Math.PI) / (2 * Math.PI)) * 2 * n);
    const y = Math.floor(((Math.PI / 2 - c.latitude) / Math.PI) * n);
    for (const [ground, expected] of [[160, 150 - CUT_MARGIN], [140, 140]] as const) {
      const t = createLayeredTerrain(flat(ground), [cut]);
      const hs = await t.tileHeights(x, y, level);
      const min = Math.min(...hs), max = Math.max(...hs);
      expect(min).toBeCloseTo(expected, 1);
      expect(max).toBe(ground);
    }
  });
});

describe("coarse terrain", () => {
  it("finds the lowest value in any window", () => {
    const w = 37, h = 23;
    const v = new Float32Array(w * h).fill(NaN);
    v[10 * w + 20] = 7;
    v[3 * w + 2] = 4;
    const p = new MinPyramid(v, w, h);
    expect(p.min(19, 9, 21, 11)).toBe(7);
    expect(p.min(0, 0, w - 1, h - 1)).toBe(4);
    expect(p.min(30, 15, 36, 22)).toBeNaN();
    // Brute force over random windows: the answer is never above the true minimum.
    for (let k = 0; k < 200; k++) {
      const x0 = Math.floor(Math.random() * w), y0 = Math.floor(Math.random() * h);
      const x1 = x0 + Math.floor(Math.random() * 10), y1 = y0 + Math.floor(Math.random() * 10);
      let m = Infinity;
      for (let y = y0; y <= Math.min(h - 1, y1); y++) for (let x = x0; x <= Math.min(w - 1, x1); x++) if (v[y * w + x]! < m) m = v[y * w + x]!;
      const got = p.min(x0, y0, x1, y1);
      if (m !== Infinity) expect(got).toBeLessThanOrEqual(m);
    }
  });

  it("lowers the samples around a model narrower than the sample spacing", async () => {
    // A 2 m wide wall in a 100 m tile sampled every 50 m: the samples either side must come
    // down too, or the terrain's straight triangles between them would cut through the wall.
    const centre = Cartesian3.fromDegrees(4.83, 45.77, 150);
    const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(centre, new Cartesian3());
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, normal, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.cross(normal, east, new Cartesian3());
    const W = 120, H = 120;
    const dist = new Float32Array(W * H).fill(NaN);
    for (let y = 0; y < H; y++) for (let x = 70; x < 72; x++) dist[y * W + x] = 20;
    const camPos = Cartesian3.add(centre, Cartesian3.multiplyByScalar(normal, -20, new Cartesian3()), new Cartesian3());
    const u: Underside = { dist, width: W, height: H, mpp: 1, camPos, right: Cartesian3.negate(east, new Cartesian3()), up: north, camHeight: Cartographic.fromCartesian(camPos).height, rectangle: Rectangle.MAX_VALUE };
    const c = Cartographic.fromCartesian(centre);
    const m = 1 / 6371000;
    const rect = new Rectangle(c.longitude - (50 * m) / Math.cos(c.latitude), c.latitude - 50 * m, c.longitude + (50 * m) / Math.cos(c.latitude), c.latitude + 50 * m);
    const g = (await groundCut(u, () => 0).heightGrid(rect, 3))!;
    // The wall is 10 m west of the middle column; the middle and west columns come down.
    for (let r = 0; r < 3; r++) {
      expect(g[r * 3]).toBeCloseTo(150 - CUT_MARGIN, 0);
      expect(g[r * 3 + 1]).toBeCloseTo(150 - CUT_MARGIN, 0);
      expect(g[r * 3 + 2]).toBeNaN();
    }
  });
});

describe("refining", () => {
  const base = (dist: Float32Array): Underside => ({ dist, width: 4, height: 1, mpp: 1, camPos: new Cartesian3(1, 2, 3), right: Cartesian3.UNIT_X, up: Cartesian3.UNIT_Y, camHeight: 0, rectangle: Rectangle.MAX_VALUE });
  it("keeps the lower surface and reports when nothing new turned up", () => {
    const a = base(new Float32Array([10, NaN, 5, NaN]));
    expect(mergeUndersides(a, base(new Float32Array([10.1, NaN, 5, NaN])), 1)).toBe("unchanged");
    const m = mergeUndersides(a, base(new Float32Array([12, 3, 4, NaN])), 1);
    expect(m).not.toBe("unchanged");
    expect(Array.from((m as Underside).dist)).toEqual([10, 3, 4, NaN]);
    expect(mergeUndersides(a, { ...base(new Float32Array(4)), width: 2, height: 2 })).toBe("incompatible");
  });
});
