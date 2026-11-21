import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { glbTilesetZip, glbToGltf, tilesetZip, zipFiles, type PlacementSidecar } from "@viewer/core";
import type { ModelSummary } from "@viewer/shared";
import { useEngine } from "../engine";
import { saveBytes, slug } from "../download";
import { listOriginals, type OriginalFile } from "../server/api";
import { errorText } from "../server/error-text";
import { useApp } from "../state/store";
import { Download } from "./icons";

/**
 * Downloads of a mesh or 3D Tiles model (SRS GS-31): the original file unchanged, GLB, glTF and
 * 3D Tiles. Nothing is converted on the server and the published files are never changed. HOLO
 * does not write FBX, so FBX is offered only when the original was one. Every zip carries
 * holo-placement.json when the model is placed on the globe, and the GLB and glTF zips also
 * holo-model.json (name, version, attribution).
 */
export function ModelExport({ model }: { model: ModelSummary }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const server = useApp((s) => s.server);
  const [originals, setOriginals] = useState<OriginalFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const live = !!server && !model.id.startsWith("upload-");
  const glb = model.source.kind === "glb";
  const p = model.placement;
  const placed = !!p && p.modelUnit === undefined;
  const name = slug(model.name);

  useEffect(() => {
    if (!live) return setOriginals([]);
    let gone = false;
    listOriginals(server, model.id, model.version)
      .then((l) => !gone && setOriginals(l))
      .catch(() => !gone && setOriginals([]));
    return () => {
      gone = true;
    };
  }, [live, server, model.id, model.version]);

  const fbx = originals?.find((f) => /\.fbx$/i.test(f.path));
  const main = originals?.find((f) => !/\.(json|txt|md)$/i.test(f.path));

  const bytes = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
  // Files for other programs, in English like the formats they describe. i18n-ignore
  const about = { format: "holo-model/1", name: model.name, version: model.version, attribution: model.source.attribution ?? null, placement: placed ? p : null };
  const sidecar = (): PlacementSidecar | undefined =>
    placed && p
      ? // i18n-ignore
        { format: "holo-placement/1", crs: "EPSG:4979", lat: p.lat, lon: p.lon, height: p.height, headingDeg: p.headingDeg ?? 0, metresPerUnit: p.scale ?? 1, upAxis: p.upAxis ?? "y", note: "The model's origin stands at lat, lon and height; heading turns it clockwise from north; metresPerUnit scales the file to metres." }
      : undefined;
  const extras = (): Record<string, Uint8Array> => {
    const side = sidecar();
    return { "holo-model.json": json(about), ...(side ? { "holo-placement.json": json(side) } : {}) };
  };

  const run = (what: string, job: () => Promise<void>) => async () => {
    setBusy(what);
    setProblem(null);
    try {
      await job();
    } catch (e) {
      setProblem(t("exportModel.failed", { reason: errorText(e, t) }));
    } finally {
      setBusy(null);
    }
  };
  const saveFile = async (f: { path: string; url: string }) => saveBytes(f.path.split("/").pop()!, (await bytes(f.url)).buffer as ArrayBuffer);

  const original = run("original", async () => {
    if (main) return saveFile(main);
    // An upload or a model with no kept original: its GLB is the file as it came in.
    if (glb) return saveBytes(`${name}.glb`, (await bytes(model.source.url)).buffer as ArrayBuffer, "model/gltf-binary");
    throw new Error(t("exportModel.noOriginal"));
  });
  const downloadGlb = run("glb", async () => {
    const zip = await zipFiles({ [`${name}.glb`]: await bytes(model.source.url), ...extras() });
    saveBytes(`${name}-glb.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });
  const downloadGltf = run("gltf", async () => {
    const zip = await zipFiles({ ...glbToGltf(await bytes(model.source.url), name), ...extras() });
    saveBytes(`${name}-gltf.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });
  const downloadFbx = run("fbx", async () => {
    if (fbx) await saveFile(fbx);
  });
  const frame = glb ? engine?.glbFrame() ?? null : null;
  const tilesOk = glb ? !!frame : true;
  const downloadTiles = run("tiles", async () => {
    let zip: Uint8Array;
    if (glb) {
      if (!frame) throw new Error(t("exportModel.noTiles"));
      zip = await glbTilesetZip(await bytes(model.source.url), name, frame.transform, frame.sphere, sidecar());
    } else {
      const m = engine?.tilesetMatrix() ?? null;
      zip = await tilesetZip(model.source.url, bytes, m ? { placeMatrix: m, sidecar: sidecar() } : {});
    }
    saveBytes(`${name}-3dtiles.zip`, zip.buffer as ArrayBuffer, "application/zip");
  });

  const btn = (what: string, label: string, onClick: () => void, disabled = false, title?: string) => (
    <button type="button" className="btn-secondary" disabled={!!busy || disabled} title={title} onClick={onClick} data-testid={`export-${what}`}>
      <Download size={13} /> {busy === what ? t("exportModel.preparing") : label}
    </button>
  );

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line bg-s2 p-3 text-[12px]" data-testid="model-export">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        <Download size={15} className="text-accent" /> {t("exportModel.title")}
      </h3>
      <p className="text-fg3">{placed ? t("exportModel.placedNote") : t("exportModel.floatingNote")}</p>
      <div className="flex flex-wrap gap-2">
        {(main || glb) && btn("original", t("exportModel.original"), () => void original())}
        {glb && btn("glb", t("exportModel.glb"), () => void downloadGlb())}
        {glb && btn("gltf", t("exportModel.gltf"), () => void downloadGltf())}
        {btn("fbx", t("exportModel.fbx"), () => void downloadFbx(), !fbx, fbx ? undefined : t("exportModel.noFbx"))}
        {btn("tiles", t("exportModel.tiles"), () => void downloadTiles(), !tilesOk, tilesOk ? undefined : t("exportModel.noTiles"))}
      </div>
      {!fbx && <p className="text-fg3">{t("exportModel.noFbx")}</p>}
      {problem && (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      )}
    </section>
  );
}
