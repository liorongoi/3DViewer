import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Where the desktop app finds the library server (WP 5.4, plan 2.3). The IT team sets it once
 * per machine, by whichever of these fits their tooling; the first one found wins:
 *
 * 1. VIEWER_SERVER_URL in the environment (testing, or a launcher script);
 * 2. viewer.json next to HOLO.exe: {"serverUrl": "https://viewer.internal"} (the installer
 *    writes it when given SERVER_URL=...);
 * 3. %ProgramData%\VIEWER\viewer.json, the same file for every user of the machine;
 * 4. the registry: ServerUrl under HKLM\Software\VIEWER, then HKCU\Software\VIEWER (Group Policy).
 *
 * With none, the app works on local files only. An address that is not http(s) is ignored and
 * reported, so a typo shows up in the app's About box instead of failing quietly.
 */
export interface DesktopConfig {
  serverUrl: string | null;
  /** Where the address came from, for the About box and support. */
  source: string | null;
  problems: string[];
}

export interface ConfigSources {
  env: Record<string, string | undefined>;
  /** Folder that holds the executable. */
  exeDir: string;
  /** %ProgramData%, or null off Windows. */
  programData: string | null;
  readFile: (p: string) => string | null;
  /** ServerUrl under a registry key, or null. */
  registry: (key: string) => string | null;
}

/** The address as an origin with an optional path prefix, without a trailing slash; null if unusable. */
export function cleanServerUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export function readConfig(src: ConfigSources): DesktopConfig {
  const problems: string[] = [];
  const candidates: [string, () => string | null][] = [
    ["VIEWER_SERVER_URL", () => src.env.VIEWER_SERVER_URL ?? null],
    [path.join(src.exeDir, "viewer.json"), () => fromJson(path.join(src.exeDir, "viewer.json"))],
    ...(src.programData ? ([[path.join(src.programData, "VIEWER", "viewer.json"), () => fromJson(path.join(src.programData!, "VIEWER", "viewer.json"))]] as [string, () => string | null][]) : []),
    ["HKLM\\Software\\VIEWER", () => src.registry("HKLM\\Software\\VIEWER")],
    ["HKCU\\Software\\VIEWER", () => src.registry("HKCU\\Software\\VIEWER")],
  ];
  function fromJson(p: string): string | null {
    const text = src.readFile(p);
    if (text === null) return null;
    try {
      const j = JSON.parse(text.replace(/^\uFEFF/, "")) as { serverUrl?: unknown };
      if (j.serverUrl === undefined || j.serverUrl === null || j.serverUrl === "") return null;
      if (typeof j.serverUrl !== "string") throw new Error("serverUrl is not text");
      return j.serverUrl;
    } catch (e) {
      problems.push(`${p}: ${(e as Error).message}`);
      return null;
    }
  }
  for (const [source, get] of candidates) {
    const raw = get();
    if (!raw) continue;
    const url = cleanServerUrl(raw);
    if (url) return { serverUrl: url, source, problems };
    problems.push(`${source}: "${raw}" is not an http or https address.`);
  }
  return { serverUrl: null, source: null, problems };
}

/** The real sources on this machine. */
export function machineSources(exeDir: string): ConfigSources {
  const windows = process.platform === "win32";
  return {
    env: process.env,
    exeDir,
    programData: windows ? (process.env.ProgramData ?? "C:\\ProgramData") : null,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    registry: (key) => {
      if (!windows) return null;
      try {
        const out = execFileSync("reg", ["query", key, "/v", "ServerUrl"], { encoding: "utf8", timeout: 5000, windowsHide: true });
        return /ServerUrl\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out)?.[1]?.trim() ?? null;
      } catch {
        return null;
      }
    },
  };
}
