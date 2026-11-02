import type { ModelFormat } from "@viewer/shared";
import type { FileSet, LocalFile } from "./files";

export type Severity = "ok" | "warning" | "error";

/** One line of the upload check report. Every problem is listed, not just the first. */
export interface CheckItem {
  id: "format" | "references" | "structure" | "extensions" | "size" | "georef" | "content" | "conversion" | "scan";
  severity: Severity;
  title: string;
  detail?: string;
}

export interface CheckReport {
  loader: string | null;
  format: ModelFormat | null;
  mainFile: string | null;
  items: CheckItem[];
  /** False when any item is an error. */
  ok: boolean;
  stats: { files: number; bytes: number; triangles?: number; textures?: number; tiles?: number; contents?: number };
  /** Node names for the Layers step. */
  nodes: string[];
  /** Position found in the file, if any. */
  georef: { lat: number; lon: number; height: number } | null;
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
