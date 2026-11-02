import type { ClassificationLevel } from "@viewer/shared";

/** Always-visible classification banner (UPL-10). Thin to keep the view large. */
export function ClassificationBanner({ level, position }: { level: ClassificationLevel; position: "top" | "bottom" }) {
  return (
    <div
      role="note"
      aria-label={`Classification: ${level.label}`}
      className="fixed inset-x-0 z-40 flex h-5 items-center justify-center text-[11px] font-semibold tracking-[0.12em] uppercase select-none"
      style={{ background: level.color, color: level.textColor, [position]: 0 }}
    >
      {level.label}
    </div>
  );
}
