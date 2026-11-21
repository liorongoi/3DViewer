import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { ModelSummary } from "@viewer/shared";
import { useEngine } from "../engine";
import { saveBytes, slug } from "../download";
import { errorText } from "../server/error-text";
import { Film } from "./icons";

/**
 * A presentation video (SRS GS-24): a separate MP4 of one turn around the model, with a declared
 * camera path, size, length and frame rate. It is drawn frame by frame from the model as it is
 * shown, each frame only once the view is complete, and checked so that no frame is blank. A
 * caption on every frame says it is a presentation, not a measurement; the interactive model
 * stays the reference.
 */

const SIZES = { "720p": [1280, 720], "1080p": [1920, 1080] } as const;
const FPS = 30;
type Size = keyof typeof SIZES;

/** H.264 first (plays everywhere); VP9 in MP4 where the browser has no H.264 encoder. */
async function pickCodec(width: number, height: number): Promise<{ codec: string; mux: "avc" | "vp9" } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  for (const c of [{ codec: "avc1.640028", mux: "avc" as const }, { codec: "avc1.42E028", mux: "avc" as const }, { codec: "vp09.00.40.08", mux: "vp9" as const }]) {
    const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate: 8_000_000, framerate: FPS }).catch(() => null);
    if (r?.supported) return c;
  }
  return null;
}

/** Luminance spread of a small copy of the frame: near zero means a blank (single-colour) frame. */
function spread(src: HTMLCanvasElement, probe: CanvasRenderingContext2D): number {
  probe.drawImage(src, 0, 0, 32, 18);
  const d = probe.getImageData(0, 0, 32, 18).data;
  let s = 0;
  let s2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    s += y;
    s2 += y * y;
  }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}

export function PresentationVideo({ model }: { model: ModelSummary }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<Size>("720p");
  const [seconds, setSeconds] = useState(12);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const stop = useRef(false);

  const make = async () => {
    if (!engine) return;
    const [W, H] = SIZES[size];
    setProblem(null);
    setDone(null);
    const codec = await pickCodec(W, H);
    if (!codec) return setProblem(t("video.noEncoder"));
    const start = engine.orbitStart();
    if (!start) return setProblem(t("video.noModel"));
    const view = engine.getView();
    stop.current = false;
    setProgress(0);
    const frames = seconds * FPS;
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d")!;
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.canvas.width = 32;
    probe.canvas.height = 18;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: codec.mux, width: W, height: H, frameRate: FPS }, fastStart: "in-memory" });
    let failure: Error | null = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e as Error) });
    encoder.configure({ codec: codec.codec, width: W, height: H, bitrate: size === "1080p" ? 12_000_000 : 6_000_000, framerate: FPS });
    // A file for other programs, in English like the format it describes. i18n-ignore
    const caption = `${model.name} · HOLO presentation, not a measurement`;
    try {
      for (let i = 0; i < frames; i++) {
        if (stop.current) throw new Error(t("video.stopped"));
        if (failure) throw failure;
        engine.orbitTo(start, i / frames);
        let src = await engine.stillFrame();
        let tries = 0;
        // A frame drawn before the splats were sorted can come out empty: draw it again, then give up.
        while (spread(src, probe) < 1.5 && tries++ < 3) src = await engine.stillFrame(240);
        if (spread(src, probe) < 1.5) throw new Error(t("video.blank", { frame: i + 1 }));
        // Fit the view into the frame, keeping its shape; bars where the shapes differ.
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        const k = Math.min(W / src.width, H / src.height);
        const w = src.width * k;
        const h = src.height * k;
        ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
        ctx.font = `${Math.round(H / 40)}px system-ui, sans-serif`;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        const tw = ctx.measureText(caption).width;
        ctx.fillRect(H / 60, H - H / 60 - H / 26, tw + H / 30, H / 26);
        ctx.fillStyle = "#fff";
        ctx.fillText(caption, H / 60 + H / 60, H - H / 60 - H / 100);
        const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
        setProgress((i + 1) / frames);
      }
      await encoder.flush();
      muxer.finalize();
      const name = `${slug(model.name)}-presentation-${size}.mp4`;
      saveBytes(name, muxer.target.buffer, "video/mp4");
      setDone(name);
    } catch (e) {
      setProblem(errorText(e, t));
    } finally {
      if (encoder.state !== "closed") encoder.close();
      engine.setView(view);
      setProgress(null);
    }
  };

  const declaration = () => {
    // A file for other programs, in English like the format it describes. i18n-ignore
    const body = { format: "holo-presentation/1", model: model.name, version: model.version, video: { width: SIZES[size][0], height: SIZES[size][1], frameRate: FPS, seconds, frames: seconds * FPS }, cameraPath: "one full turn clockwise around the model's centre, starting from the view shown, at its distance and pitch", note: "A presentation of the interactive model, not a measurement." };
    saveBytes(`${slug(model.name)}-presentation.json`, new TextEncoder().encode(JSON.stringify(body, null, 2)).buffer as ArrayBuffer, "application/json");
  };

  if (!open)
    return (
      <button type="button" className="btn-secondary self-start" onClick={() => setOpen(true)} data-testid="video-open">
        <Film size={14} /> {t("video.open")}
      </button>
    );
  return (
    <div className="grid gap-2 rounded-[10px] border border-line bg-s2 p-2.5 text-[12px]" data-testid="video-panel">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <Film size={14} /> {t("video.title")}
      </p>
      <p className="text-fg3">{t("video.how")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-fg3">{t("video.size")}</span>
          <select className="input" value={size} onChange={(e) => setSize(e.target.value as Size)} disabled={progress !== null}>
            <option value="720p">1280 × 720</option>
            <option value="1080p">1920 × 1080</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-fg3">{t("video.length")}</span>
          <select className="input" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={progress !== null} data-testid="video-seconds">
            {[4, 8, 12, 20].map((s) => (
              <option key={s} value={s}>{t("video.seconds", { n: s })}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-fg3 num">{t("video.declared", { w: SIZES[size][0], h: SIZES[size][1], fps: FPS, s: seconds })}</p>
      {progress !== null && (
        <div className="grid gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-s3">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="text-fg3 num">{t("video.making", { p: Math.round(progress * 100) })}</span>
        </div>
      )}
      {problem && <p role="alert" className="text-danger">{problem}</p>}
      {done && <p className="text-fg2" data-testid="video-done">{t("video.done", { name: done })}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={declaration}>{t("video.saveDeclaration")}</button>
        {progress !== null ? (
          <button type="button" className="btn-secondary" onClick={() => (stop.current = true)}>{t("video.stop")}</button>
        ) : (
          <>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>{t("video.close")}</button>
            <button type="button" className="btn-primary" onClick={() => void make()} data-testid="video-make">{t("video.make")}</button>
          </>
        )}
      </div>
    </div>
  );
}
