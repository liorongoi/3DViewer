import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Columns2, X } from "./icons";

/**
 * Side by side (SRS GS-28): the open model on the left of a divider, the compared one on the
 * right, from one viewpoint. Each side names its version and how it was made; dragging the handle
 * (or the arrow keys on it) moves the divider. Stopping frees the compared model.
 */
export function CompareOverlay() {
  const { t } = useTranslation();
  const engine = useEngine();
  const other = useSignal(engine?.comparing, null);
  const open = useSignal(engine?.current, null);
  const at = useSignal(engine?.splitAt, 0.5);
  const history = useApp((s) => (open && s.versionHistory?.id === open.id ? s.versionHistory.list : null));
  const drag = useRef(false);
  if (!engine || !other || !open) return null;
  const note = (v: number) => history?.find((h) => h.version === v)?.note || "";
  const move = (clientX: number) => engine.setSplit(clientX / window.innerWidth);
  const side = (m: typeof open, which: "left" | "right") => (
    <div className={`glass pointer-events-auto max-w-[30vw] rounded-[10px] px-3 py-2 text-[12px] ${which === "left" ? "text-start" : "text-end"}`} data-testid={`compare-${which}`}>
      <p className="font-semibold text-fg">
        <span className="num">v{m.version}</span> · <span dir="auto">{m.name}</span>
      </p>
      {note(m.version) && <p className="truncate text-fg3" dir="auto">{note(m.version)}</p>}
    </div>
  );
  return (
    <div className="pointer-events-none fixed inset-0 z-[15]" data-testid="compare-overlay">
      <div className="absolute inset-y-0 w-px bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" style={{ left: `${at * 100}%` }} />
      <button
        type="button"
        role="slider"
        aria-label={t("compare.divider")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at * 100)}
        className="glass pointer-events-auto absolute top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full"
        style={{ left: `${at * 100}%` }}
        onPointerDown={(e) => {
          drag.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && move(e.clientX)}
        onPointerUp={() => (drag.current = false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") engine.setSplit(at - 0.05);
          if (e.key === "ArrowRight") engine.setSplit(at + 0.05);
        }}
        data-testid="compare-handle"
      >
        <Columns2 size={16} />
      </button>
      {/* Under the panels' level, so the labels sit at the bottom, each on its own side of the stop button. */}
      <div className="absolute inset-x-3 bottom-[120px] flex items-end justify-center gap-2">
        {side(open, "left")}
        <button type="button" className="btn-secondary pointer-events-auto glass shrink-0" onClick={() => engine.stopCompare()} data-testid="compare-stop">
          <X size={14} /> {t("compare.stop")}
        </button>
        {side(other, "right")}
      </div>
    </div>
  );
}
