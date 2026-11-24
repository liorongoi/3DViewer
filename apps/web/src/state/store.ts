import { create } from "zustand";
import type { CoordinateSystem, EnvironmentId, LengthUnit, Quality, ViewMode } from "@viewer/core";
import { SAMPLE_CLASSIFICATIONS, type ClassificationLevel, type ModelSummary, type UpdateStatus } from "@viewer/shared";
import { readPref, writePref } from "./prefs";
import type { VersionInfo } from "../server/api";
import { desktop } from "../desktop";

export type Route = "home" | "viewer";
export type Tool = "none" | "distance" | "path" | "fly" | "sight" | "viewshed";

export interface Filters {
  query: string;
  project: string | null;
  operation: string | null;
  status: UpdateStatus | null;
  entity: string | null;
  classification: string | null;
}

interface AppState {
  /** Tools fade while the view is idle or being navigated (UI direction A + C). */
  fadeTools: boolean;
  route: Route;
  modelId: string | null;
  theme: "dark" | "light";
  lang: "en" | "he";
  coordSystem: CoordinateSystem;
  /** The UTM zone to show: "auto" takes the open model's zone (MSR-08), else "1" to "60". */
  utmZone: string;
  unit: LengthUnit;
  quality: Quality;
  /** Lighting environment (WP 1.4). */
  environment: EnvironmentId;
  /** GPU memory for 3D Tiles, in GB (WP 1.5). */
  memoryGb: number;
  viewMode: ViewMode;
  tool: Tool;
  shadows: boolean;
  imagery: boolean;
  globe: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: "measure" | "props" | "tours" | "analysis";
  leftTab: "model" | "map";
  libraryView: "grid" | "globe";
  paletteOpen: boolean;
  helpOpen: boolean;
  /** The user manual (WP 6.6). */
  manualOpen: boolean;
  uploadOpen: boolean;
  /** The "Make a splat" wizard (docs/GAUSSIAN_SPLATS.md). */
  captureOpen: boolean;
  /** "Build on this PC" (HOLO for Windows with the building add-on). */
  localBuildOpen: boolean;
  /** The admin page (WP 3.9). */
  adminOpen: boolean;
  /** Performance overlay (Shift+P). */
  perfOpen: boolean;
  adaptiveResolution: boolean;
  fullscreen: boolean;
  onboardingDone: boolean;
  filters: Filters;
  /** Classification chosen by the user per model id (overrides the library value). */
  classOverrides: Record<string, string>;
  /** Models uploaded in this browser session (kept in memory until the server stores them, Phase 3). */
  uploads: ModelSummary[];
  /** The viewer-file:// URLs each of those was opened from on this computer (desktop app), by model id. */
  uploadFiles: Record<string, string[]>;
  /** The model the delete dialog is asking about. */
  deleteModelId: string | null;
  /** The bundled sample library is shown (the web app; the Windows app only in its checks). */
  samples: boolean;
  /** Kept models whose files are no longer on this computer (desktop app). */
  missingModels: string[];
  /** Online maps in the desktop app: on now, and whether IT decided (no switch then). Null in a browser. */
  onlineMaps: { on: boolean; locked: boolean } | null;
  /** What the left column shows on the globe: the library or the Map & data panel. */
  homePanel: "library" | "map";
  /** The HOLO server, when one answers (Phase 3). Without it the app uses the sample library. */
  server: import("../server/api").ServerInfo | null;
  /**
   * Server reachability (WP 5.4): "none" when no server is configured, so there is nothing to
   * show; "offline" when the configured one does not answer (local mode, checked again often).
   */
  serverState: "none" | "online" | "offline";
  /** Files opened from outside the wizard (desktop open, Explorer, a drop), for the wizard to take. */
  pendingFiles: { files: import("@viewer/core").LocalFile[]; keepLocal: boolean } | null;
  /** The server's library, when there is a server. */
  serverModels: ModelSummary[];
  /** The open server model's versions, newest first (WP 4.4); read when the model is opened. */
  versionHistory: { id: string; list: VersionInfo[] } | null;
  /** True once the server lookup has finished, with or without a server. */
  libraryReady: boolean;
  /** Classification levels, lowest first: the admin's from the server, or the prototype set. */
  levels: ClassificationLevel[];
  addUpload: (m: ModelSummary, files?: string[]) => void;
  /** Takes a model of this session out of the library. */
  removeUpload: (id: string) => void;
  setClassification: (modelId: string, classificationId: string) => void;
  set: (patch: Partial<AppState>) => void;
  setPref: <K extends "theme" | "lang" | "coordSystem" | "utmZone" | "unit" | "quality" | "environment" | "memoryGb" | "fadeTools" | "adaptiveResolution">(k: K, v: AppState[K]) => void;
  setFilters: (patch: Partial<Filters>) => void;
}

export const useApp = create<AppState>((set) => ({
  fadeTools: readPref<string>("fadeTools", "true") === "true",
  route: "home",
  modelId: null,
  theme: readPref<"dark" | "light">("theme", "dark"),
  lang: readPref<"en" | "he">("lang", "en"),
  coordSystem: readPref<CoordinateSystem>("coordSystem", "wgs84"),
  utmZone: readPref<string>("utmZone", "auto"),
  unit: readPref<LengthUnit>("unit", "m"),
  quality: readPref<Quality>("quality", "high"),
  environment: readPref<EnvironmentId>("environment", "atmosphere"),
  // NFR-04: 10 GB of the A4000's 16 GB by default.
  memoryGb: Number(readPref<string>("memoryGb", "10")) || 10,
  viewMode: "shaded",
  tool: "none",
  shadows: true,
  imagery: true,
  globe: true,
  leftOpen: true,
  rightOpen: false,
  rightTab: "measure",
  leftTab: "model",
  libraryView: "grid",
  paletteOpen: false,
  helpOpen: false,
  manualOpen: false,
  uploadOpen: false,
  captureOpen: false,
  localBuildOpen: false,
  adminOpen: false,
  perfOpen: false,
  // Off by default: stepping the resolution down while the view moves makes the picture go soft
  // and sharp again during a zoom on slower graphics cards (the 1.3.1 Windows report).
  adaptiveResolution: readPref<string>("adaptiveResolution", "false") === "true",
  fullscreen: false,
  onboardingDone: readPref<string>("onboarding", "0") === "1",
  filters: { query: "", project: null, operation: null, status: null, entity: null, classification: null },
  classOverrides: (() => {
    try {
      return JSON.parse(readPref<string>("classOverrides", "{}")) as Record<string, string>;
    } catch {
      return {};
    }
  })(),
  uploads: [],
  uploadFiles: {},
  deleteModelId: null,
  samples: !desktop,
  missingModels: [],
  onlineMaps: null,
  homePanel: "library",
  server: null,
  serverState: "none",
  pendingFiles: null,
  serverModels: [],
  versionHistory: null,
  libraryReady: false,
  levels: SAMPLE_CLASSIFICATIONS,
  addUpload: (m, files) =>
    set((s) => ({
      uploads: [m, ...s.uploads.filter((x) => x.id !== m.id)],
      ...(files ? { uploadFiles: { ...s.uploadFiles, [m.id]: files } } : {}),
    })),
  removeUpload: (id) =>
    set((s) => {
      const { [id]: _gone, ...uploadFiles } = s.uploadFiles;
      return { uploads: s.uploads.filter((x) => x.id !== id), uploadFiles };
    }),
  setClassification: (modelId, classificationId) =>
    set((s) => {
      const classOverrides = { ...s.classOverrides, [modelId]: classificationId };
      writePref("classOverrides", JSON.stringify(classOverrides));
      return { classOverrides };
    }),
  set: (patch) => set(patch),
  setPref: (k, v) => {
    writePref(k, String(v));
    set({ [k]: v } as Partial<AppState>);
  },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
}));
