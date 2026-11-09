import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelSummary } from "@viewer/shared";
import { getModelDetail } from "../server/api";
import { useOpenModel } from "../useAppEffects";
import { useApp } from "../state/store";
import { Check, ChevronDown, Loader2 } from "./icons";
import { cx } from "./primitives";

/**
 * The open model's version and its history (WP 4.4, UPL-05). Choosing a version opens it from
 * the same viewpoint, to compare; the badge says when the one shown is not the current one.
 * Models that are not on the server (samples, this session's uploads) show the number only.
 */
export function VersionPicker({ model }: { model: ModelSummary }) {
  const { t, i18n } = useTranslation();
  const server = useApp((s) => s.server);
  const history = useApp((s) => (s.versionHistory?.id === model.id ? s.versionHistory.list : null));
  const { openVersion } = useOpenModel();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = !!server && !model.id.startsWith("upload-");
  const older = model.version < model.versions;

  // The history is read with the model; read it again if that failed.
  useEffect(() => {
    if (!open || history || !server || !live) return;
    let on = true;
    getModelDetail(server, model.id)
      .then((d) => on && useApp.setState({ versionHistory: { id: d.id, list: d.history } }))
      .catch((e: Error) => on && setProblem(t("versions.readFailed", { reason: e.message })));
    return () => {
      on = false;
    };
  }, [open, history, server, live, model.id, t]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const label = older ? t("versions.olderOf", { v: model.version, n: model.versions }) : `v${model.version}`;
  const badge = cx("inline-flex h-7 items-center gap-1 rounded-[6px] border px-2 text-[12px] num", older ? "font-semibold" : "border-line-strong text-fg2");
  // An earlier version is marked in the status colour for "in production", so it is not taken for the current one.
  const tone = older ? { color: "var(--status-production)", borderColor: "color-mix(in oklab, currentColor 50%, transparent)" } : undefined;
  if (!live) return <span className={badge} style={tone} title={t("viewer.version")}>{label}</span>;

  const choose = async (v: number) => {
    if (v === model.version) return setOpen(false);
    setBusy(v);
    setProblem(null);
    try {
      await openVersion(model.id, v);
      setOpen(false);
    } catch (e) {
      setProblem(t("versions.openFailed", { v, reason: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div ref={box} className="relative" onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}>
      <button
        type="button"
        className={cx(badge, !older && "hover:text-fg")}
        style={tone}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("versions.pick", { v: model.version, n: model.versions })}
        data-testid="version-picker"
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div role="menu" aria-label={t("versions.title")} className="glass absolute top-[calc(100%+6px)] start-0 z-30 w-80 rounded-[12px] p-1">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg3">{t("versions.title")}</div>
          {!history && !problem && <p className="px-2 py-2 text-fg3">{t("versions.loading")}</p>}
          {history?.map((h) => {
            const shown = h.version === model.version;
            const current = h.version === model.versions;
            return (
              <button
                key={h.version}
                type="button"
                role="menuitemradio"
                aria-checked={shown}
                data-version={h.version}
                disabled={busy !== null}
                onClick={() => void choose(h.version)}
                className={cx("flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-start", shown ? "bg-accent-soft" : "hover:bg-s3")}
              >
                <span className="mt-0.5 w-4 shrink-0 text-accent">{busy === h.version ? <Loader2 size={14} className="animate-spin" /> : shown ? <Check size={14} /> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="num font-semibold text-fg">v{h.version}</span>
                    {current && <span className="rounded bg-s3 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg2">{t("versions.current")}</span>}
                    <span className="num ms-auto text-[11px] text-fg3">{date(h.createdAt)}</span>
                  </span>
                  <span className="block truncate text-[12px] text-fg3" dir="auto">{h.note || t("versions.noNote")}</span>
                </span>
              </button>
            );
          })}
          {problem && <p role="alert" className="px-2 py-2 text-[12px] text-danger">{problem}</p>}
        </div>
      )}
    </div>
  );
}
