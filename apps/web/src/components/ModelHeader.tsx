import { copyText } from "../clipboard";
import { useState } from "react";
import { useClassOf } from "../state/classification";
import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Camera, ChevronDown, ChevronLeft, Command, Share2 } from "./icons";
import { hiddenLayers, shareUrl } from "../share";
import { screenshotWithBanner } from "../screenshot";
import { saveDataUrl, slug } from "../download";
import { IconButton, StatusBadge, cx } from "./primitives";

/** Model identity: name, status, version, classification, share (SRS 5.1 top bar). */
export function ModelHeader({ onBack, backLabel, className, compact }: { onBack: () => void; backLabel: string; className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const model = useSignal(engine?.current, null);
  const set = useApp((s) => s.set);
  const [shared, setShared] = useState(false);
  const classOf = useClassOf();
  if (!model) return null;
  const cls = classOf(model);
  return (
    <div className={cx("glass flex h-12 items-center gap-2 rounded-[12px] ps-1.5 pe-1.5", className)}>
      <button type="button" onClick={onBack} className="tip tip-below flex h-9 items-center gap-1 rounded-[8px] ps-1.5 pe-2.5 text-fg2 hover:bg-s3 hover:text-fg" data-tip={backLabel}>
        <ChevronLeft size={16} className="rtl:-scale-x-100" />
        {!compact && <span className="text-[12px] font-medium">{backLabel}</span>}
      </button>
      <span className="h-6 w-px bg-line" />
      <div className="min-w-0 px-1">
        <div className="truncate font-semibold text-fg max-w-[340px]" dir="auto" data-content>{model.name}</div>
      </div>
      <StatusBadge status={model.status} compact />
      <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-line-strong px-2 text-[12px] text-fg2 hover:text-fg num" title={t("viewer.version")}>
        v{model.version}
        <ChevronDown size={12} />
      </button>
      {cls && (
        <span className="rounded px-1.5 h-6 inline-flex items-center text-[10px] font-semibold tracking-wider" style={{ background: cls.color, color: cls.textColor }}>
          {cls.label.split(" ")[0]}
        </span>
      )}
      <span className="h-6 w-px bg-line" />
      <IconButton label={t("shell.palette")} shortcut="Ctrl+K" onClick={() => set({ paletteOpen: true })} className="tip-below">
        <Command size={16} />
      </IconButton>
      <IconButton
        label={t("shell.screenshot")}
        className="tip-below"
        onClick={async () => {
          if (!engine) return;
          const png = await screenshotWithBanner(engine, cls, model);
          saveDataUrl(`${slug(model.name)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`, png);
        }}
      >
        <Camera size={16} />
      </IconButton>
      <IconButton
        label={shared ? t("viewer.shareCopied") : model.id.startsWith("upload-") ? t("misc.uploadNoShare") : t("viewer.share")}
        className="tip-below"
        disabled={model.id.startsWith("upload-")}
        onClick={async () => {
          if (!engine) return;
          const url = shareUrl({ m: model.id, v: model.version, c: engine.getView(), mode: engine.viewMode.get(), hidden: hiddenLayers(engine.layers.get()) });
          // If copying fails, the link is still in the address bar.
          if (await copyText(url)) {
            setShared(true);
            setTimeout(() => setShared(false), 1500);
          }
          history.replaceState(null, "", url);
        }}
      >
        <Share2 size={16} />
      </IconButton>
    </div>
  );
}
