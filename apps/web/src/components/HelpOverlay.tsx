import { useTranslation } from "react-i18next";
import { useApp } from "../state/store";
import { X } from "./icons";
import { IconButton, Kbd } from "./primitives";

/** "?" overlay (NAV-07). Shortcuts follow physical keys so they match in Hebrew. */
export function HelpOverlay() {
  const { t } = useTranslation();
  const open = useApp((s) => s.helpOpen);
  const set = useApp((s) => s.set);
  if (!open) return null;
  const mouse: [string, string][] = [
    ["Left-drag", t("help.rows.orbit")],
    ["Right / middle-drag", t("help.rows.pan")],
    ["Wheel / pinch", t("help.rows.zoom")],
    ["Double-click", t("help.rows.pivot")],
  ];
  const keys: [string, string][] = [
    ["W", t("help.rows.orbit")],
    ["E", t("help.rows.pan")],
    ["← ↑ → ↓", t("help.rows.pan")],
    ["+ / −", t("help.rows.zoom")],
    ["H", t("help.rows.home")],
    ["Z", t("help.rows.focus")],
    ["M", t("help.rows.measure")],
    ["Shift M", t("help.rows.path")],
    ["G", "Fly mode (W A S D, Q / E)"],
    ["1 – 4", t("help.rows.modes")],
    ["L", t("help.rows.layers")],
    [".", t("help.rows.panel")],
    ["F", t("help.rows.full")],
    ["Ctrl K", t("help.rows.palette")],
    ["Esc", t("help.rows.cancel")],
    ["?", t("help.rows.help")],
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && set({ helpOpen: false })}>
      <div role="dialog" aria-label={t("help.title")} className="glass w-[680px] max-w-[94vw] rounded-[14px] p-5">
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 text-[15px] font-semibold">{t("help.title")}</h2>
          <IconButton label={t("common.close")} onClick={() => set({ helpOpen: false })}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <section>
            <h3 className="mb-2 text-[11px] uppercase tracking-wide text-fg3">{t("help.mouse")}</h3>
            <dl className="space-y-2">
              {mouse.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-fg2">{v}</dt>
                  <dd className="text-[12px] text-fg">{k}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] uppercase tracking-wide text-fg3">{t("help.keyboard")}</h3>
            <dl className="grid grid-cols-1 gap-1.5">
              {keys.map(([k, v]) => (
                <div key={k + v} className="flex items-center justify-between gap-3">
                  <dt className="text-fg2">{v}</dt>
                  <dd className="flex gap-1" dir="ltr">
                    {k.split(" ").map((p) => (
                      <Kbd key={p}>{p}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
