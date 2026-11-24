import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanServerUrl, parseSwitch, readConfig, type ConfigSources } from "./config";

// Built with path.join, as the code does, so the test also runs on Windows.
const EXE_JSON = path.join("/app", "viewer.json");
const PD_JSON = path.join("/pd", "VIEWER", "viewer.json");
const sources = (over: Partial<ConfigSources> = {}, files: Record<string, string> = {}, reg: Record<string, string> = {}): ConfigSources => ({
  env: {},
  exeDir: "/app",
  programData: "/pd",
  readFile: (p) => files[p] ?? null,
  registry: (k, v = "ServerUrl") => (v === "ServerUrl" ? (reg[k] ?? null) : null),
  ...over,
});

describe("server address", () => {
  it("cleans addresses", () => {
    expect(cleanServerUrl("https://viewer.internal/")).toBe("https://viewer.internal");
    expect(cleanServerUrl(" http://10.0.0.5:8080/api/ ")).toBe("http://10.0.0.5:8080/api");
    expect(cleanServerUrl("ftp://x")).toBeNull();
    expect(cleanServerUrl("https://u:p@x")).toBeNull();
    expect(cleanServerUrl("https://x/?a=1")).toBeNull();
    expect(cleanServerUrl("viewer.internal")).toBeNull();
  });
  it("is unset with nothing configured", () => {
    expect(readConfig(sources())).toEqual({ serverUrl: null, source: null, onlineMaps: true, onlineMapsSource: null, problems: [] });
  });
  it("takes the first source found, in order", () => {
    const files = { [EXE_JSON]: '{"serverUrl":"https://exe"}', [PD_JSON]: '{"serverUrl":"https://pd"}' };
    const reg = { "HKLM\\Software\\VIEWER": "https://hklm", "HKCU\\Software\\VIEWER": "https://hkcu" };
    expect(readConfig(sources({ env: { VIEWER_SERVER_URL: "https://env" } }, files, reg)).serverUrl).toBe("https://env");
    expect(readConfig(sources({}, files, reg)).serverUrl).toBe("https://exe");
    expect(readConfig(sources({}, { [PD_JSON]: files[PD_JSON] }, reg)).serverUrl).toBe("https://pd");
    expect(readConfig(sources({}, {}, reg))).toMatchObject({ serverUrl: "https://hklm", source: "HKLM\\Software\\VIEWER" });
    expect(readConfig(sources({}, {}, { "HKCU\\Software\\VIEWER": "https://hkcu" })).serverUrl).toBe("https://hkcu");
  });
  it("reads a file saved with a byte order mark", () => {
    expect(readConfig(sources({}, { [EXE_JSON]: '﻿{"serverUrl":"https://bom"}' })).serverUrl).toBe("https://bom");
  });
  it("reports a broken file or a bad address and moves on", () => {
    const c = readConfig(sources({}, { [EXE_JSON]: "{nope", [PD_JSON]: '{"serverUrl":"viewer.internal"}' }, { "HKLM\\Software\\VIEWER": "https://ok" }));
    expect(c.serverUrl).toBe("https://ok");
    expect(c.problems).toHaveLength(2);
    expect(c.problems[1]).toContain("viewer.internal");
  });
  it("ignores an empty serverUrl", () => {
    expect(readConfig(sources({}, { [EXE_JSON]: '{"serverUrl":""}' })).problems).toEqual([]);
  });
});

describe("online maps", () => {
  it("are on with nothing configured", () => {
    expect(readConfig(sources())).toMatchObject({ onlineMaps: true, onlineMapsSource: null, problems: [] });
  });
  it("are turned on or off by the first place that sets them, in order", () => {
    const reg = { "HKLM\\Software\\VIEWER": "0x1" };
    const regOf = (r: Record<string, string>) => (k: string, v?: string) => (v === "OnlineMaps" ? (r[k] ?? null) : null);
    expect(readConfig(sources({ env: { VIEWER_ONLINE_MAPS: "1" } }))).toMatchObject({ onlineMaps: true, onlineMapsSource: "VIEWER_ONLINE_MAPS" });
    expect(readConfig(sources({}, { [EXE_JSON]: '{"onlineMaps":true}' }))).toMatchObject({ onlineMaps: true, onlineMapsSource: EXE_JSON });
    expect(readConfig(sources({}, { [EXE_JSON]: '{"onlineMaps":false}', [PD_JSON]: '{"onlineMaps":true}' }))).toMatchObject({ onlineMaps: false, onlineMapsSource: EXE_JSON });
    expect(readConfig(sources({}, { [PD_JSON]: '{"serverUrl":"https://pd","onlineMaps":true}' }))).toMatchObject({ serverUrl: "https://pd", onlineMaps: true });
    expect(readConfig(sources({ registry: regOf(reg) }))).toMatchObject({ onlineMaps: true, onlineMapsSource: "HKLM\\Software\\VIEWER" });
    expect(readConfig(sources({ registry: regOf({ "HKCU\\Software\\VIEWER": "0x0" }) }))).toMatchObject({ onlineMaps: false, onlineMapsSource: "HKCU\\Software\\VIEWER" });
  });
  it("does not read the server address as the switch, nor the switch as the address", () => {
    const c = readConfig(sources({ registry: (k, v) => (k.startsWith("HKLM") ? (v === "OnlineMaps" ? "1" : "https://hklm") : null) }));
    expect(c).toMatchObject({ serverUrl: "https://hklm", onlineMaps: true });
  });
  it("stay off and say so when the setting is not on or off", () => {
    const c = readConfig(sources({}, { [EXE_JSON]: '{"onlineMaps":"maybe"}', [PD_JSON]: '{"onlineMaps":true}' }));
    expect(c.onlineMaps).toBe(false);
    expect(c.problems).toEqual([`${EXE_JSON}: onlineMaps "maybe" is not on or off (use true/false or 1/0); left off.`]);
  });
  it("reports a broken viewer.json once, and fall back to the next place", () => {
    const c = readConfig(sources({}, { [EXE_JSON]: "{nope", [PD_JSON]: '{"onlineMaps":false}' }));
    expect(c.onlineMaps).toBe(false);
    expect(c.problems).toHaveLength(1);
  });
  it("reads switches", () => {
    for (const v of [true, 1, "1", "0x1", "TRUE", " yes ", "on"]) expect(parseSwitch(v)).toBe(true);
    for (const v of [false, 0, "0", "0x0", "false", "no", "off"]) expect(parseSwitch(v)).toBe(false);
    for (const v of [2, "2", "maybe", {}, []]) expect(parseSwitch(v)).toBeNull();
  });
});
