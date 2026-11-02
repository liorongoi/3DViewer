import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { FilterChips, ModelCard, SearchField, useFilteredModels } from "../components/Library";
import { LayersPanel } from "../components/LayersPanel";
import { SidePanel } from "../components/SidePanel";
import { Dock } from "../components/Dock";
import { CoordinatesHud, HintLine, ScaleBar, ViewCube } from "../components/Hud";
import { ModelHeader } from "../components/ModelHeader";
import { FeaturePopup } from "../components/FeaturePopup";
import { Globe, Layers, PanelIcon, Ruler, Upload } from "./parts";
import { IconButton, cx } from "../components/primitives";
import { fadeClasses, useChromeFade } from "./useChromeFade";

/**
 * The workspace (chosen direction: A + C). A Google Earth-style globe is home; every model
 * sits where it is in the world. Search on the left, fly in, tools float around the model
 * and fade away while you look or navigate, so the view keeps the whole screen.
 */
export function Workspace() {
  const { t } = useTranslation();
  const engine = useEngine();
  const route = useApp((s) => s.route);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const fullscreen = useApp((s) => s.fullscreen);
  const set = useApp((s) => s.set);
  const models = useFilteredModels();
  const { open, close } = useOpenModel();
  const loading = useSignal(engine?.loading, false);
  const error = useSignal(engine?.error, null);
  const top = "top-7"; // below the 20 px classification banner
  const bottom = "bottom-7";
  const fade = fadeClasses(useChromeFade());
  if (fullscreen) return <FullscreenHint />;

  return (
    <>
      {/* left column */}
      <div className={cx("pointer-events-none fixed start-3 z-20 flex flex-col gap-2", top, bottom)}>
        {route === "home" ? (
          leftOpen ? (
            <section className={cx("glass pointer-events-auto flex w-[360px] min-h-0 flex-col rounded-[14px]", fade.panel)}>
              <div className="flex items-center gap-2 px-3 pt-3">
                <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-accent-on">
                  <Globe size={16} />
                </span>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold tracking-wide">VIEWER</div>
                  <div className="text-[11px] text-fg3">{t("library.count", { count: models.length })}</div>
                </div>
                <IconButton size="sm" label={t("library.upload")} onClick={() => set({ uploadOpen: true })}>
                  <Upload size={16} />
                </IconButton>
                <IconButton size="sm" label={t("common.close")} shortcut="L" onClick={() => set({ leftOpen: false })}>
                  <PanelIcon size={16} />
                </IconButton>
              </div>
              <div className="p-3 pb-2">
                <SearchField autoFocus />
              </div>
              <FilterChips className="px-3 pb-3" />
              <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3 scrollbar-thin">
                {models.map((m) => (
                  <ModelCard key={m.id} m={m} dense onOpen={() => open(m.id)} />
                ))}
              </div>
            </section>
          ) : (
            <button type="button" className={cx("glass pointer-events-auto flex h-11 items-center gap-2 rounded-[12px] px-3", fade.ambient)} onClick={() => set({ leftOpen: true })}>
              <Globe size={16} className="text-accent" />
              <span className="font-semibold">VIEWER</span>
              <span className="text-fg3">· {t("common.search")}</span>
            </button>
          )
        ) : (
          <>
            <ModelHeader onBack={close} backLabel="Earth" className={cx("pointer-events-auto", fade.panel)} />
            {leftOpen && <LayersPanel className={cx("pointer-events-auto min-h-0 !w-[300px]", fade.panel)} onClose={() => set({ leftOpen: false })} />}
          </>
        )}
      </div>

      {/* right column */}
      <div className={cx("pointer-events-none fixed end-3 z-20 flex flex-col items-end gap-2 bottom-[120px]", top)}>
        <ViewCube className={cx("pointer-events-auto", fade.ambient)} />
        <div className={cx("pointer-events-auto flex flex-col gap-1", fade.ambient)}>
          {route === "viewer" && !leftOpen && (
            <IconButton className="glass" label={t("viewer.layers")} shortcut="L" onClick={() => set({ leftOpen: true })}>
              <Layers size={18} />
            </IconButton>
          )}
          {route === "viewer" && !rightOpen && (
            <IconButton className="glass" label={t("viewer.measurements")} shortcut="." onClick={() => set({ rightOpen: true })}>
              <Ruler size={18} />
            </IconButton>
          )}
        </div>
        {route === "viewer" && rightOpen && <SidePanel className={cx("pointer-events-auto min-h-0", fade.panel)} onClose={() => set({ rightOpen: false })} />}
      </div>

      {/* bottom */}
      <div className={cx("pointer-events-none fixed inset-x-0 z-10 flex flex-col items-center gap-2", bottom, fade.ambient)}>
        <HintLine />
        <Dock className="pointer-events-auto" />
      </div>
      <div className={cx("pointer-events-none fixed z-10 flex flex-col items-end gap-2 end-3", bottom, fade.ambient)}>
        <ScaleBar />
        <CoordinatesHud className="pointer-events-auto" />
      </div>

      <FeaturePopup />
      <LoadingAndError loading={loading} error={error} onBack={close} />
    </>
  );
}

export function LoadingAndError({ loading, error, onBack }: { loading: boolean; error: { file: string; reason: string; detail: string } | null; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      {loading && <div className="fixed inset-x-0 top-5 z-30 h-0.5 overflow-hidden"><div className="h-full w-1/3 animate-[load_1.1s_ease-in-out_infinite] bg-accent" /></div>}
      {error && (
        <div className="fixed inset-0 z-30 grid place-items-center pointer-events-none">
          <div role="alert" className="glass pointer-events-auto w-[420px] rounded-[14px] p-5">
            <div className="mb-1 text-[15px] font-semibold">{t("viewer.error.title")}</div>
            <div className="num mb-2 text-[12px] text-fg3">{error.file}</div>
            <p className="mb-3 text-fg2">{error.reason}</p>
            <details className="mb-4 text-[12px] text-fg3">
              <summary className="cursor-pointer">{t("viewer.error.details")}</summary>
              <pre className="num mt-1 whitespace-pre-wrap">{error.detail}</pre>
            </details>
            <button type="button" className="btn-primary" onClick={onBack}>{t("viewer.error.backToLibrary")}</button>
          </div>
        </div>
      )}
    </>
  );
}

export function FullscreenHint() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-7 z-10 flex justify-center">
      <span className="rounded-full bg-black/50 px-3 py-1 text-[12px] text-white/80">Full screen · press F to show the tools</span>
    </div>
  );
}
