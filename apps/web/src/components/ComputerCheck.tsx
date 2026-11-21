import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkComputer, type CheckLevel, type CheckRow, type ComputerFacts } from "@viewer/shared";
import { desktop } from "../desktop";

/** Reads the graphics facts from a WebGL 2 context (or WebGL 1 when 2 is missing). Browser only. */
function readWebgl(): Pick<ComputerFacts, "renderer" | "webgl2" | "maxTextureSize"> {
  try {
    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    const gl = gl2 ?? canvas.getContext("webgl");
    if (!gl) return { renderer: null, webgl2: false, maxTextureSize: null };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const max = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, webgl2: !!gl2, maxTextureSize: max };
  } catch {
    return { renderer: null, webgl2: false, maxTextureSize: null };
  }
}

/** What this computer has, read here and nothing sent: the browser's WebGL, and the Windows app's OS facts. */
async function readFacts(): Promise<ComputerFacts> {
  const gl = readWebgl();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const os = desktop?.computer ? await desktop.computer().catch(() => null) : null;
  if (os) return { ...gl, ramGb: os.ramGb, ramIsHint: false, cores: os.cores, cpuModel: os.cpuModel, freeDiskGb: os.freeDiskGb, os: os.os };
  return { ...gl, ramGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null, ramIsHint: true, cores: navigator.hardwareConcurrency || null };
}

const DOT: Record<CheckLevel, string> = { ok: "bg-emerald-500", limit: "bg-amber-500", no: "bg-red-500" };

/** "Check this computer" in Help: one button, then a row per part with what it means. */
export function ComputerCheck() {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | { rows: CheckRow[]; level: CheckLevel }>("idle");
  useEffect(() => {
    if (state !== "busy") return;
    let live = true;
    void readFacts().then((f) => live && setState(checkComputer(f)));
    return () => {
      live = false;
    };
  }, [state]);
  if (state === "idle")
    return (
      <button type="button" className="btn-secondary" onClick={() => setState("busy")}>
        {t("help.computer.button")}
      </button>
    );
  if (state === "busy") return <p className="text-fg2" role="status">{t("help.computer.checking")}</p>;
  return (
    <section aria-label={t("help.computer.title")} className="space-y-2" role="status">
      <h3 className="text-[11px] uppercase tracking-wide text-fg3">{t("help.computer.title")}</h3>
      <p className="text-fg">{t(`help.computer.verdict.${state.level}`)}</p>
      <dl className="space-y-1.5">
        {state.rows.map((r) => (
          <div key={r.key}>
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[r.level]}`} />
              <dt className="text-fg2">{t(`help.computer.rows.${r.key}`)}</dt>
              <dd className="ms-auto text-[12px] text-fg" dir="ltr">
                {r.value} · {t(`help.computer.levels.${r.level}`)}
              </dd>
            </div>
            {r.note && <p className="ms-4 text-[12px] text-fg3">{t(`help.computer.notes.${r.note}`)}</p>}
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-fg3">{t("help.computer.private")}</p>
    </section>
  );
}
