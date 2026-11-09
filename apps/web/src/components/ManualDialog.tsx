import { useTranslation } from "react-i18next";
import { useApp } from "../state/store";
import { X } from "./icons";
import { IconButton } from "./primitives";
import { useDialog } from "./useDialog";

/**
 * The user manual (WP 6.6), in the interface's language. It is a page of its own that the web
 * build makes from docs/manual (scripts/build-manual.cjs), shown here in a frame: the desktop app
 * opens no other windows, and the manual stays beside the view it describes.
 */
export function ManualDialog() {
  const { t, i18n } = useTranslation();
  const open = useApp((s) => s.manualOpen);
  const set = useApp((s) => s.set);
  const ref = useDialog<HTMLDivElement>(open, { onClose: () => set({ manualOpen: false }) });
  if (!open) return null;
  const lang = i18n.language.startsWith("he") ? "he" : "en";
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && set({ manualOpen: false })}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t("help.manual")} className="glass flex h-[88vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-[14px]">
        <div className="flex h-11 shrink-0 items-center border-b border-line ps-4 pe-1.5">
          <h2 className="flex-1 text-[15px] font-semibold">{t("help.manual")}</h2>
          <IconButton label={t("common.close")} onClick={() => set({ manualOpen: false })}>
            <X size={16} />
          </IconButton>
        </div>
        <iframe title={t("help.manual")} src={`${import.meta.env.BASE_URL}manual/${lang}/index.html?theme=${theme}`} className="min-h-0 flex-1 border-0" />
      </div>
    </div>
  );
}
