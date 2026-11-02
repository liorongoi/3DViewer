import { useEffect } from "react";
import { useEngine, useSignal } from "../engine";
import { X } from "./icons";
import { IconButton } from "./primitives";

const W = 300;

/** Attribute pop-up for a clicked feature of the user's own vector data (VWR-GEO-02). */
export function FeaturePopup() {
  const engine = useEngine();
  const f = useSignal(engine?.userLayers.picked, null);
  useEffect(() => {
    if (!f) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && engine?.userLayers.clearPick();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [f, engine]);
  if (!f || !f.screen) return null;

  const vw = window.innerWidth;
  const above = f.screen.y > 300;
  const left = Math.max(12, Math.min(vw - W - 12, f.screen.x - W / 2));
  const arrow = Math.max(16, Math.min(W - 16, f.screen.x - left));
  const style = above ? { left, bottom: window.innerHeight - f.screen.y + 14, width: W } : { left, top: f.screen.y + 14, width: W };

  return (
    <div role="dialog" aria-label={`Attributes of ${f.title}`} className="glass fixed z-30 rounded-[12px] text-[12px] shadow-xl" style={style}>
      <span
        aria-hidden
        className="absolute h-3 w-3 rotate-45 border-line bg-s1solid"
        style={above ? { left: arrow - 6, bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 } : { left: arrow - 6, top: -6, borderLeftWidth: 1, borderTopWidth: 1 }}
      />
      <div className="flex items-start gap-2 p-2.5 pb-1.5">
        <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: f.color }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" title={f.title}>
            {f.title}
          </div>
          <div className="truncate text-[11px] text-fg3">{f.layerName}</div>
        </div>
        <IconButton size="sm" label="Close · Esc" onClick={() => engine?.userLayers.clearPick()}>
          <X size={14} />
        </IconButton>
      </div>
      {f.rows.length === 0 ? (
        <p className="px-2.5 pb-2.5 text-fg3">This feature has no attributes.</p>
      ) : (
        <div className="max-h-[240px] overflow-auto px-2.5 pb-2.5 scrollbar-thin">
          <table className="w-full border-collapse">
            <tbody>
              {f.rows.map(([k, v]) => (
                <tr key={k} className="border-t border-line align-top">
                  <th scope="row" className="py-1 pe-2 text-start font-normal text-fg3">
                    {k}
                  </th>
                  <td className="num break-words py-1 text-fg" dir="auto">
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
