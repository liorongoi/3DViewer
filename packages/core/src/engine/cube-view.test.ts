import { describe, expect, it } from "vitest";
import { cubeView } from "./viewer-engine";

describe("view cube directions", () => {
  it("matches the face presets", () => {
    expect(cubeView([0, 0, 1])).toEqual({ heading: 0, pitch: -89.9 });
    expect(cubeView([0, -1, 0])).toEqual({ heading: 0, pitch: -5 }); // from the south, looking north
    expect(cubeView([0, 1, 0])).toEqual({ heading: 180, pitch: -5 });
    expect(cubeView([-1, 0, 0])).toEqual({ heading: 90, pitch: -5 }); // from the west, looking east
    expect(cubeView([1, 0, 0])).toEqual({ heading: 270, pitch: -5 });
  });
  it("gives edges and corners their 45° and 35° views", () => {
    const edge = cubeView([0, -1, 1]);
    expect(edge.heading).toBe(0);
    expect(edge.pitch).toBeCloseTo(-45);
    const corner = cubeView([1, -1, 1]); // south-east, above
    expect(corner.heading).toBeCloseTo(315);
    expect(corner.pitch).toBeCloseTo(-35.26, 1);
    expect(cubeView([0, 0, -1]).pitch).toBe(89.9);
  });
});
