import { describe, expect, it } from "vitest";
import { nextResolutionScale } from "./adaptive-resolution";

const at = (o: Partial<Parameters<typeof nextResolutionScale>[0]>) =>
  nextResolutionScale({ scale: 1, base: 1, avgFrameMs: 10, moving: true, now: 10_000, changedAt: 0, ...o });

describe("adaptive resolution", () => {
  it("lowers one step while moving and frames are slow", () => {
    expect(at({ avgFrameMs: 30 })).toBeCloseTo(0.9);
  });
  it("never raises while moving, however fast the frames", () => {
    expect(at({ scale: 0.8, avgFrameMs: 5 })).toBeCloseTo(0.8);
  });
  it("waits for frames at the new size to settle before lowering again", () => {
    expect(at({ scale: 0.9, avgFrameMs: 40, changedAt: 9_500 })).toBeCloseTo(0.9);
  });
  it("stops at the floor", () => {
    expect(at({ scale: 0.6, avgFrameMs: 80 })).toBeCloseTo(0.6);
  });
  it("goes back to the preset in one step once still", () => {
    expect(at({ scale: 0.6, moving: false, avgFrameMs: 80 })).toBe(1);
  });
  it("scales steps with the preset", () => {
    expect(at({ scale: 2, base: 2, avgFrameMs: 30 })).toBeCloseTo(1.8);
  });
});
