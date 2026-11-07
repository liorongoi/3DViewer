import { english, hasEnglish, type ModelFormat } from "@viewer/shared";
import type { FileSet, LocalFile } from "./files";

export type Severity = "ok" | "warning" | "error";

/** One line of the upload check report. Every problem is listed, not just the first. */
export interface CheckItem {
  id: "format" | "references" | "structure" | "extensions" | "size" | "georef" | "content" | "conversion" | "scan" | "validator" | "tiling" | "optimise";
  severity: Severity;
  /** English, for logs, the server and as a fallback. */
  title: string;
  detail?: string;
  /** The message's i18n key under checks.*, so the app shows it in the interface language. */
  key?: string;
  params?: Record<string, string | number>;
}

/**
 * A report line from the checks.<key> strings: title, and detail unless one is given (a list of
 * files or an error message, which stays as it is).
 */
export function checkItem(id: CheckItem["id"], severity: Severity, key: string, params: Record<string, string | number> = {}, detail?: string): CheckItem {
  const d = detail ?? (hasEnglish(`checks.${key}.detail`) ? english(`checks.${key}.detail`, params) : undefined);
  return { id, severity, title: english(`checks.${key}.title`, params), ...(d ? { detail: d } : {}), key, ...(Object.keys(params).length ? { params } : {}) };
}

export interface CheckReport {
  loader: string | null;
  format: ModelFormat | null;
  mainFile: string | null;
  items: CheckItem[];
  /** False when any item is an error. */
  ok: boolean;
  stats: {
    files: number;
    bytes: number;
    triangles?: number;
    textures?: number;
    tiles?: number;
    contents?: number;
    /** Extent along the file's x, y, z, in file units (metres for glTF). */
    size?: [number, number, number];
  };
  /** Node names for the Layers step. */
  nodes: string[];
  /** Earth position the model carries itself (3D Tiles transform, CESIUM_RTC, ECEF node), if any. */
  georef: { lat: number; lon: number; height: number } | null;
  /**
   * Position for the Place step read from a file beside the model (ContextCapture metadata.xml):
   * the model origin in a coordinate system, with the model's axes along that system's grid.
   */
  filePosition?: { epsg: number; x: number; y: number; height: number; source: string } | null;
}

export interface Prepared {
  kind: "glb" | "3dtiles";
  url: string;
  /** Frees the object URLs. */
  release(): void;
}

/** A format plugin (WP 1.1). Adding a format means adding one of these, nothing else. */
export interface LoaderPlugin {
  id: string;
  format: ModelFormat;
  /** Picks the file that the set opens with, or null when the plugin cannot read the set. */
  main(files: FileSet): LocalFile | null;
  check(main: LocalFile, files: FileSet): Promise<Omit<CheckReport, "loader" | "format" | "mainFile" | "ok">>;
  /** Makes the set loadable by the engine. Absent when the browser cannot open it (FBX needs the server). */
  prepare?(main: LocalFile, files: FileSet, urls: UrlMaker): Promise<string>;
}

export type UrlMaker = (data: Uint8Array | string, type?: string) => string;
