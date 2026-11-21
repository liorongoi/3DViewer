import { describe, expect, it } from "vitest";
import { packRotation, type SplatCloud } from "./cloud";
import { decodePly, encodePly } from "./ply";
import { splatToPly } from "./export";

function cloud(n: number): SplatCloud {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const byte = () => Math.floor(rnd() * 256);
  const rotations = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) packRotation(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rotations, i * 3);
  const sh = Uint8Array.from({ length: n * 15 * 3 }, (_, i) => (Math.floor(i / 3) % 15 < 3 ? 8 : 16) * Math.floor(rnd() * (Math.floor(i / 3) % 15 < 3 ? 31 : 15) + 1));
  return {
    count: n,
    shDegree: 3,
    fractionalBits: 12,
    flags: 0,
    pos: Float32Array.from({ length: n * 3 }, () => Math.round((rnd() - 0.5) * 20 * 4096) / 4096),
    alphas: Uint8Array.from({ length: n }, () => 1 + Math.floor(rnd() * 253)),
    colors: Uint8Array.from({ length: n * 3 }, byte),
    scales: Uint8Array.from({ length: n * 3 }, byte),
    rotations,
    sh,
  };
}

describe("writing a splat PLY", () => {
  it("reads back as the same splats", () => {
    const c = cloud(500);
    const back = decodePly(encodePly(c)).cloud;
    expect(back.count).toBe(500);
    expect(back.shDegree).toBe(3);
    expect(Array.from(back.pos)).toEqual(Array.from(c.pos));
    for (const k of ["alphas", "colors", "scales", "sh"] as const) expect(Array.from(back[k])).toEqual(Array.from(c[k]));
    // Rotations: the same up to one step of rounding, sign included.
    for (let i = 0; i < c.rotations.length; i++) expect(Math.abs(back.rotations[i]! - c.rotations[i]!)).toBeLessThanOrEqual(1);
  });

  it("scales a model to its real size", () => {
    const ply = encodePly(cloud(10));
    const twice = decodePly(splatToPly("m.ply", ply, 2)).cloud;
    const once = decodePly(ply).cloud;
    expect(twice.pos[3]).toBeCloseTo(once.pos[3]! * 2, 3);
  });
});
