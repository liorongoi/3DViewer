import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SAMPLE_CLASSIFICATIONS, UPDATE_STATUSES } from "@viewer/shared";
import { useApp } from "../state/store";
import { Check, ChevronLeft, ChevronRight, Upload, Wand2, X, AlertTriangle } from "./icons";
import { IconButton, cx } from "./primitives";

const STEPS = ["drop", "check", "place", "layers", "details"] as const;

/** Five-step upload sheet (UI spec §3.4). Prototype: UI only, no server yet (Phase 3). */
export function UploadWizard() {
  const { t } = useTranslation();
  const open = useApp((s) => s.uploadOpen);
  const set = useApp((s) => s.set);
  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!files.length) return;
    setProgress(0);
    const id = setInterval(() => setProgress((p) => Math.min(100, p + 7)), 120);
    return () => clearInterval(id);
  }, [files]);
  if (!open) return null;
  const close = () => {
    set({ uploadOpen: false });
    setStep(0);
    setFiles([]);
  };
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
            <label
              className="flex h-full min-h-80 cursor-pointer flex-col items-center justify-center gap-3 rounded-[14px] border-2 border-dashed border-line-strong text-center hover:border-accent"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                setFiles([...e.dataTransfer.files]);
              }}
            >
              <Upload size={32} className="text-accent" />
              <div className="text-[16px] font-semibold">{t("upload.dropTitle")}</div>
              <div className="max-w-md text-fg3">{t("upload.dropHint")}</div>
              <span className="btn-secondary mt-2">{t("upload.choose")}</span>
              <input type="file" multiple className="hidden" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
              {files.length > 0 && (
                <div className="mt-4 w-full max-w-md space-y-2 text-start">
                  {files.map((f) => (
                    <div key={f.name} className="rounded-[8px] bg-s2 p-2">
                      <div className="flex justify-between text-[12px]">
                        <span className="truncate">{f.name}</span>
                        <span className="num text-fg3">{(f.size / 1e6).toFixed(1)} MB · {progress}%</span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-s3">
                        <div className="h-1 rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  ))}
                  <p className="text-[12px] text-fg3">{t("upload.resumable")}</p>
                </div>
              )}
            </label>
          )}
          {step === 1 && (
            <ul className="mx-auto max-w-lg space-y-2">
              {(["format", "textures", "size", "antivirus", "georef"] as const).map((k, i) => (
                <li key={k} className="flex items-center gap-3 rounded-[10px] bg-s2 p-3">
                  {i === 4 ? <AlertTriangle size={18} className="text-[var(--status-production)]" /> : <Check size={18} className="text-[var(--status-current)]" />}
                  <span className="flex-1">{t(`upload.checks.${k}`)}</span>
                  {i === 4 && <span className="text-[12px] text-fg3">Not found in file: set it in the next step</span>}
                </li>
              ))}
            </ul>
          )}
          {step === 2 && (
            <div className="mx-auto grid max-w-2xl gap-4">
              <div>
                <h3 className="text-[15px] font-semibold">{t("upload.placeTitle")}</h3>
                <p className="text-fg3">{t("upload.placeHint")}</p>
              </div>
              <Field label={t("upload.crs")}>
                <select className="input">
                  <option>EPSG:2039 · Israel 1993 / Israeli TM Grid (ITM)</option>
                  <option>EPSG:32636 · WGS 84 / UTM zone 36N</option>
                  <option>EPSG:4326 · WGS 84 geographic</option>
                </select>
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label={`${t("upload.origin")} E / X`}><input className="input num" defaultValue="219850.00" dir="ltr" /></Field>
                <Field label={`${t("upload.origin")} N / Y`}><input className="input num" defaultValue="631540.00" dir="ltr" /></Field>
                <Field label="Height (m)"><input className="input num" defaultValue="780.0" dir="ltr" /></Field>
              </div>
              <p className="rounded-[8px] bg-s2 p-3 text-[12px] text-fg3">
                In the full product a map preview shows the footprint here and moves live as you edit (FMT-08).
              </p>
            </div>
          )}
          {step === 3 && (
            <div className="mx-auto grid max-w-3xl grid-cols-2 gap-4">
              <div className="col-span-2 flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-semibold">{t("upload.layersTitle")}</h3>
                  <p className="text-fg3">{t("upload.layersHint")}</p>
                </div>
                <button type="button" className="btn-secondary"><Wand2 size={14} />{t("upload.applySuggestions")}</button>
              </div>
              <div className="rounded-[10px] bg-s2 p-2">
                {["mesh_0042_bldg", "grp_trees_A", "road_surf", "Mesh.013", "water_poly"].map((n) => (
                  <div key={n} className="flex h-9 items-center gap-2 rounded-[6px] px-2 hover:bg-s3 num text-[12px] text-fg2">⋮⋮ {n}</div>
                ))}
              </div>
              <div className="rounded-[10px] bg-s2 p-2">
                {["Buildings", "Vegetation", "Infrastructure", "Other", "Water"].map((n) => (
                  <div key={n} className="flex h-9 items-center gap-2 rounded-[6px] px-2 text-accent">→ {n}</div>
                ))}
              </div>
            </div>
          )}
          {step === 4 && (
            <div className="mx-auto grid max-w-2xl grid-cols-2 gap-3">
              <Field label={t("upload.fields.name")}><input className="input" /></Field>
              <Field label={t("upload.fields.project")}><input className="input" /></Field>
              <Field label={t("upload.fields.operation")}><input className="input" /></Field>
              <Field label={t("upload.fields.entity")}><input className="input" /></Field>
              <Field label={t("upload.fields.status")}>
                <select className="input">{UPDATE_STATUSES.map((s) => <option key={s}>{t(`status.${s}`)}</option>)}</select>
              </Field>
              <Field label={t("upload.fields.classification")}>
                <select className="input">{SAMPLE_CLASSIFICATIONS.map((c) => <option key={c.id}>{c.label}</option>)}</select>
              </Field>
              <div className="col-span-2"><Field label={t("upload.fields.description")}><textarea className="input h-24 py-2" /></Field></div>
            </div>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-line px-5 h-14">
          <button type="button" className="btn-ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            <ChevronLeft size={14} className="rtl:-scale-x-100" /> {t("common.back")}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn-primary" onClick={() => setStep((s) => s + 1)}>
              {t("common.next")} <ChevronRight size={14} className="rtl:-scale-x-100" />
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={close}>
              <Upload size={14} /> {t("upload.publish")}
            </button>
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
