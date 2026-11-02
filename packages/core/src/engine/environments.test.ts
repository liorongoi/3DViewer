import { describe, expect, it } from "vitest";
import { read } from "ktx-parse";
import { environmentSh, environmentSpecular, evalSh, shCoefficients, specularCube } from "./environments";
import { cubeToKtx2 } from "./ktx2";

describe("lighting environments", () => {
  it("gives an even sky of 1 an irradiance of 1 from every side", () => {
    const c = shCoefficients(() => [1, 1, 1]);
    for (const d of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0]] as [number, number, number][]) for (const v of evalSh(c, ...d)) expect(v).toBeCloseTo(1, 3);
  });

  it("lights an upward face from a sky above, not a downward one", () => {
    // Radiance cos θ above the horizon: exact irradiance ÷ π is 2/3 facing up and 0 facing down.
    const c = shCoefficients((_x, _y, z) => [Math.max(0, z), Math.max(0, z), Math.max(0, z)]);
    expect(evalSh(c, 0, 0, 1)[0]).toBeCloseTo(2 / 3, 1);
    expect(Math.abs(evalSh(c, 0, 0, -1)[0])).toBeLessThan(0.08);
    expect(evalSh(c, 1, 0, 0)[0]).toBeCloseTo(evalSh(c, 0, 1, 0)[0], 3);
  });

  it("makes the three presets differ the way they should", () => {
    const up = (id: Parameters<typeof environmentSh>[0]) => evalSh(environmentSh(id)!, 0, 0, 1);
    const down = (id: Parameters<typeof environmentSh>[0]) => evalSh(environmentSh(id)!, 0, 0, -1);
    expect(environmentSh("atmosphere")).toBeNull();
    // Clear noon is blue overhead; overcast and studio are neutral.
    expect(up("clear-noon")[2]).toBeGreaterThan(up("clear-noon")[0]);
    expect(Math.abs(up("studio")[0] - up("studio")[2])).toBeLessThan(1e-9);
    // Studio has the strongest top light against the floor.
    const ratio = (id: Parameters<typeof environmentSh>[0]) => up(id)[1] / down(id)[1];
    expect(ratio("studio")).toBeGreaterThan(ratio("overcast"));
    for (const id of ["overcast", "clear-noon", "studio"] as const) for (const v of [...up(id), ...down(id)]) expect(v).toBeGreaterThan(0);
  });
});

describe("pre-filtered specular maps", () => {
  // Texel at the centre of a face, level m.
  const centre = (cube: ReturnType<typeof specularCube>, m: number, face: number) => {
    const s = cube.size >> m;
    const i = ((face * s + (s >> 1)) * s + (s >> 1)) * 4;
    return [...cube.levels[m]!.subarray(i, i + 3)];
  };

  it("mirrors the sky at roughness 0 and blurs it towards roughness 1", () => {
    // A sky that is 1 within 30° of straight up and 0 elsewhere.
    const spot = specularCube((_x, _y, z) => (z > Math.cos(Math.PI / 6) ? [1, 1, 1] : [0, 0, 0]), 16);
    expect(spot.levels).toHaveLength(5);
    // +Y is up in the shader frame: the top level sees the spot, the side faces do not.
    expect(centre(spot, 0, 2)).toEqual([1, 1, 1]);
    expect(centre(spot, 0, 0)).toEqual([0, 0, 0]);
    // Rougher levels spread the spot: dimmer above, some light at the sides.
    const top = [0, 1, 2, 3, 4].map((m) => centre(spot, m, 2)[0]!);
    expect(top[1]).toBeLessThan(1);
    expect(top[4]).toBeLessThan(top[1]!);
    expect(centre(spot, 4, 0)[0]).toBeGreaterThan(0);
  });

  it("keeps the sky's frame: brighter above than below, the sun's glow to the south-east", () => {
    const c = environmentSpecular("clear-noon")!;
    expect(centre(c, 0, 2)[2]).toBeGreaterThan(centre(c, 0, 3)[2]!);
    // Shader frame: +X east, −Z north, +Z south. The glow is south-east, so +X and +Z beat −X and −Z.
    expect(centre(c, 2, 0)[0]! + centre(c, 2, 4)[0]!).toBeGreaterThan(centre(c, 2, 1)[0]! + centre(c, 2, 5)[0]!);
    expect(environmentSpecular("atmosphere")).toBeNull();
  });

  it("writes a KTX2 cube Cesium can read", () => {
    const cube = environmentSpecular("studio")!;
    const k = read(cubeToKtx2(cube));
    expect(k).toMatchObject({ vkFormat: 109, typeSize: 4, pixelWidth: 32, pixelHeight: 32, faceCount: 6, layerCount: 0, pixelDepth: 0, levelCount: 6 });
    expect(k.levels[0]!.levelData.byteLength).toBe(6 * 32 * 32 * 16);
    expect(k.levels[5]!.levelData.byteLength).toBe(6 * 16);
    expect(new Float32Array(k.levels[0]!.levelData.slice().buffer)[0]).toBeCloseTo(cube.levels[0]![0]!, 6);
  });
});
