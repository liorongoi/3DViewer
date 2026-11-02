import { create } from "zustand";
import type { CoordinateSystem, LengthUnit, Quality, ViewMode } from "@viewer/core";
import type { UpdateStatus } from "@viewer/shared";
import { readPref, writePref } from "./prefs";

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
  unit: LengthUnit;
  quality: Quality;
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
  uploadOpen: boolean;
  fullscreen: boolean;
  onboardingDone: boolean;
  filters: Filters;
  set: (patch: Partial<AppState>) => void;
  setPref: <K extends "theme" | "lang" | "coordSystem" | "unit" | "quality" | "fadeTools">(k: K, v: AppState[K]) => void;
  setFilters: (patch: Partial<Filters>) => void;
}

export const useApp = create<AppState>((set) => ({
  fadeTools: readPref<string>("fadeTools", "true") === "true",
  route: "home",
  modelId: null,
  theme: readPref<"dark" | "light">("theme", "dark"),
  lang: readPref<"en" | "he">("lang", "en"),
  coordSystem: readPref<CoordinateSystem>("coordSystem", "wgs84"),
  unit: readPref<LengthUnit>("unit", "m"),
  quality: readPref<Quality>("quality", "high"),
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
  uploadOpen: false,
  fullscreen: false,
  onboardingDone: readPref<string>("onboarding", "0") === "1",
  filters: { query: "", project: null, operation: null, status: null, entity: null, classification: null },
  set: (patch) => set(patch),
  setPref: (k, v) => {
    writePref(k, String(v));
    set({ [k]: v } as Partial<AppState>);
  },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
}));
