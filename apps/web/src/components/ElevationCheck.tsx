import { useState } from "react";
import { useTranslation } from "react-i18next";
import { compareElevation, readElevationRaster, readSplatFile, splatBox, type ElevationComparison } from "@viewer/core";
import { saveBytes, slug } from "../download";
import { errorText } from "../server/error-text";
import { Mountain } from "./icons";

/**
 * Splat heights against an independent DSM or DTM (SRS GS-06). The operator picks the GeoTIFF,
 * says whether it is a surface or bare-earth model and what its heights are measured from; the
 * comparison runs here, on the original splats and the placement shown, and can be saved as a report.
 */
export function ElevationCheck({ name, splatsFile, modelMatrix }: { name: string; splatsFile: () => Promise<{ path: string; data: Uint8Array }>; modelMatrix: number[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"DSM" | "DTM">("DSM");
  const [datum, setDatum] = useState<"ellipsoid" | "sea">("ellipsoid");
  const [geoid, setGeoid] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<(ElevationComparison & { file: string; sha256: string }) | null>(null);
  const geoidOk = datum === "ellipsoid" || (geoid.trim() !== "" && Number.isFinite(Number(geoid)));

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      const f = await splatsFile();
      await new Promise((r) => setTimeout(r, 30));
      const { cloud } = readSplatFile(f.path, f.data);
      const ref = await readElevationRaster(file, splatBox(cloud, modelMatrix));
      const r = compareElevation(cloud, modelMatrix, ref, { kind, referenceOffset: datum === "sea" ? Number(geoid) : 0 });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
      setResult({ ...r, file: file.name, sha256: digest });
    } catch (e) {
      setProblem(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const report = () => {
    if (!result) return;
    // A file for other programs, in English like the format it describes. i18n-ignore
    const body = { format: "holo-elevation-check/1", model: name, reference: { file: result.file, sha256: result.sha256, kind: result.kind, epsg: result.epsg, cellSize: result.cellSize, heightsFrom: datum === "sea" ? "sea level" : "WGS 84 ellipsoid", addedToReference: result.referenceOffset }, result, note: "Model minus reference, in metres. Splats are not a measured surface; this compares this placement with this reference only." };
    saveBytes(`${slug(name)}-elevation-check.json`, new TextEncoder().encode(JSON.stringify(body, null, 2)).buffer as ArrayBuffer, "application/json");
  };
  const m = (v: number) => `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2)} m`;

  if (!open)
    return (
      <button type="button" className="btn-secondary self-start" onClick={() => setOpen(true)} data-testid="elev-open">
        <Mountain size={14} /> {t("elev.open")}
      </button>
    );
  return (
    <div className="grid gap-2 rounded-[10px] border border-line p-2.5" data-testid="elev-check">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <Mountain size={14} /> {t("elev.title")}
      </p>
      <label className="grid gap-1 text-[12px]">
        <span className="text-fg3">{t("elev.file")}</span>
        <input type="file" accept=".tif,.tiff,image/tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="elev-file" />
      </label>
      <fieldset className="grid gap-1 text-[12px]">
        <legend className="text-fg3">{t("elev.kind")}</legend>
        {(["DSM", "DTM"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="radio" name="elev-kind" checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--accent)]" />
            {t(`elev.kind_${k}`)}
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-1 text-[12px]">
        <legend className="text-fg3">{t("elev.datum")}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="elev-datum" checked={datum === "ellipsoid"} onChange={() => setDatum("ellipsoid")} className="accent-[var(--accent)]" />
          {t("elev.ellipsoid")}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="elev-datum" checked={datum === "sea"} onChange={() => setDatum("sea")} className="accent-[var(--accent)]" />
          {t("elev.sea")}
        </label>
        {datum === "sea" && (
          <label className="ms-6 grid gap-1">
            <span className="text-fg3">{t("elev.geoid")}</span>
            <input className="input num w-28" inputMode="decimal" value={geoid} onChange={(e) => setGeoid(e.target.value)} data-testid="elev-geoid" />
          </label>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>{t("elev.close")}</button>
        <button type="button" className="btn-primary" disabled={!file || !geoidOk || busy} onClick={() => void run()} data-testid="elev-run">
          {busy ? t("elev.running") : t("elev.run")}
        </button>
      </div>
      {problem && <p role="alert" className="text-[12px] text-danger">{problem}</p>}
      {result && (
        <div className="grid gap-1 text-[12px]" data-testid="elev-result">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 num">
            <dt className="text-fg3">{t("elev.cells")}</dt>
            <dd>{result.cells.toLocaleString()} × {result.cellSize} m</dd>
            <dt className="text-fg3">{t("elev.mean")}</dt>
            <dd>{m(result.meanDifference)}</dd>
            <dt className="text-fg3">{t("elev.rms")}</dt>
            <dd>{m(result.rms)}</dd>
            <dt className="text-fg3">{t("elev.rmsShift")}</dt>
            <dd>{m(result.rmsAfterShift)}</dd>
            <dt className="text-fg3">{t("elev.p95")}</dt>
            <dd>{m(result.p95Abs)}</dd>
            <dt className="text-fg3">{t("elev.max")}</dt>
            <dd>{m(result.maxAbs)}</dd>
          </dl>
          <p className="text-fg3">{t("elev.meaning")}</p>
          <button type="button" className="btn-secondary self-start" onClick={report} data-testid="elev-report">
            {t("elev.report")}
          </button>
        </div>
      )}
    </div>
  );
}
