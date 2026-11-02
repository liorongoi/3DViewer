import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Download, Eye, EyeOff, Radar, ScanEye, Trash2, X } from "./icons";
import { IconButton, cx } from "./primitives";
import { ProfileChart, fmtDist } from "./ProfileChart";
import { pairsToCsv, profileToCsv, type SightPair } from "@viewer/core";
import { saveText, slug } from "../download";

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
        <ScanEye size={15} className="text-accent" /> Line of sight
      </h3>
      <p className="mb-2 text-[12px] text-fg3">
        {active ? "Click the observer point A, then the target point B. Add as many pairs as you like; Esc stops." : "Pick two points to see whether A can see B, and the height profile between them."}
      </p>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <NumberField label="Observer above ground" value={defaults.aHeight} onChange={(v) => engine?.sight.defaults.set({ ...defaults, aHeight: v })} />
        <NumberField label="Target above ground" value={defaults.bHeight} onChange={(v) => engine?.sight.defaults.set({ ...defaults, bHeight: v })} />
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
        Earth curvature with standard refraction (k = 0.13)
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={active ? "btn-secondary" : "btn-primary"} onClick={() => set({ tool: active ? "none" : "sight" })}>
          {active ? "Done adding" : "Add pairs"} <span className="num opacity-70">I</span>
        </button>
        {pairs.length > 0 && (
          <>
            <button type="button" className="btn-ghost" onClick={() => saveText("line-of-sight.csv", pairsToCsv(pairs))}>
              <Download size={14} /> Export CSV
            </button>
            <button type="button" className="btn-ghost" onClick={() => engine?.sight.clear()}>
              Clear all
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
  const engine = useEngine();
  const n = p.name.replace(/^Line of sight /, "");
  const status = p.computing ? null : p.visible;
  return (
    <li className={cx("rounded-[8px] border bg-s1solid", open ? "border-accent/50" : "border-line", !p.shown && "opacity-60")}>
      <div className="flex items-center gap-1 p-1.5 ps-2">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-start" aria-expanded={open}>
          <span className="num rounded bg-s3 px-1.5 text-[11px] text-fg2">
            A{n}–B{n}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {status === null ? (
              <span className="text-fg3">Computing…</span>
            ) : status ? (
              <span className="font-medium" style={{ color: "var(--ok)" }}>
                <Eye size={12} className="me-1 inline" />
                Visible
              </span>
            ) : (
              <span className="font-medium" style={{ color: "var(--bad)" }}>
                <EyeOff size={12} className="me-1 inline" />
                Blocked · {fmtDist(p.block!.d)}
              </span>
            )}
          </span>
          <span className="num text-[12px] text-fg3">{fmtDist(p.distance)}</span>
        </button>
        <IconButton size="sm" label={p.shown ? "Hide on map" : "Show on map"} onClick={() => engine?.sight.update(p.id, { shown: !p.shown })}>
          {p.shown ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <IconButton size="sm" label="Delete pair" onClick={() => engine?.sight.remove(p.id)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {open && (
        <div className="border-t border-line p-2">
          <ProfileChart pair={p} />
          <div className="mt-1 flex justify-end">
            <button type="button" className="btn-ghost h-7 px-2 text-[12px]" disabled={p.computing} onClick={() => saveText(`profile-${slug(p.name)}.csv`, profileToCsv(p))}>
              <Download size={13} /> Profile CSV
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <NumberField label={`A${n} above ground`} value={p.aHeight} onChange={(v) => engine?.sight.update(p.id, { aHeight: v })} />
            <NumberField label={`B${n} above ground`} value={p.bHeight} onChange={(v) => engine?.sight.update(p.id, { bHeight: v })} />
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-fg3">A{n} ground</dt>
            <dd className="num text-fg2">{p.a.h.toFixed(1)} m</dd>
            <dt className="text-fg3">B{n} ground</dt>
            <dd className="num text-fg2">{p.b.h.toFixed(1)} m</dd>
            <dt className="text-fg3">{p.visible ? "Smallest clearance" : "Worst obstruction"}</dt>
            <dd className="num text-fg2">{Math.abs(p.worstDeficit).toFixed(1)} m</dd>
          </dl>
        </div>
      )}
    </li>
  );
}

function ViewshedSection() {
  const engine = useEngine();
  const s = useSignal(engine?.viewshed.state, null);
  const placing = useSignal(engine?.viewshed.placing, false);
  const set = useApp((x) => x.set);
  return (
    <section className="rounded-[10px] border border-line bg-s2 p-3">
      <h3 className="mb-1 flex items-center gap-2 font-semibold">
        <Radar size={15} className="text-accent" /> 360° visibility
      </h3>
      <p className="mb-2 text-[12px] text-fg3">
        {placing
          ? "Click where the observer stands."
          : s
            ? "Drag the white eye to move it. Shift + drag up or down to change its height. The map updates as you move."
            : "Everything the observer can see within the radius turns green; hidden ground and walls turn red."}
      </p>
      {s && (
        <div className="mb-2 flex flex-col gap-2">
          <Slider
            label="Eye height above ground"
            value={s.height}
            min={0.5}
            max={500}
            log
            format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} m`}
            onChange={(v) => engine?.viewshed.setHeight(v)}
          />
          <Slider label="Radius" value={s.radius} min={100} max={5000} log format={fmtDist} onChange={(v) => engine?.viewshed.setRadius(v)} />
          <div className="num text-[11px] text-fg3" dir="ltr">
            {s.lat.toFixed(5)}°, {s.lon.toFixed(5)}° · ground {s.ground.toFixed(1)} m · eye {(s.ground + s.height).toFixed(1)} m
          </div>
          <div className="flex gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1 text-fg2">
              <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--ok)" }} /> Visible
            </span>
            <span className="inline-flex items-center gap-1 text-fg2">
              <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--bad)" }} /> Hidden
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={placing ? "btn-secondary" : "btn-primary"} onClick={() => set({ tool: placing ? "none" : "viewshed" })}>
          {placing ? "Cancel" : s ? "Move observer" : "Place observer"} <span className="num opacity-70">V</span>
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
            <X size={14} /> Clear
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
