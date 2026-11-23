import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtBytes } from "@viewer/core";
import { cannotRun, methodById, parseNvidiaSmi, presetSettings, SPLAT_PRESETS, type ServerHardware, type SplatPreset } from "@viewer/shared";
import type { CaptureStatus } from "../server/api";
import { desktop, fromDesktopList, type DesktopFile, type LocalBuildResult } from "../desktop";
import { useApp } from "../state/store";
import { AlertTriangle, Check, Film, FolderOpen, Gpu, Images, Loader2, Sparkles, X, XCircle } from "./icons";
import { IconButton, cx } from "./primitives";
import { ReportItems } from "./CaptureWizard";
import { useDialog } from "./useDialog";

/**
 * "Build on this PC" (HOLO for Windows): Gaussian splats from a video or photos on this computer's
 * own graphics card, with the building add-on, then opened in HOLO like any file on this computer.
 * One screen: the add-on and the card, what you have, quality, a name, Build. Nothing leaves the PC.
 */
type Phase = { kind: "form" } | { kind: "running"; check: boolean; fraction: number; stage: string } | { kind: "report"; report: CaptureReport } | { kind: "done"; file: DesktopFile; name: string } | { kind: "failed"; text: string };

type CaptureReport = NonNullable<NonNullable<CaptureStatus["check"]>["report"]>;

const STAGES = ["look", "frames", "features", "matching", "poses", "masks", "train", "done"] as const;

export function LocalBuild() {
  const { t } = useTranslation();
  const open = useApp((s) => s.localBuildOpen);
  const set = useApp((s) => s.set);
  const dialog = useDialog<HTMLDivElement>(open, { onClose: () => set({ localBuildOpen: false }) });

  const [addon, setAddon] = useState<{ version: string } | null | undefined>(undefined);
  const [smi, setSmi] = useState("");
  const [cores, setCores] = useState(4);
  const [ramGb, setRamGb] = useState(16);
  const [installing, setInstalling] = useState(false);
  const [addonError, setAddonError] = useState<string | null>(null);
  const [kind, setKind] = useState<"video" | "photos">("video");
  const [files, setFiles] = useState<DesktopFile[]>([]);
  const [preset, setPreset] = useState<SplatPreset>("balanced");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  useEffect(() => {
    if (!open || !desktop?.buildStatus) return;
    let live = true;
    void desktop.buildStatus().then((s) => {
      if (!live) return;
      setAddon(s.addon);
      setSmi(s.nvidiaSmi);
      if (s.building) setPhase((p) => (p.kind === "form" ? { kind: "running", check: false, fraction: 0, stage: "look" } : p));
    });
    void desktop.computer?.().then((c) => {
      if (!live) return;
      setCores(c.cores);
      setRamGb(c.ramGb);
    });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => desktop?.onBuildProgress?.((p) => setPhase((ph) => (ph.kind === "running" ? { ...ph, fraction: Math.max(ph.fraction, p.fraction), stage: p.stage } : ph))), []);

  const gpus = useMemo(() => parseNvidiaSmi(smi), [smi]);
  const gpu = [...gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0];
  // Without an NVIDIA card found, plan for a modest card: Brush also runs on others through Vulkan.
  const hw: ServerHardware = { platform: "win32", arch: "x64", cpuModel: "", cpus: cores, ramGb, gpus: gpus.length ? gpus : [{ vendor: "other", name: "", memoryGb: 4 }] };
  const brush = methodById("brush")!;
  const settings = presetSettings(brush, preset, hw);
  const small = gpu && cannotRun(brush, hw) === "tooLittleMemory";

  if (!open || !desktop?.build) return null;

  const close = () => set({ localBuildOpen: false });
  const install = async () => {
    setAddonError(null);
    setInstalling(true);
    try {
      const r = await desktop!.installBuildAddon!();
      if (r?.ok) setAddon({ version: r.version });
      else if (r) setAddonError(r.reason === "busy" ? t("splat.local.fail_busy") : r.reason);
    } finally {
      setInstalling(false);
    }
  };
  const pick = async () => {
    const list = await desktop!.pickCapture!(kind);
    if (!list?.length) return;
    setFiles(list);
    if (!name) setName((list[0]!.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  };
  const failText = (r: Extract<LocalBuildResult, { ok: false }>) =>
    r.reason === "failed" ? t("splat.local.fail_failed", { detail: r.detail || "—" }) : t(`splat.local.fail_${r.reason}`, { needGb: r.needGb ?? 0, freeGb: r.freeGb ?? 0 });
  const go = async (check: boolean) => {
    setPhase({ kind: "running", check, fraction: 0, stage: "look" });
    const r = await desktop!.build!({ inputKind: kind, name: name.trim(), checkOnly: check, ...settings }, files.map((f) => f.url));
    if (!r.ok) setPhase(r.reason === "stopped" ? { kind: "form" } : { kind: "failed", text: failText(r) });
    else if (r.file) setPhase({ kind: "done", file: r.file, name: r.name });
    else setPhase({ kind: "report", report: r.report as CaptureReport });
  };
  const openIt = (file: DesktopFile) => {
    const list = fromDesktopList([file]);
    if (!list) return;
    set({ localBuildOpen: false });
    useApp.setState({ pendingFiles: { files: list, keepLocal: true }, uploadOpen: true });
    setPhase({ kind: "form" });
    setFiles([]);
    setName("");
  };
  const total = files.reduce((s, f) => s + f.size, 0);
  const ready = !!addon && files.length > 0 && name.trim() !== "";
  const stageIndex = phase.kind === "running" ? Math.max(0, STAGES.indexOf(phase.stage as (typeof STAGES)[number])) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("splat.local.title")} className="glass flex max-h-[90vh] w-[min(640px,96vw)] flex-col rounded-[16px]" data-testid="local-build">
        <header className="flex h-14 items-center gap-3 border-b border-line px-5">
          <Sparkles size={18} className="text-accent" />
          <h2 className="flex-1 text-[15px] font-semibold">{t("splat.local.title")}</h2>
          <IconButton label={t("common.close")} onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {phase.kind === "running" ? (
            <div className="grid gap-4" data-testid="local-build-progress">
              <div>
                <h3 className="text-[17px] font-semibold">{phase.check ? t("splat.check.checking") : t("splat.local.buildingTitle")}</h3>
                <p className="text-[12px] text-fg3">{t("splat.local.buildingHint")}</p>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-s3">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(Math.max(0.02, phase.fraction) * 100)}%` }} />
              </div>
              <p className="flex items-center gap-2 text-[13px] text-fg2">
                <Loader2 size={14} className="animate-spin" /> {t(`splat.local.stage_${STAGES[stageIndex]}`)}
              </p>
              <div className="flex justify-end">
                <button type="button" className="btn-ghost" onClick={() => void desktop!.stopBuild!()} data-testid="local-build-stop">
                  <XCircle size={14} /> {t("splat.make.stop")}
                </button>
              </div>
            </div>
          ) : phase.kind === "report" ? (
            <div className="grid gap-4" data-testid="local-build-report">
              <div>
                <h3 className="text-[17px] font-semibold">{t(`splat.check.verdict_${phase.report.verdict}`)}</h3>
                <p className="text-[12px] text-fg3">{t(`splat.check.verdict_${phase.report.verdict}Hint`)}</p>
              </div>
              <ReportItems report={phase.report} />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={() => setPhase({ kind: "form" })}>
                  {t("splat.make.back")}
                </button>
                <button type="button" className={phase.report.verdict === "poor" ? "btn-secondary" : "btn-primary"} onClick={() => void go(false)} data-testid="local-build-go">
                  <Sparkles size={14} /> {phase.report.verdict === "poor" ? t("splat.check.buildAnyway") : t("splat.check.build")}
                </button>
              </div>
            </div>
          ) : phase.kind === "done" ? (
            <div className="grid gap-4" data-testid="local-build-done">
              <div className="flex items-start gap-2">
                <Check size={20} className="mt-0.5 text-[var(--status-current)]" />
                <div>
                  <h3 className="text-[17px] font-semibold">{t("splat.local.done", { name: phase.name })}</h3>
                  <p className="text-[12px] text-fg3">{t("splat.local.doneHint")}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={() => void desktop!.showBuildFolder!()}>
                  <FolderOpen size={14} /> {t("splat.local.showFolder")}
                </button>
                <button type="button" className="btn-primary" onClick={() => openIt(phase.file)} data-testid="local-build-open">
                  {t("splat.local.openResult")}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-5">
              <p className="text-[13px] text-fg2">{t("splat.local.intro")}</p>
              {phase.kind === "failed" && <Notice tone="error">{phase.text}</Notice>}

              <section className="grid gap-2 rounded-[12px] bg-s2 p-3 text-[13px]">
                <p className="flex items-center gap-2">
                  <Gpu size={16} className={gpu ? "text-accent" : "text-fg3"} />
                  {gpu ? t("splat.local.gpu", { name: gpu.name, memory: gpu.memoryGb, free: gpu.freeGb ?? gpu.memoryGb }) : t("splat.local.gpuNone")}
                </p>
                {small && <p className="flex items-start gap-2 text-[12px] text-[var(--status-production)]"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{t("splat.local.gpuSmall", { memory: gpu.memoryGb, need: brush.minMemoryGb })}</p>}
                {addon === undefined ? null : addon ? (
                  <p className="flex items-center gap-2" data-testid="local-build-addon">
                    <Check size={16} className="text-[var(--status-current)]" /> {t("splat.local.addonReady", { version: addon.version })}
                    <span className="flex-1" />
                    <button type="button" className="text-[12px] text-fg3 underline" disabled={installing} onClick={() => void install()}>
                      {t("splat.local.addonReplace")}
                    </button>
                  </p>
                ) : (
                  <div className="grid gap-2">
                    <p className="font-medium">{t("splat.local.addonNeeded")}</p>
                    <p className="text-[12px] text-fg3">{t("splat.local.addonHint")}</p>
                    <div>
                      <button type="button" className="btn-primary" disabled={installing} onClick={() => void install()} data-testid="local-build-install">
                        {installing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />} {installing ? t("splat.local.addonInstalling") : t("splat.local.addonInstall")}
                      </button>
                    </div>
                  </div>
                )}
                {installing && addon && <p className="text-[12px] text-fg3">{t("splat.local.addonInstalling")}</p>}
                {addonError && <p className="text-[12px] text-[var(--danger,#e5484d)]">{addonError}</p>}
              </section>

              <fieldset disabled={!addon} className={cx("grid gap-5", !addon && "opacity-50")}>
                <div className="grid gap-2">
                  <h3 className="text-[14px] font-semibold">{t("splat.make.have")}</h3>
                  <div role="radiogroup" className="grid grid-cols-2 gap-2">
                    {(["video", "photos"] as const).map((k) => {
                      const Icon = k === "video" ? Film : Images;
                      return (
                        <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setFiles([]); }} className={cx("flex flex-col items-start gap-1 rounded-[12px] border p-3 text-start", kind === k ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-s2")}>
                          <Icon size={18} className={kind === k ? "text-accent" : "text-fg3"} />
                          <span className="text-[13px] font-medium">{t(`splat.make.input_${k}`)}</span>
                          <span className="text-[12px] text-fg3">{t(`splat.make.input_${k}Hint`)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" className="btn-secondary" onClick={() => void pick()} data-testid="local-build-pick">
                      <FolderOpen size={14} /> {kind === "video" ? t("splat.local.pickVideo") : t("splat.local.pickPhotos")}
                    </button>
                    {files.length > 0 && <span className="text-[12px] text-fg2">{t("splat.make.chosen", { n: files.length, size: fmtBytes(total) })}</span>}
                  </div>
                </div>

                <div className="grid gap-2">
                  <h3 className="text-[14px] font-semibold">{t("splat.make.quality")}</h3>
                  <div role="radiogroup" className="grid grid-cols-3 gap-2">
                    {SPLAT_PRESETS.map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={preset === p} onClick={() => setPreset(p)} className={cx("flex flex-col items-start gap-0.5 rounded-[12px] border p-2.5 text-start", preset === p ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-s2")}>
                        <span className="text-[13px] font-medium">{t(`splat.make.preset_${p}`)}</span>
                        <span className="text-[11px] text-fg3">{t(`splat.make.preset_${p}Hint`)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[12px] text-fg3">{t("splat.make.settings", { iterations: settings.iterations.toLocaleString(), maxSplats: settings.maxSplats.toLocaleString(), resolution: settings.resolution })}</p>
                </div>

                <label className="grid gap-1 text-[13px]">
                  <span className="font-semibold">{t("splat.local.name")}</span>
                  <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="local-build-name" />
                </label>
              </fieldset>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" className="btn-ghost" disabled={!ready} onClick={() => void go(true)} title={t("splat.make.checkFirstHint")} data-testid="local-build-check">
                  {t("splat.make.checkFirst")}
                </button>
                <button type="button" className="btn-primary" disabled={!ready} onClick={() => void go(false)} data-testid="local-build-go">
                  <Sparkles size={14} /> {t("splat.local.build")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p className={cx("rounded-[12px] p-3 text-[13px]", tone === "error" ? "bg-[color-mix(in_srgb,var(--danger,#e5484d)_12%,transparent)] text-fg" : "bg-s2 text-fg2")}>{children}</p>;
}
