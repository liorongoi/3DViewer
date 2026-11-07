import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { X } from "./icons";
import { cx } from "./primitives";

/** Performance overlay, Shift+P (WP 1.5): frame rate and time, resolution, tiles and memory. */
export function PerfHud({ className }: { className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const p = useSignal(engine?.perf, null);
  const open = useApp((s) => s.perfOpen);
  const set = useApp((s) => s.set);
  const adaptive = useApp((s) => s.adaptiveResolution);
  const setPref = useApp((s) => s.setPref);
  if (!open) return null;
  const rows: [string, string, boolean?][] = p
    ? [
        [t("perf.fps"), `${p.fps} fps`, p.fps < 30],
        [t("perf.frameTime"), t("perf.frameTimeValue", { ms: p.frameMs.toFixed(1), worst: p.worstFrameMs.toFixed(1) }), p.worstFrameMs > 33],
        [t("perf.resolution"), `${Math.round(p.resolution * 100)}% · ${p.canvas} · MSAA ${p.msaa}×`],
        [t("perf.tiles"), t("perf.tilesValue", { shown: p.tilesVisible, loaded: p.tilesLoaded, pending: p.tilesPending })],
        [t("perf.memory"), `${(p.tileMemoryMB + p.modelMemoryMB).toFixed(0)} MB${p.tileMemoryMB ? ` ${t("perf.inTiles")}` : p.modelMemoryMB ? ` ${t("perf.inModel")}` : ""}`],
      ]
    : [];
  return (
    <div role="status" aria-label={t("perf.title")} className={cx("glass w-[300px] rounded-[10px] p-2 text-[11px]", className)} data-testid="perf-hud">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="font-semibold text-fg">{t("perf.title")}</span>
        <button type="button" aria-label={t("perf.close")} className="text-fg3 hover:text-fg" onClick={() => set({ perfOpen: false })}>
          <X size={12} />
        </button>
      </div>
      {!p && <p className="px-1 text-fg3">{t("perf.measuring")}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-1">
        {rows.map(([k, v, bad]) => (
          <div key={k} className="contents">
            <dt className="text-fg3">{k}</dt>
            <dd className={cx("num text-end", bad ? "text-[var(--status-production)]" : "text-fg")}>{v}</dd>
          </div>
        ))}
      </dl>
      <label className="mt-1.5 flex items-center gap-2 px-1 text-fg2">
        <input type="checkbox" checked={adaptive} onChange={(e) => setPref("adaptiveResolution", e.target.checked)} />
        {t("perf.adaptive")}
      </label>
    </div>
  );
}
