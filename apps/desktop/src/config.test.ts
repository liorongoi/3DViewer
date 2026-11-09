import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanServerUrl, readConfig, type ConfigSources } from "./config";

// Built with path.join, as the code does, so the test also runs on Windows.
const EXE_JSON = path.join("/app", "viewer.json");
const PD_JSON = path.join("/pd", "VIEWER", "viewer.json");
const sources = (over: Partial<ConfigSources> = {}, files: Record<string, string> = {}, reg: Record<string, string> = {}): ConfigSources => ({
  env: {},
  exeDir: "/app",
  programData: "/pd",
  readFile: (p) => files[p] ?? null,
  registry: (k) => reg[k] ?? null,
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
    expect(readConfig(sources())).toEqual({ serverUrl: null, source: null, problems: [] });
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
