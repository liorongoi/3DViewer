import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ecefToGeodetic, formatCoordinate, formatLength, type Measurement } from "@viewer/core";
import { SAMPLE_CLASSIFICATIONS } from "@viewer/shared";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Bookmark, Copy, Eye, EyeOff, Info, Orbit, Play, Route, Ruler, StopCircle, Trash2, Video, X } from "./icons";
import { IconButton, Panel, Segmented, StatusBadge, cx } from "./primitives";

/** Right panel: Measurements (MSR-04/05), Properties (UPL-04) and Fly-by tours. */
export function SidePanel({ onClose, className }: { onClose?: () => void; className?: string }) {
  const { t } = useTranslation();
  const tab = useApp((s) => s.rightTab);
  const set = useApp((s) => s.set);
  return (
    <Panel className={cx("w-[320px] max-h-full", className)}>
      <header className="flex h-11 shrink-0 items-center gap-1 ps-1.5 pe-1.5 border-b border-line">
        <div role="tablist" className="flex flex-1 gap-0.5">
          {(
            [
              ["measure", t("viewer.measurements")],
              ["props", t("viewer.properties")],
              ["tours", "Fly-by"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              type="button"
              onClick={() => set({ rightTab: id })}
              className={cx(
                "h-8 rounded-[6px] px-2.5 text-[13px] font-medium",
                tab === id ? "bg-s3 text-fg" : "text-fg3 hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {onClose && (
          <IconButton size="sm" label={t("common.close")} onClick={onClose}>
            <X size={15} />
          </IconButton>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {tab === "measure" && <MeasurementsTab />}
        {tab === "props" && <PropertiesTab />}
        {tab === "tours" && <ToursTab />}
      </div>
    </Panel>
  );
}

function MeasurementsTab() {
  const { t, i18n } = useTranslation();
  const engine = useEngine();
  const list = useSignal(engine?.measure.measurements, []);
  const unit = useApp((s) => s.unit);
  const setPref = useApp((s) => s.setPref);
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[12px] text-fg3">{t("measure.units")}</span>
        <Segmented
          label={t("measure.units")}
          value={unit}
          onChange={(u) => {
            setPref("unit", u);
            engine?.measure.setUnit(u);
          }}
          options={[
            { value: "m", label: "m", title: t("measure.metres") },
            { value: "ft", label: "ft", title: t("measure.feet") },
          ]}
        />
      </div>
      {list.length === 0 && (
        <div className="m-1 rounded-[10px] border border-dashed border-line-strong p-4 text-center text-fg3">
          <Ruler size={20} className="mx-auto mb-2 text-fg3" />
          {t("measure.empty")}
        </div>
      )}
      {list.map((m) => (
        <MeasurementCard key={m.id} m={m} unit={unit} locale={i18n.language} />
      ))}
    </div>
  );
}

function MeasurementCard({ m, unit, locale }: { m: Measurement; unit: "m" | "ft"; locale: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const coordSystem = useApp((s) => s.coordSystem);
  const [copied, setCopied] = useState(false);
  const r = m.result;
  const seg = r.segments[0];
  const rows: [string, number][] =
    m.kind === "distance" && seg
      ? [
          [t("measure.horizontal"), seg.horizontal],
          [t("measure.height"), seg.heightDelta],
        ]
      : [
          [t("measure.horizontal"), r.totalHorizontal],
          [t("measure.height"), r.heightDelta],
        ];
  const copy = async () => {
    const coords = m.points
      .map((p) => {
        const g = ecefToGeodetic(p);
        return formatCoordinate(g.lat, g.lon, g.height, coordSystem).text;
      })
      .join("\n");
    const text = [
      m.label,
      `${t("measure.d3")}: ${formatLength(r.total3d, unit)}`,
      ...rows.map(([k, v]) => `${k}: ${formatLength(v, unit)}`),
      coords,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <article className={cx("rounded-[10px] border border-line bg-s2 p-3", !m.visible && "opacity-60")}>
      <div className="mb-1 flex items-center gap-2">
        {m.kind === "distance" ? <Ruler size={14} className="text-accent" /> : <Route size={14} className="text-accent" />}
        <input
          aria-label={t("common.rename")}
          className="min-w-0 flex-1 bg-transparent font-medium outline-none focus:underline decoration-accent"
          defaultValue={m.label}
          onBlur={(e) => engine?.measure.rename(m.id, e.target.value || m.label)}
        />
        <IconButton size="sm" label={m.visible ? t("common.hide") : t("common.show")} onClick={() => engine?.measure.setVisible(m.id, !m.visible)}>
          {m.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <IconButton size="sm" label={copied ? t("common.copied") : t("measure.copyValues")} onClick={() => void copy()}>
          <Copy size={14} />
        </IconButton>
        <IconButton size="sm" label={t("common.delete")} onClick={() => engine?.measure.remove(m.id)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <div className="text-[11px] uppercase tracking-wide text-fg3">{m.kind === "path" ? t("measure.total") : t("measure.d3")}</div>
      <div className="num text-[22px] leading-7 font-medium text-fg" dir="ltr">
        {formatLength(r.total3d, unit, locale === "he" ? "en" : locale)}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] text-fg3">{k}</dt>
            <dd className="num text-fg2" dir="ltr">
              {k === t("measure.height") && v > 0 ? "+" : ""}
              {formatLength(v, unit)}
            </dd>
          </div>
        ))}
      </dl>
      {m.kind === "path" && (
        <details className="mt-2 text-[12px]">
          <summary className="cursor-pointer text-fg3">{t("measure.segments", { count: r.segments.length })}</summary>
          <ol className="mt-1 space-y-0.5">
            {r.segments.map((s, i) => (
              <li key={i} className="flex justify-between num text-fg2" dir="ltr">
                <span>{i + 1}</span>
                <span>{formatLength(s.distance3d, unit)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

function PropertiesTab() {
  const { t } = useTranslation();
  const engine = useEngine();
  const model = useSignal(engine?.current, null);
  if (!model) return <p className="p-4 text-fg3">—</p>;
  const cls = SAMPLE_CLASSIFICATIONS.find((c) => c.id === model.classificationId);
  const rows: [string, string][] = [
    [t("upload.fields.project"), model.project],
    [t("upload.fields.operation"), model.operation],
    [t("upload.fields.entity"), model.responsibleEntity],
    [t("viewer.version"), `v${model.version} / ${model.versions}`],
    ["Format", model.sourceFormat.toUpperCase()],
    [t("library.changed", { date: "" }).trim(), model.statusChangedAt],
  ];
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <StatusBadge status={model.status} compact />
        {cls && (
          <span className="rounded px-1.5 h-6 inline-flex items-center text-[11px] font-semibold" style={{ background: cls.color, color: cls.textColor }}>
            {cls.label}
          </span>
        )}
      </div>
      <p className="text-fg2">{model.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg3">{k}</dt>
            <dd className="text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-start gap-2 rounded-[8px] bg-s2 p-2 text-[12px] text-fg3">
        <Info size={14} className="mt-0.5 shrink-0" />
        Editing metadata is part of the upload portal (Phase 4). This prototype shows it read-only.
      </div>
    </div>
  );
}

function ToursTab() {
  const engine = useEngine();
  const running = useSignal(engine?.tour.running, null);
  const views = useSignal(engine?.viewpoints, []);
  const flying = useSignal(engine?.fly.enabled, false);
  const setTool = useApp((s) => s.set);
  return (
    <div className="flex flex-col gap-3 p-3">
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Orbit size={15} className="text-accent" /> Cinematic orbit
        </h3>
        <p className="mb-2 text-fg3 text-[12px]">One slow orbit around the model with a gentle rise and fall. Any input stops it.</p>
        {running === "orbit" ? (
          <button type="button" className="btn-secondary" onClick={() => engine?.tour.stop()}>
            <StopCircle size={14} /> Stop
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => engine?.startOrbitTour()} disabled={!engine?.boundingSphere()}>
            <Play size={14} /> Start orbit
          </button>
        )}
      </section>
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Video size={15} className="text-accent" /> Viewpoint tour
        </h3>
        <p className="mb-2 text-fg3 text-[12px]">Save two or more views, then fly smoothly between them on a loop.</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {views.map((_, i) => (
            <span key={i} className="num inline-flex h-6 items-center gap-1 rounded-full bg-s3 px-2 text-[12px] text-fg2">
              <Bookmark size={12} /> {i + 1}
            </span>
          ))}
          {!views.length && <span className="text-[12px] text-fg3">No saved views yet.</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-secondary" onClick={() => engine?.saveViewpoint()}>
            <Bookmark size={14} /> Save this view
          </button>
          {running === "viewpoints" ? (
            <button type="button" className="btn-secondary" onClick={() => engine?.tour.stop()}>
              <StopCircle size={14} /> Stop
            </button>
          ) : (
            <button type="button" className="btn-primary" disabled={views.length < 2} onClick={() => engine?.startViewpointTour()}>
              <Play size={14} /> Play tour
            </button>
          )}
          {views.length > 0 && (
            <button type="button" className="btn-ghost" onClick={() => engine?.clearViewpoints()}>
              Clear
            </button>
          )}
        </div>
      </section>
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">Fly mode</h3>
        <p className="mb-2 text-fg3 text-[12px]">
          Drone-style flight: W A S D to move, Q / E down and up, drag to look, Shift for 4× speed. Speed adapts to your height.
        </p>
        <button type="button" className={flying ? "btn-secondary" : "btn-primary"} onClick={() => setTool({ tool: flying ? "none" : "fly" })}>
          {flying ? "Exit fly mode" : "Enter fly mode"} <span className="num opacity-70">G</span>
        </button>
      </section>
    </div>
  );
}
