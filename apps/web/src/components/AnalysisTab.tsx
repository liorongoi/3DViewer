import { useTranslation } from "react-i18next";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Download, Eye, EyeOff, Radar, ScanEye, Trash2, X } from "./icons";
import { IconButton, cx } from "./primitives";
import { ProfileChart, fmtDist } from "./ProfileChart";
import { pairsToCsv, profileToCsv, type SightPair } from "@viewer/core";
import { saveText, slug } from "../download";
import { pushUndo } from "../state/undo";

/** Right panel tab: line of sight pairs with profiles (WP 2.8) and the 360° viewshed (WP 2.9). */
export function AnalysisTab() {
  return (
    <div className="flex flex-col gap-3 p-2">
      <SightSection />
      <ViewshedSection />
    </div>
  );
}

function SightSection() {
  const { t } = useTranslation();
  const engine = useEngine();
  const pairs = useSignal(engine?.sight.pairs, []);
  const selected = useSignal(engine?.sight.selected, null);
  const defaults = useSignal(engine?.sight.defaults, { aHeight: 1.8, bHeight: 1.8, refraction: true });
  const tool = useApp((s) => s.tool);
  const set = useApp((s) => s.set);
  const active = tool === "sight";
  return (
    <section className="rounded-[10px] border border-line bg-s2 p-3">
      <h3 className="mb-1 flex items-center gap-2 font-semibold">
        <ScanEye size={15} className="text-accent" /> {t("analysis.sight")}
      </h3>
      <p className="mb-2 text-[12px] text-fg3">
        {active ? t("analysis.sightActive") : t("analysis.sightIdle")}
      </p>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <NumberField label={t("analysis.observerHeight")} value={defaults.aHeight} onChange={(v) => engine?.sight.defaults.set({ ...defaults, aHeight: v })} />
        <NumberField label={t("analysis.targetHeight")} value={defaults.bHeight} onChange={(v) => engine?.sight.defaults.set({ ...defaults, bHeight: v })} />
      </div>
      <label className="mb-2 flex items-center gap-2 text-[12px] text-fg2">
        <input
          type="checkbox"
          checked={defaults.refraction}
          onChange={(e) => {
            engine?.sight.defaults.set({ ...defaults, refraction: e.target.checked });
            engine?.sight.recomputeAll();
          }}
        />
        {t("analysis.refraction")}
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={active ? "btn-secondary" : "btn-primary"} onClick={() => set({ tool: active ? "none" : "sight" })}>
          {active ? t("analysis.doneAdding") : t("analysis.addPairs")} <span className="num opacity-70">I</span>
        </button>
        {pairs.length > 0 && (
          <>
            <button type="button" className="btn-ghost" onClick={() => saveText("line-of-sight.csv", pairsToCsv(pairs))}>
              <Download size={14} /> {t("analysis.exportCsv")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => engine?.sight.clear()}>
              {t("analysis.clearAll")}
            </button>
          </>
        )}
      </div>
      {pairs.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {[...pairs].reverse().map((p) => (
            <PairCard key={p.id} p={p} open={p.id === selected} onOpen={() => engine?.sight.selected.set(p.id === selected ? null : p.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PairCard({ p, open, onOpen }: { p: SightPair; open: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const n = p.seq;
  const status = p.computing ? null : p.visible;
  return (
    <li data-pair={p.id} aria-label={p.name} className={cx("rounded-[8px] border bg-s1solid", open ? "border-accent/50" : "border-line", !p.shown && "opacity-60")}>
      <div className="flex items-center gap-1 p-1.5 ps-2">
        <button type="button" onClick={onOpen} title={p.name} className="flex min-w-0 flex-1 items-center gap-2 text-start" aria-expanded={open}>
          <span className="num rounded bg-s3 px-1.5 text-[11px] text-fg2">
            A{n}–B{n}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {status === null ? (
              <span className="text-fg3">{t("analysis.computing")}</span>
            ) : status ? (
              <span className="font-medium" style={{ color: "var(--ok)" }}>
                <Eye size={12} className="me-1 inline" />
                {t("analysis.visible")}
              </span>
            ) : (
              <span className="font-medium" style={{ color: "var(--bad)" }}>
                <EyeOff size={12} className="me-1 inline" />
                {t("analysis.blocked", { d: fmtDist(p.block?.d ?? 0) })}
              </span>
            )}
          </span>
          <span className="num text-[12px] text-fg3">{fmtDist(p.distance)}</span>
        </button>
        <IconButton size="sm" label={p.shown ? t("analysis.hideOnMap") : t("analysis.showOnMap")} onClick={() => engine?.sight.update(p.id, { shown: !p.shown })}>
          {p.shown ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <IconButton
          size="sm"
          label={t("analysis.deletePair")}
          onClick={() => {
            const gone = engine?.sight.remove(p.id);
            if (gone) pushUndo(t("measure.deleted", { name: p.name }), () => engine?.sight.restore(gone.pair, gone.index));
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {open && (
        <div className="border-t border-line p-2">
          <input
            key={p.name}
            aria-label={t("common.rename")}
            className="mb-1 w-full bg-transparent font-medium outline-none decoration-accent focus:underline"
            defaultValue={p.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== p.name) engine?.sight.update(p.id, { name });
              else e.target.value = p.name;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                e.currentTarget.value = p.name;
                e.currentTarget.blur();
                e.stopPropagation();
              }
            }}
          />
          <ProfileChart pair={p} />
          <div className="mt-1 flex justify-end">
            <button type="button" className="btn-ghost h-7 px-2 text-[12px]" disabled={p.computing} onClick={() => saveText(`profile-${slug(p.name)}.csv`, profileToCsv(p))}>
              <Download size={13} /> {t("analysis.profileCsv")}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <NumberField label={t("analysis.aboveGround", { point: `A${n}` })} value={p.aHeight} onChange={(v) => engine?.sight.update(p.id, { aHeight: v })} />
            <NumberField label={t("analysis.aboveGround", { point: `B${n}` })} value={p.bHeight} onChange={(v) => engine?.sight.update(p.id, { bHeight: v })} />
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-fg3">{t("analysis.groundOf", { point: `A${n}` })}</dt>
            <dd className="num text-fg2">{p.a.h.toFixed(1)} m</dd>
            <dt className="text-fg3">{t("analysis.groundOf", { point: `B${n}` })}</dt>
            <dd className="num text-fg2">{p.b.h.toFixed(1)} m</dd>
            <dt className="text-fg3">{p.visible ? t("analysis.smallestClearance") : t("analysis.worstObstruction")}</dt>
            <dd className="num text-fg2">{Math.abs(p.worstDeficit).toFixed(1)} m</dd>
          </dl>
        </div>
      )}
    </li>
  );
}

function ViewshedSection() {
  const { t } = useTranslation();
  const engine = useEngine();
  const s = useSignal(engine?.viewshed.state, null);
  const placing = useSignal(engine?.viewshed.placing, false);
  const set = useApp((x) => x.set);
  return (
    <section className="rounded-[10px] border border-line bg-s2 p-3">
      <h3 className="mb-1 flex items-center gap-2 font-semibold">
        <Radar size={15} className="text-accent" /> {t("analysis.viewshed")}
      </h3>
      <p className="mb-2 text-[12px] text-fg3">
        {placing
          ? t("analysis.vsPlacing")
          : s
            ? t("analysis.vsActive")
            : t("analysis.vsIdle")}
      </p>
      {s && (
        <div className="mb-2 flex flex-col gap-2">
          <Slider
            label={t("analysis.eyeHeight")}
            value={s.height}
            min={0.5}
            max={500}
            log
            format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} m`}
            onChange={(v) => engine?.viewshed.setHeight(v)}
          />
          <Slider label={t("analysis.radius")} value={s.radius} min={100} max={5000} log format={fmtDist} onChange={(v) => engine?.viewshed.setRadius(v)} />
          <div className="num text-[11px] text-fg3" dir="ltr">
            {t("analysis.vsPosition", { lat: s.lat.toFixed(5), lon: s.lon.toFixed(5), ground: s.ground.toFixed(1), eye: (s.ground + s.height).toFixed(1) })}
          </div>
          <div className="flex gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1 text-fg2">
              <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--ok)" }} /> {t("analysis.visible")}
            </span>
            <span className="inline-flex items-center gap-1 text-fg2">
              <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--bad)" }} /> {t("analysis.hidden")}
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={placing ? "btn-secondary" : "btn-primary"} onClick={() => set({ tool: placing ? "none" : "viewshed" })}>
          {placing ? t("common.cancel") : s ? t("analysis.moveObserver") : t("analysis.placeObserver")} <span className="num opacity-70">V</span>
        </button>
        {s && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              engine?.viewshed.clear();
              set({ tool: "none" });
            }}
          >
            <X size={14} /> {t("misc.clear")}
          </button>
        )}
      </div>
    </section>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] text-fg3">{label}</span>
      <span className="flex h-8 items-center rounded-[6px] border border-line bg-s1solid px-2 focus-within:border-accent">
        <input
          key={value}
          type="number"
          step={0.1}
          min={0}
          defaultValue={value}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0 && v !== value) onChange(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="num min-w-0 flex-1 bg-transparent outline-none"
          dir="ltr"
        />
        <span className="text-[11px] text-fg3">m</span>
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  log,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  log?: boolean;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const to = (v: number) => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : ((v - min) / (max - min)) * 1000);
  const from = (t: number) => (log ? min * (max / min) ** (t / 1000) : min + ((max - min) * t) / 1000);
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between text-[11px] text-fg3">
        {label}
        <span className="num text-fg2">{format(value)}</span>
      </span>
      <input type="range" min={0} max={1000} value={Math.round(to(value))} onChange={(e) => onChange(from(Number(e.target.value)))} className="w-full accent-[var(--accent)]" />
    </label>
  );
}
