import { describe, expect, it } from "vitest";
import { packRotation, type SplatCloud } from "./cloud";
import { decodePly, encodePly } from "./ply";
import { glbToGltf, splatToGlb, splatToPly } from "./export";
import { readSplatFile } from "./index";

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

describe("a splat model as GLB and glTF", () => {
  it("carries the splats with KHR_gaussian_splatting, at the real size", () => {
    const ply = encodePly(cloud(50));
    const glb = splatToGlb("m.ply", ply, 2);
    const files = glbToGltf(glb, "m");
    const doc = JSON.parse(new TextDecoder().decode(files["m.gltf"]!));
    expect(doc.extensionsRequired).toContain("KHR_gaussian_splatting");
    expect(doc.accessors[0].count).toBe(50);
    // The positions' bounds doubled with the scale.
    const once = readSplatFile("m.ply", ply).cloud;
    let maxX = -Infinity;
    for (let i = 0; i < once.count; i++) maxX = Math.max(maxX, once.pos[i * 3]!);
    expect(doc.accessors[0].max[0]).toBeCloseTo(maxX * 2, 2);
  });
});
