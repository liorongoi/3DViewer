import { useTranslation } from "react-i18next";
import { SAMPLE_CLASSIFICATIONS, SAMPLE_LIBRARY } from "@viewer/shared";
import { useEngine, useSignal } from "./engine";
import { useApp, type Direction } from "./state/store";
import { useAppEffects, useOpenModel } from "./useAppEffects";
import { ClassificationBanner } from "./components/ClassificationBanner";
import { CommandPalette } from "./components/CommandPalette";
import { HelpOverlay } from "./components/HelpOverlay";
import { UploadWizard } from "./components/UploadWizard";
import { useFilteredModels } from "./components/Library";
import { EarthDirection } from "./directions/Earth";
import { InstrumentDirection } from "./directions/Instrument";
import { HudDirection } from "./directions/Hud";
import { cx } from "./components/primitives";

const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: "earth", label: "A · Earth workspace" },
  { id: "instrument", label: "B · Night Instrument" },
  { id: "hud", label: "C · Minimal HUD" },
];

export function App() {
  useAppEffects();
  const engine = useEngine();
  const direction = useApp((s) => s.direction);
  const route = useApp((s) => s.route);
  const current = useSignal(engine?.current, null);
  const visible = useFilteredModels();
  const { open } = useOpenModel();

  // The banner shows the highest classification on screen (UPL-10).
  const ids = route === "viewer" && current ? [current.classificationId] : visible.map((m) => m.classificationId);
  const level =
    SAMPLE_CLASSIFICATIONS.filter((c) => ids.includes(c.id)).sort((a, b) => b.order - a.order)[0] ?? SAMPLE_CLASSIFICATIONS[0]!;

  return (
    <>
      <ClassificationBanner level={level} position="top" />
      <ClassificationBanner level={level} position="bottom" />
      {direction === "earth" && <EarthDirection />}
      {direction === "instrument" && <InstrumentDirection />}
      {direction === "hud" && <HudDirection />}
      <DirectionSwitcher />
      <CommandPalette onOpenModel={open} />
      <HelpOverlay />
      <UploadWizard />
      <noscript>{SAMPLE_LIBRARY.length}</noscript>
    </>
  );
}

/** Prototype-only control for comparing the UI directions side by side. */
function DirectionSwitcher() {
  const { t } = useTranslation();
  const direction = useApp((s) => s.direction);
  const setPref = useApp((s) => s.setPref);
  const set = useApp((s) => s.set);
  void t;
  return (
    <div className="fixed top-7 left-1/2 z-40 -translate-x-1/2">
      <div className="glass flex items-center gap-0.5 rounded-full p-1 text-[12px]" role="radiogroup" aria-label="Design direction (prototype)">
        <span className="px-2 text-[11px] uppercase tracking-wide text-fg3">Prototype</span>
        {DIRECTIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={direction === d.id}
            onClick={() => {
              setPref("direction", d.id);
              set({ leftOpen: true, rightOpen: false });
            }}
            className={cx("h-7 rounded-full px-3 font-medium", direction === d.id ? "bg-accent text-accent-on" : "text-fg2 hover:text-fg")}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}
