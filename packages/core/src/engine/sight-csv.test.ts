import { describe, expect, it } from "vitest";
import { pairsToCsv, profileToCsv } from "./sight-csv";
import type { SightPair } from "./sightline";

const pair: SightPair = {
  id: "p1",
  name: 'Ridge, "north"',
  a: { lon: 4.8357, lat: 45.764, h: 170 },
  b: { lon: 4.84, lat: 45.77, h: 180.5 },
  aHeight: 1.8,
  bHeight: 2,
  visible: false,
  block: { d: 120.25, lon: 4.836, lat: 45.765, ground: 171, surface: 190, sight: 172 },
  worstDeficit: 18,
  distance: 760.4,
  profile: [
    { d: 0, lon: 4.8357, lat: 45.764, ground: 170, surface: 170, sight: 171.8 },
    { d: 120.25, lon: 4.836, lat: 45.765, ground: 171, surface: 190, sight: 172 },
  ],
  shown: true,
  computing: false,
};

describe("line-of-sight CSV", () => {
  it("writes one quoted row per pair", () => {
    const lines = pairsToCsv([pair]).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split(",")).toHaveLength(15);
    expect(lines[1]).toMatch(/^"Ridge, ""north""",45\.7640000,4\.8357000,170\.00,1\.80,/);
    expect(lines[1]).toContain(",760.40,no,120.25,");
  });
  it("writes the profile with clearance", () => {
    const lines = profileToCsv(pair).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith(",-18.00")).toBe(true);
  });
  it("leaves the result empty while computing", () => {
    expect(pairsToCsv([{ ...pair, visible: null, block: null }]).split("\n")[1]).toContain(",760.40,,,,,18.00");
  });
});
