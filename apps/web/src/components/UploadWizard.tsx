import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkFiles, converterForEpsg, fmtBytes, gridFactors, placementFromGrid, prepareFiles, type CheckItem, type CheckReport, type LocalFile } from "@viewer/core";
import { uploadAndIngest, type UploadProgress } from "../server/api";
import { refreshLibrary } from "../state/library";
import { UPDATE_STATUSES, type ModelSummary, type UpdateStatus } from "@viewer/shared";
import { useEngine } from "../engine";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { fromDrop, fromInput, suggestLayer } from "../upload/read-drop";
import { Check, ChevronLeft, ChevronRight, Upload, Wand2, X, AlertTriangle, FolderOpen, XCircle } from "./icons";
import { IconButton, cx } from "./primitives";
import { useLevels } from "../state/classification";
import { arrangeWhenOpen } from "../layers-standard";

const STEPS = ["drop", "check", "place", "layers", "details"] as const;

const CRS = [
  // Labels are i18n keys (wizard.*), or a plain EPSG code for a system a sidecar file names.
  { code: 4326, label: "wizard.crs4326", x: "wizard.lon", y: "wizard.lat" },
  { code: 2039, label: "wizard.crs2039", x: "wizard.easting", y: "wizard.northing" },
  { code: 32636, label: "wizard.crs32636", x: "wizard.easting", y: "wizard.northing" },
  { code: 6991, label: "wizard.crs6991", x: "wizard.easting", y: "wizard.northing" },
] as { code: number; label: string; x: string; y: string }[];

/** The list, plus the system a sidecar file names when it is another one. */
const crsList = (extra?: number) => (extra && !CRS.some((c) => c.code === extra) ? [...CRS, { code: extra, label: `EPSG:${extra}`, x: "wizard.easting", y: "wizard.northing" }] : CRS);

const NEW_PLACE: Place = { fromFile: true, fitGround: true, crs: 4326, x: "", y: "", onTerrain: true, height: "0", heading: "0", scale: "1", upAxis: "y", unit: 1 };

interface Place {
  fromFile: boolean;
  /** Georeferenced files: move them up or down so their lowest surfaces meet the terrain. */
  fitGround: boolean;
  crs: number;
  x: string;
  y: string;
  onTerrain: boolean;
  height: string;
  heading: string;
  scale: string;
  /** The file's up axis: y for glTF, z for many CAD and FBX exports. */
  upAxis: "y" | "z";
  /** Metres per file unit. */
  unit: number;
}

/**
 * Five-step upload (UI spec §3.4). The files are read and checked in the browser, and the
 * model is added to this session's library. The server keeps them from Phase 3 on.
 */
export function UploadWizard() {
  const levels = useLevels();
  const { t, i18n } = useTranslation();
  /** A check report line in the interface language; lines without a key (older servers) stay as sent. */
  const itemText = (it: CheckItem) => ({
    title: it.key ? t(`checks.${it.key}.title`, it.params) : it.title,
    detail: it.key && i18n.exists(`checks.${it.key}.detail`, it.params) ? t(`checks.${it.key}.detail`, it.params) : it.detail,
  });
  const open = useApp((s) => s.uploadOpen);
  const set = useApp((s) => s.set);
  const addUpload = useApp((s) => s.addUpload);
  const engine = useEngine();
  const { open: openModel } = useOpenModel();
  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ report: CheckReport; files: LocalFile[] } | null>(null);
  const [place, setPlace] = useState<Place>(NEW_PLACE);
  const [meta, setMeta] = useState({ name: "", project: "", operation: "", entity: "", status: "draft" as UpdateStatus, description: "" });
  const [cls, setCls] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  // Gather the parts under the suggested standard names when the model is published (UPL-09).
  const [arrange, setArrange] = useState(true);
  const server = useApp((s) => s.server);
  const folderInput = useRef<HTMLInputElement>(null);
  const chosen = levels.find((c) => c.id === cls);
  const report = checked?.report ?? null;

  useEffect(() => {
    if (!files.length) return;
    let live = true;
    setChecking(true);
    setChecked(null);
    void checkFiles(files).then((r) => {
      if (!live) return;
      setChecked(r);
      setChecking(false);
      setStep((s) => (s === 0 ? 1 : s));
      const main = r.report.mainFile ?? files[0]!.path;
      const stem = main.split("/").pop()!.replace(/\.[^.]+$/, "");
      const top = files[0]!.path.includes("/") ? files[0]!.path.split("/")[0]! : "";
      setMeta((m) => ({ ...m, name: m.name || (stem === "tileset" && top ? top : stem).replace(/[_-]+/g, " ") }));
      const c = engine?.viewCentre();
      const fp = r.report.filePosition;
      if (fp) setPlace((p) => ({ ...p, fromFile: false, crs: fp.epsg, x: fp.x.toFixed(fp.epsg === 4326 ? 7 : 3), y: fp.y.toFixed(fp.epsg === 4326 ? 7 : 3), height: String(fp.height), onTerrain: false }));
      else setPlace((p) => ({ ...p, fromFile: !!r.report.georef, crs: 4326, x: c ? c.lon.toFixed(6) : "35.2137", y: c ? c.lat.toFixed(6) : "31.7683" }));
    });
    return () => {
      live = false;
    };
  }, [files, engine]);

  const layers = useMemo(() => (report?.nodes ?? []).slice(0, 60).map((n) => ({ name: n, to: suggestLayer(n) })), [report]);

  if (!open) return null;
  const close = () => {
    set({ uploadOpen: false });
    setStep(0);
    setFiles([]);
    setChecked(null);
    setCls("");
    setMeta({ name: "", project: "", operation: "", entity: "", status: "draft", description: "" });
    // The next upload starts from the defaults, not the last model's axis, units or heading.
    setPlace(NEW_PLACE);
    setPublishError(null);
  };

  const browserCanOpen = report?.ok && report.format !== "fbx";
  const placeOk = place.fromFile && report?.georef ? true : Number.isFinite(parseFloat(place.x)) && Number.isFinite(parseFloat(place.y));
  const canNext = step === 0 ? !!report : step === 1 ? !!report?.ok : step === 2 ? placeOk : true;
  // The server converts FBX; without it only what the browser opens can be published.
  const canPublish = !!cls && (server ? !!report?.ok : !!browserCanOpen) && meta.name.trim() !== "" && !publishing;

  /** The file's own position, or the Place step's, with grid north and grid scale applied. */
  const position = (r: CheckReport) => {
    const useFile = !!(place.fromFile && r.georef);
    if (useFile) return { useFile, lat: r.georef!.lat, lon: r.georef!.lon, placement: undefined };
    const placement = placementFromGrid({
      epsg: place.crs,
      x: parseFloat(place.x),
      y: parseFloat(place.y),
      height: parseFloat(place.height) || 0,
      aboveGround: place.onTerrain ? 0 : undefined,
      headingDeg: parseFloat(place.heading) || 0,
      scale: (parseFloat(place.scale) || 1) * (place.unit || 1),
      upAxis: place.upAxis,
    });
    // One file unit is drawn placement.scale metres long: measurements divide by it.
    if (!place.unit) placement.modelUnit = placement.scale;
    return { useFile, lat: placement.lat, lon: placement.lon, placement };
  };

  /** With a server: send the files, let it check, scan, convert and publish, then open the result. */
  const publishToServer = async (srv: NonNullable<typeof server>, r: CheckReport) => {
    const { useFile, placement } = position(r);
    const status = await uploadAndIngest(
      srv,
      files,
      {
        model: {
          name: meta.name.trim(),
          project: meta.project.trim() || "Uploads",
          operation: meta.operation.trim(),
          responsibleEntity: meta.entity.trim(),
          description: meta.description.trim(),
          status: meta.status,
          classificationId: cls,
        },
        placement,
        groundFit: r.format === "3dtiles" && useFile ? (place.fitGround ? "street" : "none") : undefined,
      },
      setProgress,
    );
    if (status.state !== "ready" || !status.modelId) {
      const problems = status.report?.items.filter((i) => i.severity === "error").map((i) => { const x = itemText(i); return x.title + (x.detail ? `: ${x.detail}` : ""); }) ?? [];
      throw new Error([status.error ?? t("wizard.serverFailed"), ...problems].join("\n"));
    }
    await refreshLibrary();
    close();
    setTimeout(() => {
      openModel(status.modelId!);
      if (arrange && layers.length && engine) void arrangeWhenOpen(engine, srv, status.modelId!, t).catch((e: unknown) => console.warn(e));
    }, 0);
  };

  const publish = async () => {
    if (!report || !checked) return;
    setPublishing(true);
    setPublishError(null);
    setProgress(null);
    try {
      if (server) return await publishToServer(server, report);
      const prepared = await prepareFiles(checked.files, report);
      const { useFile, lat, lon, placement } = position(report);
      const id = `upload-${Date.now().toString(36)}`;
      const isTiles = prepared.kind === "3dtiles";
      const m: ModelSummary = {
        id,
        name: meta.name.trim(),
        project: meta.project.trim() || "Uploads",
        operation: meta.operation.trim() || "—",
        responsibleEntity: meta.entity.trim() || "—",
        description: meta.description.trim(),
        status: meta.status,
        statusChangedAt: new Date().toISOString().slice(0, 10),
        classificationId: cls,
        version: 1,
        versions: 1,
        sourceFormat: report.format ?? "glb",
        source: {
          kind: prepared.kind,
          url: prepared.url,
          groundFit: isTiles && useFile ? (place.fitGround ? "street" : "none") : undefined,
          localFrame: isTiles && !useFile ? true : undefined,
          georeferenced: !isTiles && useFile ? true : undefined,
          attribution: "Uploaded in this session",
        },
        centre: { lat, lon },
        placement,
        sizeBytes: report.stats.bytes,
      };
      addUpload(m);
      close();
      // Let the store update reach the library before opening.
      setTimeout(() => openModel(id), 0);
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const crsOptions = crsList(report?.filePosition?.epsg);
  const crs = crsOptions.find((c) => c.code === place.crs) ?? crsOptions[0]!;
  const grid = (() => {
    if (place.crs === 4326) return null;
    try {
      const x = parseFloat(place.x);
      const y = parseFloat(place.y);
      return Number.isFinite(x) && Number.isFinite(y) ? gridFactors(place.crs, x, y) : null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
      <div role="dialog" aria-label={t("upload.title")} className="glass flex h-[min(720px,90vh)] w-[min(980px,96vw)] flex-col rounded-[16px]">
        <header className="flex items-center gap-4 border-b border-line px-5 h-14">
          <h2 className="text-[15px] font-semibold">{t("upload.title")}</h2>
          <ol className="flex flex-1 items-center justify-center gap-1">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                <span
                  className={cx(
                    "grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold num",
                    i < step ? "bg-accent text-accent-on" : i === step ? "border-2 border-accent text-accent" : "border border-line-strong text-fg3",
                  )}
                >
                  {i < step ? <Check size={12} /> : i + 1}
                </span>
                <span className={cx("text-[12px] font-medium", i === step ? "text-fg" : "text-fg3")}>{t(`upload.steps.${s}`)}</span>
                {i < STEPS.length - 1 && <span className="mx-2 h-px w-6 bg-line-strong" />}
              </li>
            ))}
          </ol>
          <IconButton label={t("common.close")} onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {step === 0 && (
            <div
              className="flex h-full min-h-80 flex-col items-center justify-center gap-3 rounded-[14px] border-2 border-dashed border-line-strong text-center hover:border-accent"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void fromDrop(e.dataTransfer).then(setFiles);
              }}
              data-testid="upload-drop"
            >
              <Upload size={32} className="text-accent" />
              <div className="text-[16px] font-semibold">{t("upload.dropTitle")}</div>
              <div className="max-w-md text-fg3">{t("upload.dropHint")}</div>
              <div className="mt-2 flex gap-2">
                <label className="btn-secondary cursor-pointer">
                  {t("upload.choose")}
                  <input type="file" multiple className="hidden" accept=".glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.zip,.json,.b3dm,.i3dm,.pnts,.cmpt,.fbx" onChange={(e) => setFiles(fromInput(e.target.files))} />
                </label>
                <button type="button" className="btn-secondary" onClick={() => folderInput.current?.click()}>
                  <FolderOpen size={14} /> {t("shell.chooseFolder")}
                </button>
                <input
                  ref={(el) => {
                    folderInput.current = el;
                    el?.setAttribute("webkitdirectory", "");
                  }}
                  type="file"
                  className="hidden"
                  onChange={(e) => setFiles(fromInput(e.target.files))}
                />
              </div>
              {checking && <p className="text-fg3">{t("wizard.reading", { count: files.length })}</p>}
            </div>
          )}
          {step === 1 && report && (
            <div className="mx-auto max-w-xl space-y-3">
              <p className="text-fg3">
                {report.mainFile ?? t("wizard.noModelFile")} · {t("wizard.files", { count: report.stats.files })}
                {report.stats.triangles !== undefined && ` · ${t("wizard.triangles", { n: report.stats.triangles.toLocaleString() })}`}
                {report.stats.textures !== undefined && ` · ${t("wizard.textures", { n: report.stats.textures })}`}
                {report.stats.tiles !== undefined && ` · ${t("wizard.tiles", { n: report.stats.tiles.toLocaleString() })}`}
              </p>
              <ul className="space-y-2" data-testid="upload-report">
                {report.items.map((it, i) => (
                  <li key={i} className="flex items-start gap-3 rounded-[10px] bg-s2 p-3">
                    {it.severity === "ok" ? (
                      <Check size={18} className="mt-0.5 shrink-0 text-[var(--status-current)]" />
                    ) : it.severity === "warning" ? (
                      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--status-production)]" />
                    ) : (
                      <XCircle size={18} className="mt-0.5 shrink-0 text-[var(--danger,#e5484d)]" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block">{itemText(it).title}</span>
                      {itemText(it).detail && <span className="block break-words text-[12px] text-fg3">{itemText(it).detail}</span>}
                    </span>
                  </li>
                ))}
                <li className="flex items-center gap-3 rounded-[10px] bg-s2 p-3 text-fg3">
                  <AlertTriangle size={18} className="shrink-0" />
                  <span>{t("upload.checks.antivirus")}: {server ? t("wizard.avOnServer") : t("wizard.avNoServer")}</span>
                </li>
              </ul>
              {!report.ok && <p className="text-[12px] text-fg3">{t("wizard.fixProblems")}</p>}
              <button type="button" className="btn-ghost" onClick={() => { setFiles([]); setChecked(null); setStep(0); }}>
                {t("wizard.otherFiles")}
              </button>
            </div>
          )}
          {step === 2 && report && (
            <div className="mx-auto grid max-w-2xl gap-4">
              <div>
                <h3 className="text-[15px] font-semibold">{t("upload.placeTitle")}</h3>
                <p className="text-fg3">
                  {report.georef
                    ? t("wizard.hasPosition")
                    : report.filePosition
                      ? t("wizard.positionFrom", { source: report.filePosition.source })
                      : t("wizard.noPosition")}
                </p>
              </div>
              {report.georef && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={place.fromFile} onChange={(e) => setPlace({ ...place, fromFile: e.target.checked })} />
                  {t("wizard.useFilePosition", { lat: report.georef.lat.toFixed(5), lon: report.georef.lon.toFixed(5) })}
                </label>
              )}
              {place.fromFile && report.georef && report.format === "3dtiles" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={place.fitGround} onChange={(e) => setPlace({ ...place, fitGround: e.target.checked })} />
                  {t("wizard.fitGround")}
                </label>
              )}
              {!(place.fromFile && report.georef) && (
                <>
                  <Field label={t("upload.crs")}>
                    <select
                      className="input"
                      value={place.crs}
                      onChange={(e) => {
                        const code = Number(e.target.value);
                        const from = converterForEpsg(place.crs);
                        const to = converterForEpsg(code);
                        const [lon, lat] = from.toLonLat(parseFloat(place.x), parseFloat(place.y));
                        const [x, y] = to.fromLonLat(lon, lat);
                        const dp = code === 4326 ? 6 : 2;
                        setPlace({ ...place, crs: code, x: Number.isFinite(x) ? x.toFixed(dp) : place.x, y: Number.isFinite(y) ? y.toFixed(dp) : place.y });
                      }}
                    >
                      {crsOptions.map((c) => (
                        <option key={c.code} value={c.code}>{t(c.label)}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t(crs.x)}><input className="input num" value={place.x} onChange={(e) => setPlace({ ...place, x: e.target.value })} dir="ltr" /></Field>
                    <Field label={t(crs.y)}><input className="input num" value={place.y} onChange={(e) => setPlace({ ...place, y: e.target.value })} dir="ltr" /></Field>
                  </div>
                  {grid && (
                    <p className="text-[12px] text-fg3" data-testid="grid-factors">
                      {t(grid.northDeg >= 0 ? "wizard.gridNorthEast" : "wizard.gridNorthWest", { deg: Math.abs(grid.northDeg).toFixed(3), scale: grid.groundPerGrid.toFixed(6) })}
                    </p>
                  )}
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={place.onTerrain} onChange={(e) => setPlace({ ...place, onTerrain: e.target.checked })} />
                    {t("wizard.onTerrain")}
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={place.onTerrain ? t("wizard.heightNoTerrain") : t("wizard.heightEllipsoid")}><input className="input num" value={place.height} onChange={(e) => setPlace({ ...place, height: e.target.value })} dir="ltr" /></Field>
                    <Field label={place.crs === 4326 ? t("wizard.headingNorth") : t("wizard.headingGrid")}><input className="input num" value={place.heading} onChange={(e) => setPlace({ ...place, heading: e.target.value })} dir="ltr" /></Field>
                    <Field label={t("wizard.scale")}><input className="input num" value={place.scale} onChange={(e) => setPlace({ ...place, scale: e.target.value })} dir="ltr" /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("wizard.upAxis")}>
                      <select className="input" data-testid="up-axis" value={place.upAxis} onChange={(e) => setPlace({ ...place, upAxis: e.target.value as "y" | "z" })}>
                        <option value="y">{t("wizard.yUp")}</option>
                        <option value="z">{t("wizard.zUp")}</option>
                      </select>
                    </Field>
                    <Field label={t("wizard.units")}>
                      <select className="input" data-testid="file-units" value={place.unit} onChange={(e) => setPlace({ ...place, unit: Number(e.target.value) })}>
                        {UNITS.map(([label, f]) => (
                          <option key={label} value={f}>
                            {t(label)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <SizeReadout size={report?.stats.size} place={place} fbx={report?.format === "fbx"} />
                  {!place.unit && <p className="text-[12px] text-[var(--status-production)]" data-testid="units-unknown">{t("wizard.unitsUnknownHint")}</p>}
                </>
              )}
              <p className="text-[12px] text-fg3">{t("wizard.adjustLater")}</p>
            </div>
          )}
          {step === 3 && (
            <div className="mx-auto grid max-w-3xl gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-semibold">{t("upload.layersTitle")}</h3>
                  <p className="text-fg3">{layers.length ? t("wizard.layersSuggested") : t("wizard.layersTiles")}</p>
                </div>
                {layers.length > 0 && <span className="inline-flex items-center gap-1 text-[12px] text-fg3"><Wand2 size={14} /> {t("wizard.suggested")}</span>}
              </div>
              {layers.length > 0 && (
                <div className="rounded-[10px] bg-s2 p-2">
                  {layers.map((l, i) => (
                    <div key={i} className="grid h-9 grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-[6px] px-2 hover:bg-s3 text-[12px]">
                      <span className="num truncate text-fg2">{l.name}</span>
                      <span className="text-fg3">→</span>
                      <span className="text-accent">{l.to}</span>
                    </div>
                  ))}
                  {(report?.nodes.length ?? 0) > layers.length && <p className="px-2 py-1 text-[12px] text-fg3">{t("wizard.andMore", { n: report!.nodes.length - layers.length })}</p>}
                </div>
              )}
              {layers.length > 0 && server && (
                <label className="flex items-start gap-2 text-[12px]">
                  <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={arrange} onChange={(e) => setArrange(e.target.checked)} />
                  <span>
                    <span className="text-fg">{t("wizard.arrangeOnPublish")}</span>
                    <span className="block text-fg3">{t("wizard.arrangeLater")}</span>
                  </span>
                </label>
              )}
            </div>
          )}
          {step === 4 && (
            <div className="mx-auto grid max-w-2xl grid-cols-2 gap-3">
              <Field label={`${t("upload.fields.name")} *`}><input className="input" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></Field>
              <Field label={t("upload.fields.project")}><input className="input" value={meta.project} onChange={(e) => setMeta({ ...meta, project: e.target.value })} /></Field>
              <Field label={t("upload.fields.operation")}><input className="input" value={meta.operation} onChange={(e) => setMeta({ ...meta, operation: e.target.value })} /></Field>
              <Field label={t("upload.fields.entity")}><input className="input" value={meta.entity} onChange={(e) => setMeta({ ...meta, entity: e.target.value })} /></Field>
              <Field label={t("upload.fields.status")}>
                <select className="input" value={meta.status} onChange={(e) => setMeta({ ...meta, status: e.target.value as UpdateStatus })}>
                  {UPDATE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
                </select>
              </Field>
              <Field label={`${t("upload.fields.classification")} *`}>
                <select
                  className="input font-semibold"
                  required
                  aria-required="true"
                  value={cls}
                  onChange={(e) => setCls(e.target.value)}
                  style={chosen ? { background: chosen.color, color: chosen.textColor } : undefined}
                >
                  <option value="" disabled>
                    {t("wizard.chooseClass")}
                  </option>
                  {levels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label.replace(/ · .*$/, "")}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="col-span-2"><Field label={t("upload.fields.description")}><textarea className="input h-24 py-2" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field></div>
              <p className="col-span-2 text-[12px] text-fg3">
                {report && fmtBytes(report.stats.bytes)} ·{" "}
                {server ? t("wizard.publishServer") : t("wizard.publishLocal")}
              </p>
              {progress && publishing && (
                <div className="col-span-2 flex flex-col gap-1.5" data-testid="upload-progress">
                  <div className="h-1.5 overflow-hidden rounded-full bg-s3">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? Math.round((progress.sent / progress.total) * 100) : 100}%` }} />
                  </div>
                  <span className="text-[12px] text-fg3">
                    {progress.step === "upload" ? t("wizard.sending", { sent: fmtBytes(progress.sent), total: fmtBytes(progress.total) }) : isStepKey(progress.step) ? t(`wizard.step.${progress.step}`) : t("wizard.working")}
                  </span>
                </div>
              )}
              {publishError && <p className="col-span-2 whitespace-pre-line rounded-[8px] bg-s2 p-3 text-[12px]" data-testid="publish-error">{publishError}</p>}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-line px-5 h-14">
          <button type="button" className="btn-ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            <ChevronLeft size={14} className="rtl:-scale-x-100" /> {t("common.back")}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn-primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              {t("common.next")} <ChevronRight size={14} className="rtl:-scale-x-100" />
            </button>
          ) : (
            <span className="flex items-center gap-3">
              {report?.format === "fbx" && !server ? (
                <span className="text-[12px] text-fg3">{t("wizard.fbxNeedsServer")}</span>
              ) : !cls ? (
                <span className="text-[12px] text-fg3">{t("wizard.needClass")}</span>
              ) : null}
              <button type="button" className="btn-primary" disabled={!canPublish} onClick={() => void publish()}>
                <Upload size={14} /> {publishing ? t("wizard.publishing") : t("upload.publish")}
              </button>
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

const UNITS = [
  ["wizard.metres", 1],
  ["wizard.centimetres", 0.01],
  ["wizard.millimetres", 0.001],
  ["wizard.feet", 0.3048],
  ["wizard.inches", 0.0254],
  // No reliable scale (MSR-06): drawn as if in metres, measured in model units.
  ["wizard.unitsUnknown", 0],
] as const;

/** The model's size as it will stand on the ground, so a wrong unit or up axis shows before publishing. */
function SizeReadout({ size, place, fbx }: { size?: [number, number, number]; place: Place; fbx: boolean }) {
  const { t } = useTranslation();
  if (!size) return <p className="text-[12px] text-fg3">{fbx ? t("wizard.sizeAfterFbx") : t("wizard.noSize")}</p>;
  const k = (parseFloat(place.scale) || 1) * (place.unit || 1);
  // glTF y-up: x east-west, z north-south, y height. Z-up files: y north-south, z height.
  const [w, d, h] = place.upAxis === "z" ? [size[0], size[1], size[2]] : [size[0], size[2], size[1]];
  const f = (v: number) => (v * k >= 100 ? (v * k).toFixed(0) : (v * k).toPrecision(3));
  const odd = Math.max(w, d, h) * k > 2000 || Math.max(w, d, h) * k < 0.05;
  return (
    <p className={cx("text-[12px]", odd ? "text-[var(--status-production)]" : "text-fg2")} data-testid="model-size">
      {t("wizard.size", { w: f(w), d: f(d), h: f(h) })}
      {odd ? ` ${t("wizard.sizeOdd")}` : ""}
    </p>
  );
}

/** Server job steps with their own text (wizard.step.*). */
const STEP_KEYS = ["queued", "unpack", "check", "scan", "convert", "validate", "tile", "optimise", "publish"] as const;
const isStepKey = (s: string): s is (typeof STEP_KEYS)[number] => (STEP_KEYS as readonly string[]).includes(s);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-fg3">{label}</span>
      {children}
    </label>
  );
}
