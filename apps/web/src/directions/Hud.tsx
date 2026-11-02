import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCoordinate } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { ModelCard, SearchField, useFilteredModels } from "../components/Library";
import { LayersPanel } from "../components/LayersPanel";
import { SidePanel } from "../components/SidePanel";
import { Dock } from "../components/Dock";
import { HintLine, ScaleBar, ViewCube } from "../components/Hud";
import { StatusBadge, cx } from "../components/primitives";
import { Command, Globe, HelpCircle, Layers, Plane, Ruler, Search, Upload, Video } from "./parts";
import { LoadingAndError } from "./Earth";

/**
 * Direction C: Minimal HUD. The view is everything. A hairline rail on one edge,
 * a spotlight search in the middle, and tools that fade away while you work.
 */
export function HudDirection() {
  const { t } = useTranslation();
  const engine = useEngine();
  const route = useApp((s) => s.route);
  const set = useApp((s) => s.set);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const rightTab = useApp((s) => s.rightTab);
  const tool = useApp((s) => s.tool);
  const models = useFilteredModels();
  const { open, close } = useOpenModel();
  const loading = useSignal(engine?.loading, false);
  const error = useSignal(engine?.error, null);
  const model = useSignal(engine?.current, null);
  const cursor = useSignal(engine?.cursor, null);
  const system = useApp((s) => s.coordSystem);
  const [idle, setIdle] = useState(false);
  const [spot, setSpot] = useState(false);

  // Chrome fades after 2.5 s without pointer movement, and returns instantly on move.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 2500);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    wake();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
  const fade = cx("transition-opacity duration-300", idle && tool === "none" && !leftOpen && !rightOpen ? "opacity-0" : "opacity-100");
  const coord = cursor ? formatCoordinate(cursor.lat, cursor.lon, cursor.height, system) : null;

  const rail: { id: string; label: string; icon: typeof Layers; active: boolean; on: () => void; disabled?: boolean }[] = [
    { id: "search", label: t("common.search"), icon: Search, active: spot, on: () => setSpot(!spot) },
    { id: "layers", label: t("viewer.layers"), icon: Layers, active: leftOpen, on: () => set({ leftOpen: !leftOpen }), disabled: route !== "viewer" },
    { id: "measure", label: t("viewer.measurements"), icon: Ruler, active: rightOpen && rightTab === "measure", on: () => set({ rightOpen: !(rightOpen && rightTab === "measure"), rightTab: "measure" }), disabled: route !== "viewer" },
    { id: "tours", label: "Fly-by", icon: Video, active: rightOpen && rightTab === "tours", on: () => set({ rightOpen: !(rightOpen && rightTab === "tours"), rightTab: "tours" }), disabled: route !== "viewer" },
    { id: "fly", label: "Fly mode", icon: Plane, active: tool === "fly", on: () => set({ tool: tool === "fly" ? "none" : "fly" }) },
    { id: "upload", label: t("library.upload"), icon: Upload, active: false, on: () => set({ uploadOpen: true }) },
    { id: "palette", label: "Command palette · Ctrl+K", icon: Command, active: false, on: () => set({ paletteOpen: true }) },
    { id: "help", label: t("viewer.help"), icon: HelpCircle, active: false, on: () => set({ helpOpen: true }) },
  ];

  return (
    <>
      {/* hairline rail */}
      <nav aria-label="Tools" className={cx("fixed start-0 top-1/2 z-20 -translate-y-1/2 flex flex-col gap-0.5 rounded-e-[12px] bg-black/35 p-1 backdrop-blur-md", fade)}>
        {rail.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-label={r.label}
            data-tip={r.label}
            disabled={r.disabled}
            onClick={r.on}
            className={cx(
              "tip relative grid h-9 w-9 place-items-center rounded-[8px] disabled:opacity-25",
              r.active ? "text-accent bg-white/5" : "text-white/70 hover:text-white",
            )}
          >
            {r.active && <span className="absolute start-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
            <r.icon size={18} />
          </button>
        ))}
      </nav>

      {/* model identity: a whisper at the top */}
      {model && (
        <div className={cx("fixed inset-x-0 top-16 z-20 flex justify-center pointer-events-none", fade)}>
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/40 ps-1 pe-3 py-1 backdrop-blur-md">
            <button type="button" onClick={close} className="grid h-7 w-7 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white" aria-label="Back to Earth">
              <Globe size={15} />
            </button>
            <span className="font-medium text-white/90">{model.name}</span>
            <StatusBadge status={model.status} compact />
          </div>
        </div>
      )}

      {/* spotlight search (home, or on demand) */}
      {(route === "home" || spot) && (
        <div className="fixed inset-x-0 top-[18vh] z-30 flex justify-center pointer-events-none">
          <div className="glass pointer-events-auto w-[560px] max-w-[92vw] rounded-[16px] p-3">
            <SearchField autoFocus />
            <div className="mt-2 max-h-[46vh] space-y-2 overflow-auto scrollbar-thin">
              {models.map((m) => (
                <ModelCard
                  key={m.id}
                  m={m}
                  dense
                  onOpen={() => {
                    setSpot(false);
                    open(m.id);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {leftOpen && route === "viewer" && (
        <div className="fixed start-14 top-7 bottom-7 z-20 flex">
          <LayersPanel className="min-h-0" onClose={() => set({ leftOpen: false })} />
        </div>
      )}
      {rightOpen && route === "viewer" && (
        <div className="fixed end-3 top-[140px] bottom-7 z-20 flex">
          <SidePanel className="min-h-0" onClose={() => set({ rightOpen: false })} />
        </div>
      )}

      <div className={cx("fixed end-3 top-7 z-20", fade)}>
        <ViewCube />
      </div>

      {/* bottom: dock shows on demand; coordinates as plain text */}
      <div className={cx("fixed inset-x-0 bottom-7 z-10 flex flex-col items-center gap-2 pointer-events-none", fade)}>
        <HintLine />
        {route === "viewer" && <Dock className="pointer-events-auto" />}
      </div>
      <div className={cx("fixed start-14 bottom-7 z-10 pointer-events-none", fade)}>
        <ScaleBar />
        <div className="num mt-1 text-[12px] text-white/85 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]" dir="ltr">
          {coord ? coord.parts.join("   ") : ""}
        </div>
      </div>
      <LoadingAndError loading={loading} error={error} onBack={close} />
    </>
  );
}
