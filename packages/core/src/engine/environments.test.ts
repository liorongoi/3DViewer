import { describe, expect, it } from "vitest";
import { environmentSh, evalSh, shCoefficients } from "./environments";

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
