import { useState } from "react";
import { useTranslation } from "react-i18next";
import { splatToPly, splatToSpz, tilesetZip, zipFiles, type PlacementSidecar } from "@viewer/core";
import type { ModelSummary } from "@viewer/shared";
import { useEngine, useSignal } from "../engine";
import { saveBytes, slug } from "../download";
import { addPlacementVersion, getModelDetail, listOriginals } from "../server/api";
import { errorText } from "../server/error-text";
import { refreshLibrary } from "../state/library";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { AlertTriangle, Columns2, Download, Ruler, Sparkles } from "./icons";
import { RealSize, scaleFromKnown, type SizeChoice } from "./RealSize";
import { ElevationCheck } from "./ElevationCheck";

/**
 * A splat model's real size and downloads, in Properties (docs/GAUSSIAN_SPLATS.md, scaling and
 * export). Setting a size never changes the files: on the server it adds a version with the same
 * files and the new scale, so the earlier version stays as it was.
 */
export function SplatPanel({ model }: { model: ModelSummary }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const server = useApp((s) => s.server);
  const addUpload = useApp((s) => s.addUpload);
  const { open: openModel, openVersion } = useOpenModel();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const placement = model.placement;
  const floating = !placement || placement.modelUnit !== undefined;
  const k = placement?.scale ?? 1;
  const [choice, setChoice] = useState<SizeChoice>({ mode: "known", side: "h", metres: "" });
  const live = !!server && !model.id.startsWith("upload-");
  const latest = model.version === model.versions;
  const info = engine?.splatInfo() ?? null;
  const upAxis = placement?.upAxis ?? "y";
  const comparing = useSignal(engine?.comparing, null);
  const history = useApp((s) => (s.versionHistory?.id === model.id ? s.versionHistory.list : null));
  const others = (history ?? []).filter((h) => h.version !== model.version);
  const compare = async (v: number) => {
    if (!engine || !server) return;
    setBusy("compare");
    setProblem(null);
    try {
      const d = await getModelDetail(server, model.id, v);
      if (!history) useApp.setState({ versionHistory: { id: d.id, list: d.history } });
      await engine.compareWith(d);
    } catch (e) {
      setProblem(t("splat.props.failed", { reason: errorText(e, t) }));
    } finally {
      setBusy(null);
    }
  };
  const fmtK = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(3) : v.toPrecision(3));

  const apply = async () => {
    if (!placement) return;
    const kNew = choice.mode === "known" ? scaleFromKnown(info?.size ?? undefined, upAxis, choice) : null;
    if (choice.mode === "known" && !kNew) return;
    const next = kNew ? { ...placement, scale: kNew, modelUnit: undefined } : { ...placement, scale: 1, modelUnit: 1 };
    const note = kNew ? t("splat.props.noteSize", { k: fmtK(kNew) }) : t("splat.props.noteFloating");
    setBusy("size");
    setProblem(null);
    try {
      if (live) {
        const s = await addPlacementVersion(server, model, next, note);
        await refreshLibrary().catch(() => undefined);
        await openVersion(model.id, s.version);
      } else {
        addUpload({ ...model, placement: next });
        setTimeout(() => openModel(model.id), 0);
      }
      setEditing(false);
    } catch (e) {
      setProblem(errorText(e, t));
    } finally {
      setBusy(null);
    }
  };

  const bytes = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const sidecar = (metresPerUnit: number): PlacementSidecar | undefined =>
    floating || !placement
      ? undefined
      : // A file for other programs, in English like the format it describes. i18n-ignore
        { format: "holo-placement/1", crs: "EPSG:4979", lat: placement.lat, lon: placement.lon, height: placement.height, headingDeg: placement.headingDeg ?? 0, metresPerUnit, upAxis: "y", note: "The model's origin stands at lat, lon and height; heading turns it clockwise from north." };
  const mainOriginal = async () => {
    const list = await listOriginals(server!, model.id, model.version);
    const main = list.find((f) => /\.(spz|ply)$/i.test(f.path));
    if (!main) throw new Error(t("splat.props.noOriginal"));
    return main;
  };
  const run = (what: string, job: () => Promise<void>) => async () => {
    setBusy(what);
    setProblem(null);
    try {
      await job();
    } catch (e) {
      setProblem(t("splat.props.failed", { reason: errorText(e, t) }));
    } finally {
      setBusy(null);
    }
  };
  const name = slug(model.name);
  const downloadOriginal = run("original", async () => {
    const f = await mainOriginal();
    saveBytes(f.path.split("/").pop()!, (await bytes(f.url)).buffer as ArrayBuffer);
  });
  const downloadSpz = run("spz", async () => {
    const f = await mainOriginal();
    // Decoding a large PLY takes a moment: let the button show "Preparing…" first.
    await new Promise((r) => setTimeout(r, 30));
    const spz = splatToSpz(f.path, await bytes(f.url), floating ? 1 : k);
    const side = sidecar(1);
    if (!side) return saveBytes(`${name}.spz`, spz.buffer as ArrayBuffer);
    const zip = await zipFiles({ [`${name}.spz`]: spz, "holo-placement.json": new TextEncoder().encode(JSON.stringify(side, null, 2)) });
    saveBytes(`${name}-spz.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });
  const downloadPly = run("ply", async () => {
    const f = await mainOriginal();
    await new Promise((r) => setTimeout(r, 30));
    const ply = splatToPly(f.path, await bytes(f.url), floating ? 1 : k);
    const side = sidecar(1);
    if (!side) return saveBytes(`${name}.ply`, ply.buffer as ArrayBuffer);
    const zip = await zipFiles({ [`${name}.ply`]: ply, "holo-placement.json": new TextEncoder().encode(JSON.stringify(side, null, 2)) });
    saveBytes(`${name}-ply.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });
  const downloadTiles = run("tiles", async () => {
    const zip = await tilesetZip(model.source.url, bytes, floating || !info ? {} : { placeMatrix: info.modelMatrix, sidecar: sidecar(1) });
    saveBytes(`${name}-3dtiles.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line bg-s2 p-3" data-testid="splat-panel">
      <h3 className="flex items-center gap-2 font-semibold">
        <Sparkles size={15} className="text-accent" /> {t("splat.props.title")}
      </h3>
      <p className="text-[12px] text-fg2" data-testid="splat-size">
        {floating ? t("splat.props.floating") : t("splat.props.scaled", { k: fmtK(k) })}
      </p>
      {editing ? (
        <div className="grid gap-2">
          {info?.size ? (
            <RealSize size={info.size} upAxis={upAxis} value={choice} onChange={setChoice} splats />
          ) : (
            <p className="text-[12px] text-fg3">{t("splat.props.noSize")}</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>{t("splat.props.cancel")}</button>
            <button
              type="button"
              className="btn-primary"
              data-testid="splat-size-save"
              disabled={!!busy || (choice.mode === "known" ? !scaleFromKnown(info?.size ?? undefined, upAxis, choice) : floating)}
              onClick={() => void apply()}
            >
              {busy === "size" ? t("splat.props.saving") : live ? t("splat.props.save") : t("splat.props.apply")}
            </button>
          </div>
        </div>
      ) : live && !latest ? (
        <p className="text-[12px] text-fg3">{t("splat.props.olderVersion")}</p>
      ) : (
        <button type="button" className="btn-secondary self-start" onClick={() => setEditing(true)} data-testid="splat-set-size">
          <Ruler size={14} /> {floating ? t("splat.props.setSize") : t("splat.props.changeSize")}
        </button>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-fg3">{t("splat.props.download")}</span>
        {live && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void downloadOriginal()} data-testid="splat-dl-original">
            <Download size={14} /> {busy === "original" ? t("splat.props.preparing") : t("splat.props.original")}
          </button>
        )}
        {live && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void downloadSpz()} data-testid="splat-dl-spz">
            <Download size={14} /> {busy === "spz" ? t("splat.props.preparing") : t("splat.props.spz")}
          </button>
        )}
        {live && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void downloadPly()} data-testid="splat-dl-ply">
            <Download size={14} /> {busy === "ply" ? t("splat.props.preparing") : t("splat.props.ply")}
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void downloadTiles()} data-testid="splat-dl-tiles">
          <Download size={14} /> {busy === "tiles" ? t("splat.props.preparing") : t("splat.props.tiles")}
        </button>
      </div>
      <p className="text-[12px] text-fg3">{floating ? t("splat.props.downloadFloating") : t("splat.props.downloadPlaced")}</p>
      {live && !floating && info && (
        <ElevationCheck
          name={model.name}
          modelMatrix={info.modelMatrix}
          splatsFile={async () => {
            const f = await mainOriginal();
            return { path: f.path, data: await bytes(f.url) };
          }}
        />
      )}
      {live && model.versions > 1 && (
        <label className="mt-1 grid gap-1">
          <span className="flex items-center gap-1.5 text-[12px] text-fg3">
            <Columns2 size={14} /> {t("compare.title")}
          </span>
          <select
            className="input"
            value={comparing?.id === model.id ? String(comparing.version) : ""}
            disabled={busy === "compare"}
            onFocus={() => !history && server && void getModelDetail(server, model.id).then((d) => useApp.setState({ versionHistory: { id: d.id, list: d.history } }), () => undefined)}
            onChange={(e) => (e.target.value ? void compare(Number(e.target.value)) : engine?.stopCompare())}
            data-testid="compare-pick"
          >
            <option value="">{busy === "compare" ? t("compare.loading") : t("compare.none")}</option>
            {others.map((h) => (
              <option key={h.version} value={h.version}>
                v{h.version}
                {h.note ? ` · ${h.note}` : ""}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-fg3">{t("compare.hint")}</span>
        </label>
      )}
      {problem && <p role="alert" className="text-[12px] text-danger">{problem}</p>}
    </section>
  );
}

/**
 * Shown above measurements and analysis while a splat model is open (SRS GS-20): splats are an
 * appearance, so nothing measured on or through them is a certified surface or obstruction.
 */
export function SplatGeometryNote() {
  const { t } = useTranslation();
  const engine = useEngine();
  const model = useSignal(engine?.current, null);
  if (!model?.source.splats) return null;
  return (
    <div role="status" data-testid="splat-geometry-note" className="flex items-start gap-2 rounded-[10px] border border-[var(--status-production)] px-2.5 py-2 text-[12px] text-fg">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--status-production)]" />
      {t("splat.props.notSurface")}
    </div>
  );
}
