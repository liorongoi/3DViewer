import { useTranslation } from "react-i18next";
import type { ClassificationLevel } from "@viewer/shared";

/** Always-visible classification banner (UPL-10). Thin to keep the view large. */
export function ClassificationBanner({ level, position }: { level: ClassificationLevel; position: "top" | "bottom" }) {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      // The level's name is the admin's text, in whatever language they wrote it.
      data-content
      aria-label={t("shell.classification", { label: level.label })}
      className="fixed inset-x-0 z-40 flex h-5 items-center justify-center text-[11px] font-semibold tracking-[0.12em] uppercase select-none"
      style={{ background: level.color, color: level.textColor, [position]: 0 }}
    >
      {level.label}
    </div>
  );
}
