import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCoordinate, type PresetView } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { cx } from "./primitives";

/** Cursor coordinates in WGS84 or UTM, click to copy (MSR-08). */
export function CoordinatesHud({ className }: { className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const cursor = useSignal(engine?.cursor, null);
  const system = useApp((s) => s.coordSystem);
  const setPref = useApp((s) => s.setPref);
  const fps = useSignal(engine?.fps, 0);
  const [copied, setCopied] = useState(false);
  const f = cursor ? formatCoordinate(cursor.lat, cursor.lon, cursor.height, system) : null;
  return (
    <div className={cx("glass flex h-8 items-center gap-1 rounded-[10px] ps-1 pe-2 text-[12px]", className)}>
      <button
        type="button"
        className="h-6 rounded-[6px] px-2 font-medium text-fg2 hover:bg-s3 hover:text-fg"
        aria-label={`${system === "wgs84" ? t("coords.wgs84") : t("coords.utm")} · ${t("coords.system")}`}
        onClick={() => setPref("coordSystem", system === "wgs84" ? "utm" : "wgs84")}
      >
        {system === "wgs84" ? t("coords.wgs84") : t("coords.utm")}
      </button>
      <button
        type="button"
        dir="ltr"
        className="num min-w-[300px] text-start text-fg hover:text-accent"
        title={t("common.copy")}
        onClick={async () => {
          if (!f) return;
          try {
            await navigator.clipboard.writeText(f.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          } catch {
            /* ignore */
          }
        }}
      >
        {copied ? t("common.copied") : f ? f.parts.join("   ") : "—"}
      </button>
      <span className="num ms-2 text-fg3" title={t("shell.fps")}>
        {fps} fps
      </span>
    </div>
  );
}

const NICE = [1, 2, 5];
function niceLength(max: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  let best = p;
  for (const n of NICE) if (n * p <= max) best = n * p;
  return best;
}

export function ScaleBar({ className }: { className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const info = useSignal(engine?.cameraInfo, { heading: 0, pitch: 0, metresPerPixel: 1, height: 0 });
  const maxPx = 120;
  const metres = niceLength(info.metresPerPixel * maxPx);
  const px = metres / info.metresPerPixel;
  const label = metres >= 1000 ? `${metres / 1000} km` : metres >= 1 ? `${metres} m` : `${Math.round(metres * 100)} cm`;
  return (
    <div className={cx("flex flex-col items-start gap-0.5 text-[11px] text-fg2 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]", className)} dir="ltr" aria-label={t("shell.scale", { label })}>
      <span className="num">{label}</span>
      <span className="h-1.5 border-x-2 border-b-2 border-fg/80" style={{ width: Math.max(8, Math.min(px, 200)) }} />
    </div>
  );
}

/**
 * View cube + compass (NAV-04). Faces are clickable presets; the ring shows north.
 * Never mirrored in RTL (UI spec §2).
 */
export function ViewCube({ className }: { className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const info = useSignal(engine?.cameraInfo, { heading: 0, pitch: -0.5, metresPerPixel: 1, height: 0 });
  const hDeg = (info.heading * 180) / Math.PI;
  const pDeg = (info.pitch * 180) / Math.PI;
  // Each face is a 3 × 3 grid: the centre looks at that face, the sides at an edge, the corners at a corner.
  // Together the six faces give the 26 views of NAV-05. Axes are east, north, up.
  type V = [number, number, number];
  const face = (label: string, n: V, right: V, up: V, transform: string) => (
    <div className="absolute inset-0 grid grid-cols-[1fr_2fr_1fr] grid-rows-[1fr_2fr_1fr] border border-white/15 bg-[rgb(38_42_49/0.92)] [backface-visibility:hidden]" style={{ transform }}>
      {[-1, 0, 1].flatMap((r) =>
        [-1, 0, 1].map((c) => {
          const d: V = [0, 1, 2].map((k) => n[k]! + c * right[k]! - r * up[k]!) as V;
          const centre = r === 0 && c === 0;
          const name = t(centre ? "shell.cubeView" : r === 0 || c === 0 ? "shell.cubeEdge" : "shell.cubeCorner", { face: label });
          return (
            <button
              key={`${r}${c}`}
              type="button"
              aria-label={name}
              data-dir={d.join(",")}
              title={centre ? undefined : name}
              onClick={() => void engine?.viewFrom(d)}
              className={cx("grid place-items-center hover:bg-accent hover:text-accent-on", centre ? "text-[10px] font-semibold tracking-wider text-fg2" : "")}
            >
              {centre ? label : null}
            </button>
          );
        }),
      )}
    </div>
  );
  const s = 26; // half size
  return (
    <div className={cx("relative h-[104px] w-[104px] select-none", className)} dir="ltr">
      {/* compass ring */}
      <div className="absolute inset-0 rounded-full border border-white/10 bg-black/20" style={{ transform: `rotate(${-hDeg}deg)` }}>
        <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[10px] font-bold text-accent">N</span>
        <span className="absolute left-1/2 bottom-0.5 -translate-x-1/2 text-[9px] text-fg3">S</span>
        <span className="absolute top-1/2 left-1 -translate-y-1/2 text-[9px] text-fg3">W</span>
        <span className="absolute top-1/2 right-1 -translate-y-1/2 text-[9px] text-fg3">E</span>
      </div>
      <div className="absolute left-1/2 top-1/2 h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2 [perspective:300px]">
        <div
          className="relative h-full w-full [transform-style:preserve-3d]"
          style={{ transform: `rotateX(${90 + pDeg}deg) rotateZ(${-hDeg}deg)` }}
        >
          {face("TOP", [0, 0, 1], [1, 0, 0], [0, 1, 0], `translateZ(${s}px)`)}
          {face("S", [0, -1, 0], [1, 0, 0], [0, 0, 1], `rotateX(-90deg) translateZ(${s}px)`)}
          {face("N", [0, 1, 0], [-1, 0, 0], [0, 0, 1], `rotateX(90deg) rotateZ(180deg) translateZ(${s}px)`)}
          {face("W", [-1, 0, 0], [0, -1, 0], [0, 0, 1], `rotateY(-90deg) rotateZ(90deg) translateZ(${s}px)`)}
          {face("E", [1, 0, 0], [0, 1, 0], [0, 0, 1], `rotateY(90deg) rotateZ(-90deg) translateZ(${s}px)`)}
          {face("BTM", [0, 0, -1], [1, 0, 0], [0, -1, 0], `rotateX(180deg) translateZ(${s}px)`)}
        </div>
      </div>
      <button
        type="button"
        aria-label={`ISO · ${t("viewer.isometric")}`}
        title={t("viewer.isometric")}
        onClick={() => void engine?.preset("iso")}
        className="absolute -bottom-1 right-0 grid h-6 w-6 place-items-center rounded-full bg-s3 text-[9px] font-semibold text-fg2 hover:bg-accent hover:text-accent-on"
      >
        ISO
      </button>
    </div>
  );
}

/** One line telling the user what the active tool expects next (UI spec 1.1 #9). */
export function HintLine({ className }: { className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const tool = useApp((s) => s.tool);
  const draft = useSignal(engine?.measure.draft, []);
  const speed = useSignal(engine?.fly.speed, 0);
  let text = t("viewer.hints.idle");
  if (tool === "distance") text = draft.length === 0 ? t("viewer.hints.distanceFirst") : t("viewer.hints.distanceSecond");
  if (tool === "path") text = draft.length === 0 ? t("viewer.hints.distanceFirst") : t("viewer.hints.pathNext");
  if (tool === "fly") text = `${t("shell.flyHint")}${speed ? ` · ${speed} m/s` : ""}`;
  return (
    <div
      aria-live="polite"
      className={cx(
        "pointer-events-none rounded-full px-3 py-1 text-[12px] text-fg2 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]",
        tool !== "none" && "glass text-fg",
        className,
      )}
    >
      {text}
    </div>
  );
}
