import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { FilterChips, LibraryGrid, SearchField, useFilteredModels } from "../components/Library";
import { LayersPanel } from "../components/LayersPanel";
import { SidePanel } from "../components/SidePanel";
import { Dock } from "../components/Dock";
import { CoordinatesHud, HintLine, ScaleBar, ViewCube } from "../components/Hud";
import { ModelHeader } from "../components/ModelHeader";
import { Segmented, IconButton } from "../components/primitives";
import { Command, Globe, LayoutGrid, Layers, Ruler, Upload } from "./parts";
import { FullscreenHint, LoadingAndError } from "./Earth";

/**
 * Direction B: Night Instrument. Library first (card grid or globe), then a model-first
 * viewer: floating glass panels around a full-bleed canvas.
 */
export function InstrumentDirection() {
  const { t } = useTranslation();
  const engine = useEngine();
  const route = useApp((s) => s.route);
  const view = useApp((s) => s.libraryView);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const fullscreen = useApp((s) => s.fullscreen);
  const set = useApp((s) => s.set);
  const models = useFilteredModels();
  const { open, close } = useOpenModel();
  const loading = useSignal(engine?.loading, false);
  const error = useSignal(engine?.error, null);

  if (route === "home") {
    return (
      <div className={view === "grid" ? "fixed inset-x-0 top-5 bottom-5 z-20 overflow-auto bg-canvas scrollbar-thin" : "pointer-events-none fixed inset-x-0 top-5 bottom-5 z-20"}>
        <div className={view === "grid" ? "mx-auto max-w-[1440px] px-8 pb-6 pt-16" : "pointer-events-auto mx-auto mt-14 w-fit"}>
          <header className={view === "grid" ? "mb-5 flex flex-wrap items-center gap-4" : "glass flex items-center gap-3 rounded-[14px] p-2"}>
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-accent-on font-bold">V</span>
              <div>
                <h1 className="text-[18px] font-semibold leading-6">{t("library.title")}</h1>
                {view === "grid" && <div className="text-[12px] text-fg3">{t("library.count", { count: models.length })}</div>}
              </div>
            </div>
            <SearchField className={view === "grid" ? "flex-1 min-w-[320px] max-w-xl" : "w-[420px]"} />
            <Segmented
              label="View"
              value={view}
              onChange={(v) => set({ libraryView: v })}
              options={[
                { value: "grid", label: <span className="inline-flex items-center gap-1"><LayoutGrid size={13} />{t("library.grid")}</span> },
                { value: "globe", label: <span className="inline-flex items-center gap-1"><Globe size={13} />{t("library.globe")}</span> },
              ]}
            />
            <IconButton label="Command palette" shortcut="Ctrl+K" onClick={() => set({ paletteOpen: true })}>
              <Command size={16} />
            </IconButton>
            <button type="button" className="btn-primary" onClick={() => set({ uploadOpen: true })}>
              <Upload size={15} /> {t("library.upload")}
            </button>
          </header>
          {view === "grid" ? (
            <>
              <FilterChips className="mb-5" />
              <LibraryGrid onOpen={open} />
            </>
          ) : (
            <FilterChips className="glass mt-2 rounded-[12px] p-2" />
          )}
        </div>
      </div>
    );
  }

  if (fullscreen) return <FullscreenHint />;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-3 top-16 z-20 flex justify-center">
        <ModelHeader onBack={close} backLabel={t("library.title")} className="pointer-events-auto" />
      </div>
      <div className="pointer-events-none fixed start-3 top-[124px] bottom-7 z-20 flex flex-col gap-2">
        {leftOpen ? (
          <LayersPanel className="pointer-events-auto min-h-0" onClose={() => set({ leftOpen: false })} />
        ) : (
          <IconButton className="glass pointer-events-auto" label={t("viewer.layers")} shortcut="L" onClick={() => set({ leftOpen: true })}>
            <Layers size={18} />
          </IconButton>
        )}
      </div>
      <div className="pointer-events-none fixed end-3 top-7 bottom-[120px] z-20 flex flex-col items-end gap-2">
        <ViewCube className="pointer-events-auto" />
        {rightOpen ? (
          <SidePanel className="pointer-events-auto min-h-0" onClose={() => set({ rightOpen: false })} />
        ) : (
          <IconButton className="glass pointer-events-auto" label={t("viewer.measurements")} shortcut="." onClick={() => set({ rightOpen: true })}>
            <Ruler size={18} />
          </IconButton>
        )}
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-7 z-10 flex flex-col items-center gap-2">
        <HintLine />
        <Dock className="pointer-events-auto" />
      </div>
      <div className="pointer-events-none fixed end-3 bottom-7 z-10 flex flex-col items-end gap-2">
        <ScaleBar />
        <CoordinatesHud className="pointer-events-auto" />
      </div>
      <LoadingAndError loading={loading} error={error} onBack={close} />
    </>
  );
}
