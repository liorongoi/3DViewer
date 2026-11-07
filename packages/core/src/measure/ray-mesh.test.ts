import { describe, expect, it } from "vitest";
import { rayMeshHit } from "./ray-mesh";

// Two triangles making the unit square at z = 0, and a second square at z = 1 above it.
const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];

describe("rayMeshHit", () => {
  it("finds the nearest triangle along the ray, from either side", () => {
    const down = rayMeshHit(positions, indices, { x: 0.3, y: 0.6, z: 5 }, { x: 0, y: 0, z: -1 }, 0, 100);
    expect(down?.t).toBeCloseTo(4, 12);
    expect(down!.triangle).toBeGreaterThanOrEqual(2);
    const up = rayMeshHit(positions, indices, { x: 0.3, y: 0.6, z: -5 }, { x: 0, y: 0, z: 1 }, 0, 100);
    expect(up?.t).toBeCloseTo(5, 12);
  });

  it("keeps to the t window, so a surface behind the expected one is found when asked for", () => {
    const r = rayMeshHit(positions, indices, { x: 0.3, y: 0.6, z: 5 }, { x: 0, y: 0, z: -1 }, 4.5, 100);
    expect(r?.t).toBeCloseTo(5, 12);
  });

  it("measures t in the units of an unnormalised direction", () => {
    const r = rayMeshHit(positions, indices, { x: 0.5, y: 0.5, z: 3 }, { x: 0, y: 0, z: -2 }, 0, 100);
    expect(r?.t).toBeCloseTo(1, 12);
  });

  it("misses outside the triangles and skips the ones asked to", () => {
    expect(rayMeshHit(positions, indices, { x: 1.5, y: 0.5, z: 3 }, { x: 0, y: 0, z: -1 }, 0, 100)).toBeNull();
    const r = rayMeshHit(positions, indices, { x: 0.3, y: 0.6, z: 5 }, { x: 0, y: 0, z: -1 }, 0, 100, (t) => t >= 2);
    expect(r?.t).toBeCloseTo(5, 12);
  });

  it("is exact far from the origin, in doubles (a site in Earth-centred metres)", () => {
    const X = 4_400_000.123456, Y = 3_100_000.654321, Z = 3_400_000.5;
    const far = positions.map((v, i) => v + [X, Y, Z][i % 3]!);
    const r = rayMeshHit(far, indices, { x: X + 0.25, y: Y + 0.75, z: Z + 50 }, { x: 0.001, y: -0.002, z: -1 }, 0, 1000);
    // Lands on the top square (z = Z + 1): 49 m down.
    expect(Math.abs(r!.t - 49)).toBeLessThan(1e-6);
  });
});
