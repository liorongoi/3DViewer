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
 *
 * Online map services (base maps, terrain, WMTS/WMS/XYZ/COG, DTM services the user adds) are on
 * unless IT turns them off, from the same places in the same order: VIEWER_ONLINE_MAPS=0,
 * {"onlineMaps": false} in either viewer.json, or OnlineMaps = 0 under either registry key.
 * On, the page may only read (GET) from the network. Off, the app refuses every network request
 * except to the configured server, for sites with no outbound connections (NFR-12, AC-10).
 */
export interface DesktopConfig {
  serverUrl: string | null;
  /** Where the address came from, for the About box and support. */
  source: string | null;
  /** The page may fetch map tiles and terrain from the network (GET only). */
  onlineMaps: boolean;
  /** Where that setting came from, or null for the default (on). */
  onlineMapsSource: string | null;
  problems: string[];
}

/** Without a setting, online maps work; IT turns them off for a site with no internet (AC-10). */
export const ONLINE_MAPS_DEFAULT = true;

export interface ConfigSources {
  env: Record<string, string | undefined>;
  /** Folder that holds the executable. */
  exeDir: string;
  /** %ProgramData%, or null off Windows. */
  programData: string | null;
  readFile: (p: string) => string | null;
  /** A value (ServerUrl by default) under a registry key, as text, or null. */
  registry: (key: string, value?: string) => string | null;
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
  const json = new Map<string, Record<string, unknown> | null>();
  function readJson(p: string): Record<string, unknown> | null {
    if (json.has(p)) return json.get(p)!;
    const text = src.readFile(p);
    let j: Record<string, unknown> | null = null;
    if (text !== null) {
      try {
        const v = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
        j = v as Record<string, unknown>;
      } catch (e) {
        problems.push(`${p}: ${(e as Error).message}`);
      }
    }
    json.set(p, j);
    return j;
  }
  function fromJson(p: string): string | null {
    const j = readJson(p);
    if (!j) return null;
    try {
      if (j.serverUrl === undefined || j.serverUrl === null || j.serverUrl === "") return null;
      if (typeof j.serverUrl !== "string") throw new Error("serverUrl is not text");
      return j.serverUrl;
    } catch (e) {
      problems.push(`${p}: ${(e as Error).message}`);
      return null;
    }
  }
  let server: { serverUrl: string | null; source: string | null } = { serverUrl: null, source: null };
  for (const [source, get] of candidates) {
    const raw = get();
    if (!raw) continue;
    const url = cleanServerUrl(raw);
    if (url) {
      server = { serverUrl: url, source };
      break;
    }
    problems.push(`${source}: "${raw}" is not an http or https address.`);
  }
  // Online maps: the first place that says yes or no wins; something else there is reported.
  const exeJson = path.join(src.exeDir, "viewer.json");
  const pdJson = src.programData ? path.join(src.programData, "VIEWER", "viewer.json") : null;
  const online: [string, () => unknown][] = [
    ["VIEWER_ONLINE_MAPS", () => src.env.VIEWER_ONLINE_MAPS],
    [exeJson, () => readJson(exeJson)?.onlineMaps],
    ...(pdJson ? ([[pdJson, () => readJson(pdJson)?.onlineMaps]] as [string, () => unknown][]) : []),
    ["HKLM\\Software\\VIEWER", () => src.registry("HKLM\\Software\\VIEWER", "OnlineMaps")],
    ["HKCU\\Software\\VIEWER", () => src.registry("HKCU\\Software\\VIEWER", "OnlineMaps")],
  ];
  for (const [source, get] of online) {
    const raw = get();
    if (raw === undefined || raw === null || raw === "") continue;
    const yes = parseSwitch(raw);
    if (yes !== null) return { ...server, onlineMaps: yes, onlineMapsSource: source, problems };
    problems.push(`${source}: onlineMaps "${String(raw)}" is not on or off (use true/false or 1/0); left off.`);
    return { ...server, onlineMaps: false, onlineMapsSource: source, problems };
  }
  return { ...server, onlineMaps: ONLINE_MAPS_DEFAULT, onlineMapsSource: null, problems };
}

/** true/false, 1/0 (also a registry DWORD read as 0x1/0x0), yes/no, on/off; null for anything else. */
export function parseSwitch(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1 ? true : raw === 0 ? false : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (["1", "0x1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "0x0", "false", "no", "off"].includes(v)) return false;
  return null;
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
    registry: (key, value = "ServerUrl") => {
      if (!windows) return null;
      try {
        const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", timeout: 5000, windowsHide: true });
        return new RegExp(`${value}\\s+REG_(?:EXPAND_SZ|SZ|DWORD)\\s+(.+)`, "i").exec(out)?.[1]?.trim() ?? null;
      } catch {
        return null;
      }
    },
  };
}
