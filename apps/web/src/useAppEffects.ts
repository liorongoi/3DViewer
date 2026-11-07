import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { findModel, refreshLibrary } from "./state/library";
import { findServer, getBaseMaps, getLayerManifest, listLevels, recordView } from "./server/api";
import { readShare } from "./share";
import { setVisible } from "@viewer/core";
import { useEngine } from "./engine";
import { useApp } from "./state/store";
import { useFilteredModels } from "./components/Library";

export function useOpenModel() {
  const engine = useEngine();
  const set = useApp((s) => s.set);
  return {
    open: (id: string) => {
      const m = findModel(id);
      if (!m || !engine) return;
      set({ modelId: id, route: "viewer", tool: "none" });
      const srv = useApp.getState().server;
      const fromServer = srv && !m.id.startsWith("upload-");
      if (fromServer) recordView(srv, m.id);
      void engine.open(m);
      // The producer's layer arrangement, applied as soon as it arrives (the model may still be loading).
      if (fromServer) void getLayerManifest(srv, m.id, m.version).then((man) => man && engine.current.get()?.id === m.id && engine.setLayerManifest(man));
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
  const { t, i18n } = useTranslation();
  // New measurements are named in the interface language.
  useEffect(() => {
    if (!engine) return;
    engine.measure.labelFor = (kind, n) => t(`measureNames.${kind}`, { n });
    engine.measure.snapLabel = (kind, px) =>
        kind === "surface" ? "" : t(kind === "vertex" ? "measure.snapVertex" : "measure.snapEdge", { px: px.toFixed(1) });
    engine.measure.modelUnitName = t("measure.modelUnitName");
    engine.measure.redraw();
  }, [engine, t, i18n.language]);
  const tool = useApp((s) => s.tool);
  const quality = useApp((s) => s.quality);
  const adaptive = useApp((s) => s.adaptiveResolution);
  const environment = useApp((s) => s.environment);
  const memoryGb = useApp((s) => s.memoryGb);
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
    engine.adaptiveResolution = adaptive;
    engine.measure.setUnit(unit);
    engine.setEnvironment(environment);
    engine.setMemoryBudget(memoryGb * 1024 ** 3);
  }, [engine, quality, unit, adaptive, environment, memoryGb]);

  // Look for the VIEWER server once; without one the app keeps the bundled sample library.
  useEffect(() => {
    let live = true;
    void (async () => {
      const server = await findServer();
      if (!live) return;
      useApp.setState({ server });
      if (server) {
        const levels = await listLevels(server).catch(() => null);
        if (levels?.length) useApp.setState({ levels });
        await refreshLibrary().catch(() => useApp.setState({ server: null }));
      }
      if (live) useApp.setState({ libraryReady: true });
    })();
    return () => {
      live = false;
    };
  }, []);
  const libraryReady = useApp((s) => s.libraryReady);

  // The admin's base map sources and defaults (WP 3.9, RND-11), once the engine and server are both up.
  const server = useApp((s) => s.server);
  useEffect(() => {
    if (!engine || !server) return;
    void getBaseMaps(server)
      .then((cfg) => (cfg.sources.length || cfg.hideOnline || cfg.defaultImagery || cfg.defaultTerrain ? engine.useSiteBaseMaps(cfg, server.base) : []))
      .then((problems) => problems.forEach((p) => console.warn(p)))
      .catch(() => undefined);
  }, [engine, server]);

  // A share link opens its model at the shared camera, view mode and layer visibility (WP 4.6).
  useEffect(() => {
    if (!engine || !libraryReady) return;
    const apply = async () => {
      const st = readShare();
      if (!st) return;
      const m = findModel(st.m);
      if (!m) return;
      useApp.getState().set({ modelId: m.id, route: "viewer", tool: "none" });
      const srv = useApp.getState().server;
      const man = srv && !m.id.startsWith("upload-") ? getLayerManifest(srv, m.id, m.version) : null;
      await engine.open(m, { fly: false });
      const arranged = await man;
      if (arranged) engine.setLayerManifest(arranged);
      engine.setView(st.c);
      engine.setViewMode(st.mode);
      if (st.hidden.length) engine.setLayers(st.hidden.reduce((ls, id) => setVisible(ls, id, false), engine.layers.get()));
      history.replaceState(null, "", location.pathname + location.search);
    };
    void apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [engine, libraryReady]);

  useEffect(() => {
    if (!engine) return;
    engine.setPins(models, (id) => open(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, models]);

  useEffect(() => {
    if (!engine) return;
    if (tool !== "sight") engine.sight.cancel();
    if (tool !== "viewshed") engine.viewshed.placing.set(false);
    if (tool === "sight" || tool === "viewshed") {
      engine.fly.disable();
      engine.tour.stop();
      engine.measure.cancel();
      if (tool === "sight") engine.sight.start();
      else engine.viewshed.start();
      useApp.getState().set({ rightOpen: true, rightTab: "analysis" });
    } else if (tool === "distance" || tool === "path") {
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

  // The viewshed tool ends by itself once the observer is placed.
  useEffect(() => {
    if (!engine) return;
    return engine.viewshed.placing.subscribe(() => {
      if (!engine.viewshed.placing.get() && useApp.getState().tool === "viewshed") useApp.getState().set({ tool: "none" });
    });
  }, [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
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
      else if (k === "P" && e.shiftKey) s.set({ perfOpen: !s.perfOpen });
      else if (lower === "h") void engine?.home();
      else if (lower === "z") void engine?.focusSelection();
      else if (k === "M") s.set({ tool: s.tool === "path" ? "none" : "path" });
      else if (k === "m") s.set({ tool: s.tool === "distance" ? "none" : "distance" });
      else if (lower === "g") s.set({ tool: "fly" });
      else if (lower === "i") s.set({ tool: s.tool === "sight" ? "none" : "sight" });
      else if (lower === "v") s.set({ tool: s.tool === "viewshed" ? "none" : "viewshed" });
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
