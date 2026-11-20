import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtBytes, type LocalFile } from "@viewer/core";
import {
  cannotRun,
  goalsFor,
  methodById,
  presetSettings,
  recommend,
  SPLAT_METHODS,
  SPLAT_PRESETS,
  type CaptureInput,
  type ServerHardware,
  type SplatGoal,
  type SplatPreset,
} from "@viewer/shared";
import { getCapture, getSplatSetup, sendCapture, type CaptureStatus, type IngestRequest, type SplatSetup, type UploadProgress } from "../server/api";
import { errorText } from "../server/error-text";
import { refreshLibrary } from "../state/library";
import { useLevels } from "../state/classification";
import { useApp } from "../state/store";
import { useEngine } from "../engine";
import { useOpenModel } from "../useAppEffects";
import { fromDrop, fromInput } from "../upload/read-drop";
import { AlertTriangle, Aperture, Building2, Check, ChevronLeft, ChevronRight, Cpu, Film, Gpu, Images, Ruler, Satellite, Sparkles, X, XCircle } from "./icons";
import { IconButton, cx } from "./primitives";
import { useDialog } from "./useDialog";

/**
 * "Make a splat" (docs/GAUSSIAN_SPLATS.md, "Making a splat"): four short steps, each one question.
 * What do you have, what do you want, how (the recommended method for this server is already
 * chosen, with the reason), and a name. The server trains; this window can close meanwhile.
 */
const STEPS = ["have", "want", "how", "details"] as const;
const INPUT_ICON = { video: Film, photos: Images, satellite: Satellite } as const;
const GOAL_ICON = { scene: Aperture, surface: Ruler, area: Building2, satellite: Satellite } as const;
const VIDEO = /\.(mp4|mov|m4v|lrv|ts|mts|avi|mkv|webm)$/i;
const PHOTO = /\.(jpe?g|png|tiff?|heic|webp|dng)$/i;
const SATELLITE = /\.(tiff?|ntf|nitf|jp2|rpb|rpc|xml|txt|json|geojson)$/i;
const SIDECAR = /\.(txt|json|csv|xml|srt|gpx|kml)$/i;
const ACCEPT = { video: ".mp4,.mov,.m4v,.lrv,.ts,.mts,.avi,.mkv,.webm,.zip", photos: ".jpg,.jpeg,.png,.tif,.tiff,.heic,.webp,.dng,.zip,.txt,.json,.csv,.xml", satellite: ".tif,.tiff,.ntf,.nitf,.jp2,.rpb,.rpc,.xml,.txt,.json,.geojson,.zip" } as const;
const fits = (input: CaptureInput, name: string) => /\.zip$/i.test(name) || SIDECAR.test(name) || { video: VIDEO, photos: PHOTO, satellite: SATELLITE }[input].test(name);

export function CaptureWizard() {
  const { t } = useTranslation();
  const open = useApp((s) => s.captureOpen);
  const set = useApp((s) => s.set);
  const server = useApp((s) => s.server);
  const levels = useLevels();
  const engine = useEngine();
  const { open: openModel } = useOpenModel();
  const dialog = useDialog<HTMLDivElement>(open, { onClose: () => set({ captureOpen: false }) });

  const [step, setStep] = useState(0);
  const [input, setInput] = useState<CaptureInput>("video");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [goal, setGoal] = useState<SplatGoal>("scene");
  const [setup, setSetup] = useState<SplatSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>("");
  const [compare, setCompare] = useState<string[]>([]);
  const [preset, setPreset] = useState<SplatPreset>("balanced");
  const [name, setName] = useState("");
  const [cls, setCls] = useState("");
  const [sending, setSending] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);

  // The server's hardware and installed methods, read when the window opens.
  useEffect(() => {
    if (!open || !server) return;
    let live = true;
    setSetupError(null);
    getSplatSetup(server).then((s) => live && setSetup(s), (e: unknown) => live && setSetupError(errorText(e, t)));
    return () => {
      live = false;
    };
  }, [open, server, t]);

  const hw = setup?.hardware as ServerHardware | undefined;
  const installed = useMemo(() => setup?.installed ?? [], [setup]);
  const rec = useMemo(() => (hw ? recommend(hw, input, goal, installed) : null), [hw, input, goal, installed]);

  // Follow the recommendation until the operator picks something else.
  useEffect(() => {
    if (!rec) return;
    setMethod(rec.method ?? "");
    setPreset(rec.preset);
    setCompare([]);
  }, [rec]);

  // While training, ask the server how it goes; stop once every method has finished.
  useEffect(() => {
    if (!server || !captureId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await getCapture(server, captureId);
        if (!live) return;
        setStatus(s);
        if (s.state !== "working") {
          void refreshLibrary();
          return;
        }
      } catch {
        /* a dropped answer: ask again */
      }
      if (live) timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [server, captureId]);

  if (!open) return null;

  const reset = () => {
    setStep(0);
    setFiles([]);
    setName("");
    setCls("");
    setError(null);
    setSending(null);
    setCaptureId(null);
    setStatus(null);
  };
  const close = () => {
    set({ captureOpen: false });
    // A capture that is training keeps going on the server; the next open starts fresh.
    if (!sending) reset();
  };

  const wrong = files.filter((f) => !fits(input, f.path));
  const total = files.reduce((s, f) => s + f.size, 0);
  const runs = [method, ...compare].filter(Boolean);
  const canNext = step === 0 ? files.length > 0 && wrong.length === 0 : step === 1 ? true : step === 2 ? !!method : false;
  const canStart = !!server && !!method && !!cls && name.trim() !== "" && !sending;

  const pickFiles = (list: LocalFile[]) => {
    setFiles(list);
    if (!name && list[0]) setName((list[0].path.split("/")[0] ?? "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  };

  const start = async () => {
    if (!server) return;
    setError(null);
    setSending({ sent: 0, total, step: "upload" });
    try {
      const c = engine?.viewCentre();
      const lat = c?.lat ?? 31.7683;
      const lon = c?.lon ?? 35.2137;
      const id = await sendCapture(
        server,
        files,
        {
          model: { name: name.trim(), project: "Captures", status: "draft", classificationId: cls },
          // A splat from a capture has no real size yet: it opens floating where the map is.
          placement: { lat, lon, height: 0, scale: 1, modelUnit: 1 },
          centre: { lat, lon },
          reconstruct: { input, goal, methods: runs as NonNullable<IngestRequest["reconstruct"]>["methods"], preset },
        },
        setSending,
      );
      setCaptureId(id);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setSending(null);
    }
  };

  const settings = hw && method ? presetSettings(methodById(method)!, preset, hw) : null;
  const gpu = hw ? [...hw.gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0] : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("splat.make.title")} className="glass flex h-[min(720px,90vh)] w-[min(900px,96vw)] flex-col rounded-[16px]">
        <header className="flex h-14 items-center gap-4 border-b border-line px-5">
          <Sparkles size={18} className="text-accent" />
          <h2 className="text-[15px] font-semibold">{t("splat.make.title")}</h2>
          {!captureId && (
            <ol className="flex flex-1 items-center justify-center gap-1">
              {STEPS.map((s, i) => (
                <li key={s} className="flex items-center gap-1">
                  <span className={cx("grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold num", i < step ? "bg-accent text-accent-on" : i === step ? "border-2 border-accent text-accent" : "border border-line-strong text-fg3")}>
                    {i < step ? <Check size={12} /> : i + 1}
                  </span>
                  <span className={cx("text-[12px] font-medium", i === step ? "text-fg" : "text-fg3")}>{t(`splat.make.step_${s}`)}</span>
                  {i < STEPS.length - 1 && <span className="mx-2 h-px w-6 bg-line-strong" />}
                </li>
              ))}
            </ol>
          )}
          {captureId && <div className="flex-1" />}
          <IconButton label={t("common.close")} onClick={close}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-6">
          {!server ? (
            <Notice>{t("splat.make.needsServer")}</Notice>
          ) : captureId ? (
            <Progress status={status} onOpen={(id) => { set({ captureOpen: false }); reset(); setTimeout(() => openModel(id), 0); }} />
          ) : step === 0 ? (
            <div className="mx-auto grid max-w-2xl gap-4">
              <h3 className="text-[17px] font-semibold">{t("splat.make.have")}</h3>
              <Cards
                name="capture-input"
                value={input}
                onChange={(v) => { setInput(v); setGoal(goalsFor(v)[0]!); }}
                options={(["video", "photos", "satellite"] as const).map((v) => ({ value: v, icon: INPUT_ICON[v], title: t(`splat.make.input_${v}`), hint: t(`splat.make.input_${v}Hint`) }))}
              />
              <div
                className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-line-strong p-4 text-center hover:border-accent"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void fromDrop(e.dataTransfer).then(pickFiles);
                }}
                data-testid="capture-drop"
              >
                <div className="font-medium">{t("splat.make.drop")}</div>
                <p className="max-w-lg text-[12px] text-fg3">{t(`splat.make.tip_${input}`)}</p>
                <label className="btn-secondary mt-1 cursor-pointer">
                  {t("splat.make.choose")}
                  <input type="file" multiple className="hidden" accept={ACCEPT[input]} onChange={(e) => pickFiles(fromInput(e.target.files))} data-testid="capture-files" />
                </label>
                {files.length > 0 && <p className="text-[12px] text-fg2" data-testid="capture-chosen">{t("splat.make.chosen", { n: files.length, size: fmtBytes(total) })}</p>}
                {wrong.length > 0 && (
                  <p className="text-[12px] text-[var(--status-production)]">{t("splat.make.wrongFiles", { input: t(`splat.make.input_${input}`), files: wrong.slice(0, 3).map((f) => f.path).join(", ") })}</p>
                )}
              </div>
            </div>
          ) : step === 1 ? (
            <div className="mx-auto grid max-w-2xl gap-4">
              <h3 className="text-[17px] font-semibold">{t("splat.make.want")}</h3>
              <Cards
                name="capture-goal"
                value={goal}
                onChange={setGoal}
                options={goalsFor(input).map((g) => ({ value: g, icon: GOAL_ICON[g], title: t(`splat.make.goal_${g}`), hint: t(`splat.make.goal_${g}Hint`) }))}
              />
            </div>
          ) : step === 2 ? (
            <div className="mx-auto grid max-w-2xl gap-4">
              <h3 className="text-[17px] font-semibold">{t("splat.make.how")}</h3>
              {setupError && <Notice tone="error">{setupError}</Notice>}
              {hw && (
                <p className="flex items-center gap-2 text-[12px] text-fg3" data-testid="capture-hardware">
                  {gpu ? <Gpu size={14} /> : <Cpu size={14} />}
                  {t("splat.make.server", { gpu: gpu ? t("splat.make.serverGpu", { name: gpu.name, memory: gpu.memoryGb }) : t("splat.make.serverCpu", { cpus: hw.cpus, ram: Math.round(hw.ramGb) }) })}
                </p>
              )}
              {rec && (
                <div className={cx("rounded-[12px] border p-3", rec.method ? "border-accent bg-accent-soft" : "border-line-strong bg-s2")} data-testid="capture-recommendation">
                  {rec.method && (
                    <div className="mb-1 flex items-center gap-2">
                      <Sparkles size={14} className="text-accent" />
                      <span className="text-[12px] font-semibold uppercase tracking-wide text-accent">{t("splat.make.recommended")}</span>
                      <span className="font-semibold">{methodById(rec.method)!.name}</span>
                    </div>
                  )}
                  <ul className="space-y-0.5 text-[12px] text-fg2">
                    {rec.why.map((w) => (
                      <li key={w} className={cx(["generative", "research", "surfaceFallback", "nothingRuns", "nothingInstalled"].includes(w) && "text-[var(--status-production)]")}>
                        {t(`splat.make.why.${w}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="grid gap-1">
                <span className="text-[12px] text-fg3">{t("splat.make.method")}</span>
                <select className="input" value={method} onChange={(e) => { setMethod(e.target.value); setCompare((c) => c.filter((x) => x !== e.target.value)); }} data-testid="capture-method">
                  {!method && <option value="">—</option>}
                  {SPLAT_METHODS.filter((m) => m.inputs.includes(input) && m.goals.includes(goal)).map((m) => {
                    const why = hw ? cannotRun(m, hw) : null;
                    const missing = !installed.includes(m.id);
                    return (
                      <option key={m.id} value={m.id} disabled={!!why || missing}>
                        {m.name}
                        {m.id === rec?.method ? ` · ${t("splat.make.recommended")}` : ""}
                        {why ? ` · ${t(`splat.make.cannot_${why}`)}` : missing ? ` · ${t("splat.make.cannot_notInstalled")}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              {method && <MethodHelp id={method} />}
              {rec && rec.alternatives.filter((a) => a !== method).length > 0 && (
                <fieldset className="grid gap-1">
                  <legend className="text-[12px] text-fg3">{t("splat.make.compare")}</legend>
                  {rec.alternatives.filter((a) => a !== method).map((a) => (
                    <label key={a} className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={compare.includes(a)} disabled={!compare.includes(a) && runs.length >= 3} onChange={(e) => setCompare((c) => (e.target.checked ? [...c, a] : c.filter((x) => x !== a)))} />
                      {methodById(a)!.name}
                    </label>
                  ))}
                  <p className="text-[12px] text-fg3">{t("splat.make.compareHint")}</p>
                </fieldset>
              )}
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-[12px] text-fg3">{t("splat.make.quality")}</legend>
                <div role="radiogroup" className="grid grid-cols-3 gap-2">
                  {SPLAT_PRESETS.map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={preset === p} data-testid={`preset-${p}`} onClick={() => setPreset(p)} className={cx("rounded-[10px] border p-2 text-start", preset === p ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-s2")}>
                      <span className="block text-[13px] font-medium">{t(`splat.make.preset_${p}`)}</span>
                      <span className="block text-[12px] text-fg3">{t(`splat.make.preset_${p}Hint`)}</span>
                    </button>
                  ))}
                </div>
                {settings && <p className="text-[12px] text-fg3 num">{t("splat.make.settings", { iterations: settings.iterations.toLocaleString(), maxSplats: settings.maxSplats.toLocaleString(), resolution: settings.resolution })}</p>}
              </fieldset>
            </div>
          ) : (
            <div className="mx-auto grid max-w-xl gap-3">
              <label className="grid gap-1">
                <span className="text-[12px] text-fg3">{t("upload.fields.name")} *</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-testid="capture-name" />
              </label>
              <label className="grid gap-1">
                <span className="text-[12px] text-fg3">{t("upload.fields.classification")} *</span>
                <select className="input font-semibold" value={cls} onChange={(e) => setCls(e.target.value)} data-testid="capture-class">
                  <option value="" disabled>{t("wizard.chooseClass")}</option>
                  {levels.map((c) => <option key={c.id} value={c.id}>{c.label.replace(/ · .*$/, "")}</option>)}
                </select>
              </label>
              <p className="rounded-[12px] bg-s2 p-3 text-[12px] text-fg2">{t("splat.make.sizeNote")}</p>
              {sending && (
                <div className="grid gap-1.5" data-testid="capture-sending">
                  <div className="h-1.5 overflow-hidden rounded-full bg-s3">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${sending.total ? Math.round((sending.sent / sending.total) * 100) : 100}%` }} />
                  </div>
                  <span className="text-[12px] text-fg3">{t("wizard.sending", { sent: fmtBytes(sending.sent), total: fmtBytes(sending.total) })}</span>
                </div>
              )}
              {error && <Notice tone="error">{error}</Notice>}
            </div>
          )}
        </div>

        {server && !captureId && (
          <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
            <button type="button" className="btn-ghost" disabled={step === 0 || !!sending} onClick={() => setStep(step - 1)}>
              <ChevronLeft size={14} className="rtl:rotate-180" /> {t("splat.make.back")}
            </button>
            {step < 3 ? (
              <button type="button" className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="capture-next">
                {t("splat.make.next")} <ChevronRight size={14} className="rtl:rotate-180" />
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={!canStart} onClick={() => void start()} data-testid="capture-start">
                <Sparkles size={14} /> {sending ? t("splat.make.starting") : t("splat.make.start")}
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function Cards<V extends string>({ name, value, onChange, options }: { name: string; value: V; onChange: (v: V) => void; options: { value: V; icon: typeof Film; title: string; hint: string }[] }) {
  return (
    <div role="radiogroup" className={cx("grid gap-2", options.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-testid={`${name}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={cx("flex flex-col items-start gap-1 rounded-[12px] border p-3 text-start transition-colors", value === o.value ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/60 hover:bg-s2")}
        >
          <o.icon size={20} className={value === o.value ? "text-accent" : "text-fg3"} />
          <span className="text-[13px] font-medium text-fg">{o.title}</span>
          <span className="text-[12px] text-fg3">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function MethodHelp({ id }: { id: string }) {
  const { t } = useTranslation();
  const m = methodById(id)!;
  return (
    <details className="rounded-[10px] bg-s2 px-3 py-2 text-[12px]">
      <summary className="cursor-pointer text-fg2">{t("splat.make.methodHelp", { name: m.name })}</summary>
      <p className="mt-1 text-fg2">{t(`splat.make.methods.${m.id}`)}</p>
      <p className="mt-1 text-fg3">
        {t("splat.make.licence", { licence: m.licence === "research" ? t("splat.make.why.research") : m.licence })} ·{" "}
        <a className="underline" href={m.url} target="_blank" rel="noreferrer noopener">{m.url.replace(/^https:\/\//, "")}</a>
      </p>
    </details>
  );
}

function Progress({ status, onOpen }: { status: CaptureStatus | null; onOpen: (modelId: string) => void }) {
  const { t } = useTranslation();
  const done = status && status.state !== "working";
  return (
    <div className="mx-auto grid max-w-xl gap-4" data-testid="capture-progress">
      <div>
        <h3 className="text-[17px] font-semibold">{done ? (status.state === "ready" ? t("splat.make.allDone") : t("splat.make.noneWorked")) : t("splat.make.progressTitle")}</h3>
        {!done && <p className="text-[12px] text-fg3">{t("splat.make.progressHint")}</p>}
      </div>
      <ul className="grid gap-2">
        {(status?.methods ?? []).map((m) => (
          <li key={m.method} className="grid gap-1.5 rounded-[12px] bg-s2 p-3" data-testid={`capture-run-${m.method}`}>
            <div className="flex items-center gap-2">
              {m.state === "ready" ? <Check size={16} className="text-[var(--status-current)]" /> : m.state === "failed" ? <XCircle size={16} className="text-[var(--danger,#e5484d)]" /> : <Sparkles size={16} className="animate-pulse text-accent" />}
              <span className="font-medium">{methodById(m.method)?.name ?? m.method}</span>
              <span className="text-[12px] text-fg3">{t(`splat.make.state_${m.state}`)}</span>
              <span className="flex-1" />
              {m.state === "ready" && m.modelId && (
                <button type="button" className="btn-secondary" onClick={() => onOpen(m.modelId!)}>
                  {t("splat.make.openResult")}
                </button>
              )}
            </div>
            {m.state === "training" && (
              <div className="h-1.5 overflow-hidden rounded-full bg-s3">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((m.fraction ?? 0.02) * 100)}%` }} />
              </div>
            )}
            {m.error && <p className="flex items-start gap-1 text-[12px] text-[var(--status-production)]"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{m.error}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p className={cx("rounded-[12px] p-3 text-[13px]", tone === "error" ? "bg-[color-mix(in_srgb,var(--danger,#e5484d)_12%,transparent)] text-fg" : "bg-s2 text-fg2")}>{children}</p>;
}
