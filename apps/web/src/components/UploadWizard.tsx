import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkFiles, converterForEpsg, fmtBytes, prepareFiles, type CheckReport, type LocalFile } from "@viewer/core";
import { SAMPLE_CLASSIFICATIONS, UPDATE_STATUSES, type ModelSummary, type UpdateStatus } from "@viewer/shared";
import { useEngine } from "../engine";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { fromDrop, fromInput, suggestLayer } from "../upload/read-drop";
import { Check, ChevronLeft, ChevronRight, Upload, Wand2, X, AlertTriangle, FolderOpen, XCircle } from "./icons";
import { IconButton, cx } from "./primitives";

const STEPS = ["drop", "check", "place", "layers", "details"] as const;

const CRS = [
  { code: 4326, label: "EPSG:4326 · WGS 84 latitude / longitude", x: "Longitude (°)", y: "Latitude (°)" },
  { code: 2039, label: "EPSG:2039 · Israeli TM Grid (ITM)", x: "Easting (m)", y: "Northing (m)" },
  { code: 32636, label: "EPSG:32636 · WGS 84 / UTM zone 36N", x: "Easting (m)", y: "Northing (m)" },
] as const;

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
}

/**
 * Five-step upload (UI spec §3.4). The files are read and checked in the browser, and the
 * model is added to this session's library. The server keeps them from Phase 3 on.
 */
export function UploadWizard() {
  const { t } = useTranslation();
  const open = useApp((s) => s.uploadOpen);
  const set = useApp((s) => s.set);
  const addUpload = useApp((s) => s.addUpload);
  const engine = useEngine();
  const { open: openModel } = useOpenModel();
  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ report: CheckReport; files: LocalFile[] } | null>(null);
  const [place, setPlace] = useState<Place>({ fromFile: true, fitGround: true, crs: 4326, x: "", y: "", onTerrain: true, height: "0", heading: "0", scale: "1" });
  const [meta, setMeta] = useState({ name: "", project: "", operation: "", entity: "", status: "draft" as UpdateStatus, description: "" });
  const [cls, setCls] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const chosen = SAMPLE_CLASSIFICATIONS.find((c) => c.id === cls);
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
      setPlace((p) => ({ ...p, fromFile: !!r.report.georef, crs: 4326, x: c ? c.lon.toFixed(6) : "35.2137", y: c ? c.lat.toFixed(6) : "31.7683" }));
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
    setPublishError(null);
  };

  const browserCanOpen = report?.ok && report.format !== "fbx";
  const placeOk = place.fromFile && report?.georef ? true : Number.isFinite(parseFloat(place.x)) && Number.isFinite(parseFloat(place.y));
  const canNext = step === 0 ? !!report : step === 1 ? !!report?.ok : step === 2 ? placeOk : true;
  const canPublish = !!cls && !!browserCanOpen && meta.name.trim() !== "" && !publishing;

  const publish = async () => {
    if (!report || !checked) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const prepared = await prepareFiles(checked.files, report);
      let lat: number, lon: number, height: number;
      const useFile = place.fromFile && report.georef;
      if (useFile) ({ lat, lon, height } = report.georef!);
      else {
        [lon, lat] = converterForEpsg(place.crs).toLonLat(parseFloat(place.x), parseFloat(place.y));
        height = parseFloat(place.height) || 0;
      }
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
        source: { kind: prepared.kind, url: prepared.url, groundFit: isTiles && useFile ? (place.fitGround ? "street" : "none") : undefined, localFrame: isTiles && !useFile ? true : undefined, attribution: "Uploaded in this session" },
        centre: { lat, lon },
        placement: useFile
          ? undefined
          : { lat, lon, height, aboveGround: place.onTerrain ? 0 : undefined, headingDeg: parseFloat(place.heading) || 0, scale: parseFloat(place.scale) || 1 },
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

  const crs = CRS.find((c) => c.code === place.crs)!;

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
                  <FolderOpen size={14} /> Choose folder
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
              {checking && <p className="text-fg3">Reading {files.length} file{files.length > 1 ? "s" : ""}…</p>}
            </div>
          )}
          {step === 1 && report && (
            <div className="mx-auto max-w-xl space-y-3">
              <p className="text-fg3">
                {report.mainFile ?? "No model file"} · {report.stats.files} file{report.stats.files > 1 ? "s" : ""}
                {report.stats.triangles !== undefined && ` · ${report.stats.triangles.toLocaleString()} triangles`}
                {report.stats.textures !== undefined && ` · ${report.stats.textures} textures`}
                {report.stats.tiles !== undefined && ` · ${report.stats.tiles.toLocaleString()} tiles`}
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
                      <span className="block">{it.title}</span>
                      {it.detail && <span className="block break-words text-[12px] text-fg3">{it.detail}</span>}
                    </span>
                  </li>
                ))}
                <li className="flex items-center gap-3 rounded-[10px] bg-s2 p-3 text-fg3">
                  <AlertTriangle size={18} className="shrink-0" />
                  <span>{t("upload.checks.antivirus")}: runs on the server when it is in place.</span>
                </li>
              </ul>
              {!report.ok && <p className="text-[12px] text-fg3">Fix the problems above and drop the files again.</p>}
              <button type="button" className="btn-ghost" onClick={() => { setFiles([]); setChecked(null); setStep(0); }}>
                Choose other files
              </button>
            </div>
          )}
          {step === 2 && report && (
            <div className="mx-auto grid max-w-2xl gap-4">
              <div>
                <h3 className="text-[15px] font-semibold">{t("upload.placeTitle")}</h3>
                <p className="text-fg3">{report.georef ? "The file has its own position." : "The file has no position. It starts at the centre of the current view."}</p>
              </div>
              {report.georef && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={place.fromFile} onChange={(e) => setPlace({ ...place, fromFile: e.target.checked })} />
                  Use the position in the file ({report.georef.lat.toFixed(5)}°, {report.georef.lon.toFixed(5)}°)
                </label>
              )}
              {place.fromFile && report.georef && report.format === "3dtiles" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={place.fitGround} onChange={(e) => setPlace({ ...place, fitGround: e.target.checked })} />
                  Move it up or down so its streets meet the terrain (heights in another datum often float or sink)
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
                      {CRS.map((c) => (
                        <option key={c.code} value={c.code}>{c.label}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={crs.x}><input className="input num" value={place.x} onChange={(e) => setPlace({ ...place, x: e.target.value })} dir="ltr" /></Field>
                    <Field label={crs.y}><input className="input num" value={place.y} onChange={(e) => setPlace({ ...place, y: e.target.value })} dir="ltr" /></Field>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={place.onTerrain} onChange={(e) => setPlace({ ...place, onTerrain: e.target.checked })} />
                    Sit the model base on the terrain
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={place.onTerrain ? "Height without terrain (m)" : "Height (m, ellipsoidal)"}><input className="input num" value={place.height} onChange={(e) => setPlace({ ...place, height: e.target.value })} dir="ltr" /></Field>
                    <Field label="Heading (° from north)"><input className="input num" value={place.heading} onChange={(e) => setPlace({ ...place, heading: e.target.value })} dir="ltr" /></Field>
                    <Field label="Scale"><input className="input num" value={place.scale} onChange={(e) => setPlace({ ...place, scale: e.target.value })} dir="ltr" /></Field>
                  </div>
                </>
              )}
              <p className="text-[12px] text-fg3">After publishing, you can raise or lower the model in Properties.</p>
            </div>
          )}
          {step === 3 && (
            <div className="mx-auto grid max-w-3xl gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-semibold">{t("upload.layersTitle")}</h3>
                  <p className="text-fg3">{layers.length ? "Suggested standard names for the model's parts. The layer editor follows in a later release." : "3D Tiles keep the structure of the tileset; there is nothing to sort here."}</p>
                </div>
                {layers.length > 0 && <span className="inline-flex items-center gap-1 text-[12px] text-fg3"><Wand2 size={14} /> Suggested</span>}
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
                  {(report?.nodes.length ?? 0) > layers.length && <p className="px-2 py-1 text-[12px] text-fg3">and {report!.nodes.length - layers.length} more</p>}
                </div>
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
                    Choose the classification…
                  </option>
                  {SAMPLE_CLASSIFICATIONS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label.replace(/ · .*$/, "")}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="col-span-2"><Field label={t("upload.fields.description")}><textarea className="input h-24 py-2" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field></div>
              <p className="col-span-2 text-[12px] text-fg3">
                {report && fmtBytes(report.stats.bytes)} · The model stays in this browser session. The server keeps it once it is in place.
              </p>
              {publishError && <p className="col-span-2 rounded-[8px] bg-s2 p-3 text-[12px]">{publishError}</p>}
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
              {report?.format === "fbx" ? (
                <span className="text-[12px] text-fg3">FBX opens once the server converts it.</span>
              ) : !cls ? (
                <span className="text-[12px] text-fg3">Choose a classification to publish.</span>
              ) : null}
              <button type="button" className="btn-primary" disabled={!canPublish} onClick={() => void publish()}>
                <Upload size={14} /> {publishing ? "Publishing…" : t("upload.publish")}
              </button>
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-fg3">{label}</span>
      {children}
    </label>
  );
}
