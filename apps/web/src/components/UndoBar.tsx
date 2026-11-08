import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { undo, useUndo } from "../state/undo";
import { Kbd, cx } from "./primitives";

const SHOWN_MS = 6000;

/** A short note after an undoable step, with an Undo button; Ctrl+Z does the same. */
export function UndoBar({ className }: { className?: string }) {
  const { t } = useTranslation();
  const last = useUndo((s) => s.steps[s.steps.length - 1]);
  const [shownId, setShownId] = useState<number | null>(null);
  useEffect(() => {
    if (!last) return setShownId(null);
    setShownId(last.id);
    const timer = setTimeout(() => setShownId(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [last]);
  const open = !!last && shownId === last.id;
  return (
    <div role="status" aria-live="polite" className={cx(!open && "sr-only", className)}>
      {open && (
        <div data-testid="undo-bar" className="glass pointer-events-auto flex items-center gap-3 rounded-[10px] px-3 py-1.5 text-[13px]">
          <span className="text-fg2">{last.label}</span>
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => undo()}>
            {t("common.undo")}
          </button>
          <Kbd>Ctrl Z</Kbd>
        </div>
      )}
    </div>
  );
}
