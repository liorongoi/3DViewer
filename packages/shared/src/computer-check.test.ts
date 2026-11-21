import { describe, expect, it } from "vitest";
import { checkComputer, gpuName } from "./computer-check";

const base = { webgl2: true, maxTextureSize: 16384, ramGb: 32, ramIsHint: false, cores: 12 };

describe("check this computer", () => {
  it("names the graphics card from ANGLE's renderer string", () => {
    expect(gpuName("ANGLE (NVIDIA, NVIDIA RTX A4000 (0x000024B0) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("NVIDIA RTX A4000");
    expect(gpuName("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("Intel(R) UHD Graphics 620");
    expect(gpuName("Apple M3 Pro")).toBe("Apple M3 Pro");
  });
  it("is ready on a workstation card with enough memory", () => {
    const r = checkComputer({ ...base, renderer: "ANGLE (NVIDIA, NVIDIA RTX 4000 Ada Generation Direct3D11 vs_5_0 ps_5_0, D3D11)", freeDiskGb: 400 });
    expect(r.level).toBe("ok");
    expect(r.rows.map((x) => x.key)).toEqual(["graphics", "memory", "processor", "disk"]);
  });
  it("says software drawing cannot show models well", () => {
    const r = checkComputer({ ...base, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" });
    expect(r.level).toBe("no");
    expect(r.rows[0]?.note).toBe("software");
    expect(checkComputer({ ...base, renderer: "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)" }).rows[0]?.note).toBe("software");
  });
  it("marks a built-in Intel graphics chip and little memory as limits, not failures", () => {
    const r = checkComputer({ ...base, renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", ramGb: 8, cores: 2 });
    expect(r.level).toBe("limit");
    expect(r.rows.map((x) => x.note)).toEqual(["integrated", "lowMemory", "fewCores"]);
  });
  it("needs WebGL 2 and 4 GB", () => {
    expect(checkComputer({ ...base, renderer: null, webgl2: false }).level).toBe("no");
    expect(checkComputer({ ...base, renderer: "NVIDIA GeForce RTX 3060", ramGb: 2 }).rows[1]?.note).toBe("tooLittleMemory");
  });
  it("trusts a browser's memory hint only as far as it goes", () => {
    const r = checkComputer({ ...base, renderer: "NVIDIA GeForce RTX 3060", ramGb: 8, ramIsHint: true });
    expect(r.rows[1]).toMatchObject({ level: "ok", value: "8+ GB" });
  });
});
