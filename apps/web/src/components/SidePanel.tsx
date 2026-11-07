import { useState } from "react";
import { useClassOf, useLevels } from "../state/classification";
import { useTranslation } from "react-i18next";
import { ecefToGeodetic, formatCoordinate, formatLength, formatModelLength, type Measurement } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { AlertTriangle, Bookmark, Copy, Eye, EyeOff, Info, Orbit, Play, Route, Ruler, StopCircle, Trash2, Video, X } from "./icons";
import { IconButton, Panel, Segmented, StatusBadge, cx } from "./primitives";
import { AnalysisTab } from "./AnalysisTab";

/** Right panel: Measurements (MSR-04/05), Properties (UPL-04) and Fly-by tours. */
export function SidePanel({ onClose, className }: { onClose?: () => void; className?: string }) {
  const { t } = useTranslation();
  const tab = useApp((s) => s.rightTab);
  const set = useApp((s) => s.set);
  return (
    <Panel className={cx("w-[340px] max-h-full", className)}>
      <header className="flex h-11 shrink-0 items-center gap-1 ps-1.5 pe-1.5 border-b border-line">
        <div role="tablist" className="flex flex-1 gap-0.5">
          {(
            [
              ["measure", t("viewer.measurements")],
              ["analysis", t("side.analysis")],
              ["props", t("viewer.properties")],
              ["tours", t("side.flyBy")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              type="button"
              onClick={() => set({ rightTab: id })}
              className={cx(
                "h-8 whitespace-nowrap rounded-[6px] px-2 text-[13px] font-medium",
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
        {tab === "analysis" && <AnalysisTab />}
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
  const modelUnit = useSignal(engine?.measure.modelUnit, null);
  return (
    <div className="flex flex-col gap-2 p-2">
      {modelUnit !== null && (
        <div role="status" data-testid="model-units" className="flex items-start gap-2 rounded-[10px] border border-[var(--status-production)] px-2.5 py-2 text-[12px] text-fg">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--status-production)]" />
          {t("measure.modelUnits")}
        </div>
      )}
      {/* m or ft means nothing for a model without a reliable scale. */}
      {modelUnit === null && (
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
      )}
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

/**
 * How the panel writes a length: in the chosen unit, or in model units when the open model has
 * no reliable scale (MSR-06), as the labels in the view do.
 */
function useLength(unit: "m" | "ft"): (metres: number, locale?: string) => string {
  const { t } = useTranslation();
  const engine = useEngine();
  const modelUnit = useSignal(engine?.measure.modelUnit, null);
  return (metres, locale) => (modelUnit ? formatModelLength(metres / modelUnit, t("measure.modelUnitName"), locale) : formatLength(metres, unit, locale));
}

function MeasurementCard({ m, unit, locale }: { m: Measurement; unit: "m" | "ft"; locale: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const length = useLength(unit);
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
      `${t("measure.d3")}: ${length(r.total3d)}`,
      ...rows.map(([k, v]) => `${k}: ${length(v)}`),
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
        {length(r.total3d, locale === "he" ? "en" : locale)}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] text-fg3">{k}</dt>
            <dd className="num text-fg2" dir="ltr">
              {k === t("measure.height") && v > 0 ? "+" : ""}
              {length(v)}
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
                <span>{length(s.distance3d)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

function PropertiesTab() {
  const levels = useLevels();
  const { t } = useTranslation();
  const engine = useEngine();
  const model = useSignal(engine?.current, null);
  const classOf = useClassOf();
  const setClassification = useApp((s) => s.setClassification);
  if (!model) return <p className="p-4 text-fg3">—</p>;
  const cls = classOf(model);
  const rows: [string, string][] = [
    [t("upload.fields.project"), model.project],
    [t("upload.fields.operation"), model.operation],
    [t("upload.fields.entity"), model.responsibleEntity],
    [t("viewer.version"), `v${model.version} / ${model.versions}`],
    [t("side.format"), model.sourceFormat.toUpperCase()],
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
      <label className="flex items-center justify-between gap-2">
        <span className="text-fg3">{t("side.classification")}</span>
        <select
          value={cls.id}
          onChange={(e) => setClassification(model.id, e.target.value)}
          className="h-8 rounded-[6px] border border-line bg-s1solid px-2 text-[12px] font-semibold"
          aria-label={t("side.classificationOf")}
        >
          {levels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label.replace(/ · .*$/, "")}
            </option>
          ))}
        </select>
      </label>
      <p className="text-fg2">{model.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg3">{k}</dt>
            <dd className="text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <GroundOffset />
      <LodSection />
      <div className="flex items-start gap-2 rounded-[8px] bg-s2 p-2 text-[12px] text-fg3">
        <Info size={14} className="mt-0.5 shrink-0" />
        {t("side.readOnly")}
      </div>
    </div>
  );
}

function ToursTab() {
  const { t } = useTranslation();
  const engine = useEngine();
  const running = useSignal(engine?.tour.running, null);
  const views = useSignal(engine?.viewpoints, []);
  const flying = useSignal(engine?.fly.enabled, false);
  const setTool = useApp((s) => s.set);
  return (
    <div className="flex flex-col gap-3 p-3">
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Orbit size={15} className="text-accent" /> {t("side.orbit")}
        </h3>
        <p className="mb-2 text-fg3 text-[12px]">{t("side.orbitText")}</p>
        {running === "orbit" ? (
          <button type="button" className="btn-secondary" onClick={() => engine?.tour.stop()}>
            <StopCircle size={14} /> {t("side.stop")}
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => engine?.startOrbitTour()} disabled={!engine?.boundingSphere()}>
            <Play size={14} /> {t("side.startOrbit")}
          </button>
        )}
      </section>
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Video size={15} className="text-accent" /> {t("side.tour")}
        </h3>
        <p className="mb-2 text-fg3 text-[12px]">{t("side.tourText")}</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {views.map((_, i) => (
            <span key={i} className="num inline-flex h-6 items-center gap-1 rounded-full bg-s3 px-2 text-[12px] text-fg2">
              <Bookmark size={12} /> {i + 1}
            </span>
          ))}
          {!views.length && <span className="text-[12px] text-fg3">{t("side.noViews")}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-secondary" onClick={() => engine?.saveViewpoint()}>
            <Bookmark size={14} /> {t("side.saveView")}
          </button>
          {running === "viewpoints" ? (
            <button type="button" className="btn-secondary" onClick={() => engine?.tour.stop()}>
              <StopCircle size={14} /> {t("side.stop")}
            </button>
          ) : (
            <button type="button" className="btn-primary" disabled={views.length < 2} onClick={() => engine?.startViewpointTour()}>
              <Play size={14} /> {t("side.playTour")}
            </button>
          )}
          {views.length > 0 && (
            <button type="button" className="btn-ghost" onClick={() => engine?.clearViewpoints()}>
              {t("misc.clear")}
            </button>
          )}
        </div>
      </section>
      <section className="rounded-[10px] border border-line bg-s2 p-3">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">{t("side.flyMode")}</h3>
        <p className="mb-2 text-fg3 text-[12px]">
          {t("side.flyText")}
        </p>
        <button type="button" className={flying ? "btn-secondary" : "btn-primary"} onClick={() => setTool({ tool: flying ? "none" : "fly" })}>
          {flying ? t("side.exitFly") : t("side.enterFly")} <span className="num opacity-70">G</span>
        </button>
      </section>
    </div>
  );
}

/** Fine height adjustment of the open model against the terrain (VWR-GEO-02). */
function GroundOffset() {
  const { t } = useTranslation();
  const engine = useEngine();
  const offset = useSignal(engine?.groundOffset, 0);
  const terrain = useSignal(engine?.terrainId, "none");
  return (
    <section className="rounded-[8px] border border-line bg-s2 p-2">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <span className="font-medium">{t("side.heightOnTerrain")}</span>
        <span className="num text-fg2" dir="ltr">
          {offset >= 0 ? "+" : ""}
          {offset.toFixed(1)} m
        </span>
      </div>
      <input
        type="range"
        min={-200}
        max={200}
        step={0.1}
        value={Math.max(-200, Math.min(200, offset))}
        onChange={(e) => engine?.setGroundOffset(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
        aria-label={t("side.heightOnTerrain")}
      />
      <div className="mt-1 flex items-center justify-between text-[11px] text-fg3">
        <span>{terrain === "none" ? t("side.noTerrain") : t("side.autoHeight")}</span>
        <button type="button" className="text-accent hover:underline" onClick={() => void engine?.placeOnGround()}>
          {t("side.reset")}
        </button>
      </div>
    </section>
  );
}

const LOD_RAMP = ["#FFE8A3", "#FFC66B", "#FF9F4A", "#F2703F", "#D9463E", "#B02A4D", "#7E1F5C", "#52205F", "#2E1F57", "#1B2A57"];

/** Level-of-detail inspector for 3D Tiles (VWR-LOD-01). */
function LodSection() {
  const { t } = useTranslation();
  const engine = useEngine();
  const stats = useSignal(engine?.lod.stats, null);
  const s = useSignal(engine?.lod.settings, { sse: 8, colorByDepth: false, bounds: false, freeze: false });
  if (!stats) return null;
  const set = (p: Partial<typeof s>) => engine?.lod.set(p);
  const total = stats.perDepth.reduce((a, b) => a + b, 0) || 1;
  const toggle = (k: "colorByDepth" | "bounds" | "freeze", label: string) => (
    <label className="flex items-center gap-2 text-[12px] text-fg2">
      <input type="checkbox" checked={s[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
  const mb = (b: number) => `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)} MB`;
  return (
    <section className="rounded-[8px] border border-line bg-s2 p-2">
      <div className="mb-1 text-[12px] font-medium">{t("side.lod")}</div>
      <label className="flex flex-col gap-0.5">
        <span className="flex justify-between text-[11px] text-fg3">
          {t("side.detailSse")}
          <span className="num text-fg2">{t(s.sse <= 0 ? "side.sseFull" : s.sse < 4 ? "side.sseVeryHigh" : s.sse < 12 ? "side.sseHigh" : s.sse < 32 ? "side.sseMedium" : "side.sseLow")} · {Math.round(s.sse * 10) / 10} px</span>
        </span>
        <input
          type="range"
          min={0}
          max={1000}
          value={s.sse <= 0 ? 0 : Math.round((Math.log(s.sse) / Math.log(64)) * 1000)}
          disabled={s.sse <= 0}
          onChange={(e) => set({ sse: Math.max(1, 64 ** (Number(e.target.value) / 1000)) })}
          className="w-full accent-[var(--accent)]"
          style={{ direction: "rtl" }}
          aria-label={t("side.detail")}
        />
      </label>
      <label className="mt-1 flex items-start gap-2 text-[12px]" title={t("side.fullDetailText")}>
        <input type="checkbox" className="mt-0.5" checked={s.sse <= 0} onChange={(e) => set({ sse: e.target.checked ? 0 : 8 })} />
        <span>
          <span className="text-fg">{t("side.fullDetail")}</span>
          <span className="block text-[11px] text-fg3">{t("side.fullDetailText")}</span>
        </span>
      </label>
      <div className="mt-1 flex flex-col gap-1">
        {toggle("colorByDepth", t("side.colorByDepth"))}
        {toggle("bounds", t("side.bounds"))}
        {toggle("freeze", t("side.freeze"))}
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded-[4px] bg-s3" aria-label={t("side.perDepth")}>
        {stats.perDepth.map((n, d) =>
          n ? <span key={d} title={t("side.depthTiles", { d, n })} style={{ width: `${(n / total) * 100}%`, background: LOD_RAMP[Math.min(d, LOD_RAMP.length - 1)] }} className="border-e border-s2 last:border-0" /> : null,
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-fg3">
        <span>{t("side.coarse")}</span>
        <span>{t("side.fine", { d: stats.maxDepth })}</span>
      </div>
      <dl className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px]">
        <dt className="text-fg3">{t("side.tilesDrawn")}</dt>
        <dd className="text-fg2">{stats.drawn}</dd>
        <dt className="text-fg3">{t("side.deepest")}</dt>
        <dd className="text-fg2">{stats.maxDepth}</dd>
        {stats.points > 0 && (
          <>
            <dt className="text-fg3">{t("side.points")}</dt>
            <dd className="text-fg2">{stats.points.toLocaleString()}</dd>
          </>
        )}
        {stats.triangles > 0 && (
          <>
            <dt className="text-fg3">{t("side.triangles")}</dt>
            <dd className="text-fg2">{stats.triangles.toLocaleString()}</dd>
          </>
        )}
        <dt className="text-fg3">{t("side.gpu")}</dt>
        <dd className="text-fg2">{mb(stats.memory)}</dd>
        <dt className="text-fg3">{t("side.loading")}</dt>
        <dd className="text-fg2">{stats.loading ? t("side.loadingTiles", { n: stats.loading }) : t("side.done")}</dd>
      </dl>
    </section>
  );
}
