import { useEffect } from "react";
import { SAMPLE_LIBRARY } from "@viewer/shared";
import { useEngine } from "./engine";
import { useApp } from "./state/store";
import { useFilteredModels } from "./components/Library";

export function useOpenModel() {
  const engine = useEngine();
  const set = useApp((s) => s.set);
  return {
    open: (id: string) => {
      const m = SAMPLE_LIBRARY.find((x) => x.id === id);
      if (!m || !engine) return;
      set({ modelId: id, route: "viewer", tool: "none" });
      void engine.open(m);
    },
    close: () => {
      engine?.close();
      set({ modelId: null, route: "home", tool: "none" });
      engine?.flyHome(1.4);
    },
  };
}

/** Wires app state to the engine and installs the global keyboard shortcuts (SRS 5.1). */
export function useAppEffects(): void {
  const engine = useEngine();
  const tool = useApp((s) => s.tool);
  const quality = useApp((s) => s.quality);
  const unit = useApp((s) => s.unit);
  const theme = useApp((s) => s.theme);
  const models = useFilteredModels();
  const { open } = useOpenModel();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!engine) return;
    engine.setQuality(quality);
    engine.measure.setUnit(unit);
  }, [engine, quality, unit]);

  useEffect(() => {
    if (!engine) return;
    engine.setPins(models, (id) => open(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, models]);

  useEffect(() => {
    if (!engine) return;
    if (tool === "distance" || tool === "path") {
      engine.fly.disable();
      engine.tour.stop();
      engine.measure.start(tool);
      useApp.getState().set({ rightOpen: true, rightTab: "measure" });
    } else if (tool === "fly") {
      engine.measure.cancel();
      engine.tour.stop();
      engine.fly.enable();
    } else {
      engine.measure.cancel();
      engine.fly.disable();
    }
  }, [engine, tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable]");
      const s = useApp.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.set({ paletteOpen: !s.paletteOpen });
        return;
      }
      if (typing || s.paletteOpen) return;
      if (e.key === "Escape") {
        if (s.helpOpen) return s.set({ helpOpen: false });
        if (s.tool !== "none") return s.set({ tool: "none" });
        engine?.tour.stop();
        return;
      }
      if (s.tool === "fly") return; // WASD/QE belong to fly mode
      if (s.tool === "path" && (e.key === "Enter" || e.key === "Backspace")) {
        if (e.key === "Enter") engine?.measure.finish();
        else engine?.measure.removeLastPoint();
        e.preventDefault();
        return;
      }
      if (engine?.camera.handleKey(e)) {
        e.preventDefault();
        return;
      }
      const k = e.key;
      const lower = k.toLowerCase();
      if (k === "?") s.set({ helpOpen: !s.helpOpen });
      else if (lower === "h") void engine?.home();
      else if (lower === "z") void engine?.home(0.8);
      else if (k === "M") s.set({ tool: s.tool === "path" ? "none" : "path" });
      else if (k === "m") s.set({ tool: s.tool === "distance" ? "none" : "distance" });
      else if (lower === "g") s.set({ tool: "fly" });
      else if (lower === "w" && engine) { engine.camera.leftDrag = "orbit"; s.set({ tool: "none" }); }
      else if (lower === "e" && engine) { engine.camera.leftDrag = "pan"; s.set({ tool: "none" }); }
      else if (lower === "l") s.set({ leftOpen: !s.leftOpen });
      else if (k === ".") s.set({ rightOpen: !s.rightOpen });
      else if (lower === "f") s.set({ fullscreen: !s.fullscreen });
      else if (["1", "2", "3", "4"].includes(k)) engine?.setViewMode((["shaded", "edges", "wireframe", "unlit"] as const)[Number(k) - 1]!);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);
}
