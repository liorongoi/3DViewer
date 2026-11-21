import { describe, expect, it } from "vitest";
import { cannotRun, goalsFor, methodById, presetSettings, recommend, SPLAT_METHODS, type ServerHardware } from "./splat-methods";

const base = { platform: "linux", arch: "x64", cpuModel: "Test CPU", cpus: 16, ramGb: 64 };
const rtx: ServerHardware = { ...base, gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", memoryGb: 24, driver: "550.54" }] };
const smallNvidia: ServerHardware = { ...base, gpus: [{ vendor: "nvidia", name: "NVIDIA T400", memoryGb: 4 }] };
const mac: ServerHardware = { ...base, platform: "darwin", arch: "arm64", ramGb: 32, gpus: [{ vendor: "apple", name: "Apple M2 Max", memoryGb: 21 }] };
const cpuOnly: ServerHardware = { ...base, gpus: [] };
const all = SPLAT_METHODS.map((m) => m.id);

describe("splat method recommendation", () => {
  it("has unique ids and every goal has at least one method", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const g of ["scene", "surface", "area", "satellite"] as const) expect(SPLAT_METHODS.some((m) => m.goals.includes(g))).toBe(true);
  });

  it("picks gsplat on NVIDIA, Brush on Apple and OpenSplat on a CPU", () => {
    expect(recommend(rtx, "video", "scene", all).method).toBe("gsplat");
    expect(recommend(mac, "photos", "scene", all).method).toBe("brush");
    expect(recommend(mac, "photos", "scene", all).why[0]).toBe("apple");
    const cpu = recommend(cpuOnly, "photos", "scene", all);
    expect(cpu).toMatchObject({ method: "opensplat", preset: "fast" });
  });

  it("is deterministic", () => {
    expect(recommend(rtx, "video", "area", all)).toEqual(recommend(rtx, "video", "area", all));
  });

  it("uses a surface method for surfaces, and says so when it has to fall back", () => {
    expect(recommend(rtx, "photos", "surface", all).method).toBe("gsplat-2dgs");
    const r = recommend(mac, "photos", "surface", all);
    expect(r.method).toBe("brush");
    expect(r.why).toContain("surfaceFallback");
  });

  it("only offers satellite methods for satellite images and labels generative output", () => {
    expect(goalsFor("satellite")).toEqual(["satellite"]);
    expect(recommend(rtx, "satellite", "satellite", all).method).toBe("eogs-plus");
    const sky = recommend(rtx, "satellite", "satellite", ["skyfall-gs"]);
    expect(sky.method).toBe("skyfall-gs");
    expect(sky.why).toEqual(expect.arrayContaining(["generative", "research", "notInstalled"]));
  });

  it("prefers what is installed, names what is missing, and admits when nothing runs", () => {
    const r = recommend(rtx, "video", "scene", ["brush"]);
    expect(r.method).toBe("brush");
    expect(r.why).toContain("notInstalled");
    expect(recommend(cpuOnly, "satellite", "satellite", all)).toMatchObject({ method: null, why: ["nothingRuns"] });
    expect(recommend(rtx, "video", "scene", [])).toMatchObject({ method: null });
  });

  it("does not offer a method the GPU is too small for", () => {
    expect(cannotRun(methodById("gsplat")!, smallNvidia)).toBe("tooLittleMemory");
    expect(cannotRun(methodById("gsplat")!, mac)).toBe("needsNvidia");
    expect(recommend(smallNvidia, "video", "scene", all).method).toBe("brush");
  });

  it("plans for the GPU memory that is free, not all of it", () => {
    const busy: ServerHardware = { ...base, gpus: [{ vendor: "nvidia", name: "NVIDIA RTX 4000 Ada Generation", memoryGb: 20, freeGb: 3 }] };
    expect(presetSettings(methodById("gsplat")!, "high", busy)).toMatchObject({ maxSplats: 700_000, resolution: 1280 });
  });

  it("fits the preset to the memory and leaves a CPU thread free", () => {
    const hi = presetSettings(methodById("gsplat")!, "high", rtx);
    expect(hi).toMatchObject({ iterations: 30000, maxSplats: 6_000_000, resolution: 2400, threads: 15 });
    const small = presetSettings(methodById("brush")!, "balanced", smallNvidia);
    expect(small.maxSplats).toBe(1_000_000);
    expect(small.resolution).toBe(1280);
    const cpu = presetSettings(methodById("opensplat")!, "high", cpuOnly);
    expect(cpu.iterations).toBeLessThanOrEqual(15000);
    expect(cpu.resolution).toBeLessThanOrEqual(1024);
  });
});
