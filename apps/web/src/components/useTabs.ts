import type { KeyboardEvent } from "react";

/**
 * WAI-ARIA tabs (WP 6.2): one Tab stop for the whole row (the selected tab), the arrow keys move
 * to the next or previous tab (mirrored right to left), Home and End to the first and last, and
 * each tab names the panel it controls.
 */
export function useTabs<T extends string>(base: string, ids: readonly T[], current: T, select: (id: T) => void) {
  const onKeyDown = (e: KeyboardEvent) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const i = ids.indexOf(current);
    const next = rtl ? "ArrowLeft" : "ArrowRight";
    const prev = rtl ? "ArrowRight" : "ArrowLeft";
    const n = e.key === next ? (i + 1) % ids.length : e.key === prev ? (i - 1 + ids.length) % ids.length : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(ids[n]!);
    document.getElementById(`${base}-tab-${ids[n]}`)?.focus();
  };
  return {
    list: { role: "tablist", onKeyDown } as const,
    tab: (id: T) =>
      ({ id: `${base}-tab-${id}`, role: "tab", "aria-selected": current === id, "aria-controls": `${base}-panel-${id}`, tabIndex: current === id ? 0 : -1, onClick: () => select(id) }) as const,
    panel: (id: T) => ({ id: `${base}-panel-${id}`, role: "tabpanel", "aria-labelledby": `${base}-tab-${id}` }) as const,
  };
}
