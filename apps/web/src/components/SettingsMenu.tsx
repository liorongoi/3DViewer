import { useTranslation } from "react-i18next";
import type { Quality } from "@viewer/core";
import { useEngine } from "../engine";
import { applyLanguage } from "../i18n";
import { useApp } from "../state/store";
import { Segmented } from "./primitives";

export function SettingsMenu({ onClose: _onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const s = useApp();
  const row = "flex items-center justify-between gap-3 py-1.5";
  return (
    <div className="glass absolute bottom-[calc(100%+8px)] end-0 w-80 rounded-[12px] p-3" role="dialog" aria-label={t("viewer.settings")}>
      <div className={row}>
        <span className="text-fg2">{t("settings.language")}</span>
        <Segmented
          label={t("settings.language")}
          value={s.lang}
          onChange={(v) => {
            s.setPref("lang", v);
            applyLanguage(v);
          }}
          options={[
            { value: "en", label: "English" },
            { value: "he", label: "עברית" },
          ]}
        />
      </div>
      <div className={row}>
        <span className="text-fg2">{t("settings.theme")}</span>
        <Segmented
          label={t("settings.theme")}
          value={s.theme}
          onChange={(v) => {
            s.setPref("theme", v);
            document.documentElement.dataset.theme = v;
          }}
          options={[
            { value: "dark", label: t("settings.dark") },
            { value: "light", label: t("settings.light") },
          ]}
        />
      </div>
      <div className={row}>
        <span className="text-fg2">{t("settings.quality")}</span>
        <Segmented
          label={t("settings.quality")}
          value={s.quality}
          onChange={(v: Quality) => {
            s.setPref("quality", v);
            engine?.setQuality(v);
          }}
          options={(["low", "balanced", "high", "ultra"] as Quality[]).map((q) => ({ value: q, label: t(`settings.qualities.${q}`) }))}
        />
      </div>
      <div className="my-2 h-px bg-line" />
      <Toggle label="Fade tools while navigating" value={s.fadeTools} onChange={(v) => s.setPref("fadeTools", v)} />
      <Toggle label={t("viewer.shadows")} value={s.shadows} onChange={(v) => { s.set({ shadows: v }); engine?.setShadows(v); }} />
      <Toggle label={t("viewer.imagery")} value={s.imagery} onChange={(v) => { s.set({ imagery: v }); engine?.setBaseImagery(v); }} />
      <Toggle label={`${t("viewer.baseMap")} (globe)`} value={s.globe} onChange={(v) => { s.set({ globe: v }); engine?.setGlobe(v); }} />
      <p className="mt-2 text-[11px] text-fg3">
        Base imagery: Natural Earth II, bundled with CesiumJS (works offline). Terrain and the organisation&apos;s orthophotos come with the base map package (RND-11).
      </p>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex h-8 cursor-pointer items-center justify-between">
      <span className="text-fg2">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 rounded-full transition-colors ${value ? "bg-accent" : "bg-s3 border border-line-strong"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? "start-[18px]" : "start-0.5"}`} />
      </button>
    </label>
  );
}
