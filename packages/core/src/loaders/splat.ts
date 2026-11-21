import { readSplatFile, splatFormatOf, splatTiles, SplatError, type SplatSourceInfo } from "../splat";
import { robustBounds } from "../splat/cloud";
import { ext, type LocalFile } from "./files";
import { checkItem, type CheckItem, type LoaderPlugin } from "./types";

/**
 * Finished Gaussian splat models (SRS GS-11 to GS-16): an SPZ file, or the PLY a splat trainer
 * writes. The check reads the whole file, so a damaged or unsupported one is refused before
 * anything is published, with the reason. Opening it draws it as 3D Tiles (Cesium's Gaussian
 * splat support); the file itself is never changed.
 */

/** What check() read, so prepare() does not read a 500 MB file twice. */
const read = new WeakMap<LocalFile, ReturnType<typeof readSplatFile>>();

export const splatLoader: LoaderPlugin = {
  id: "splat",
  format: "spz",
  main(files) {
    const all = files.files.filter((f) => splatFormatOf(f.path));
    // One model per upload: the SPZ if there is one, else the PLY.
    return all.find((f) => ext(f.path) === "spz") ?? all[0] ?? null;
  },
  async check(main, files) {
    const items: CheckItem[] = [];
    const stats: { files: number; bytes: number; splats?: number; shDegree?: number; size?: [number, number, number] } = { files: files.files.length, bytes: files.bytes };
    let r: ReturnType<typeof readSplatFile>;
    try {
      r = readSplatFile(main.path, await main.bytes());
    } catch (e) {
      const why = e instanceof SplatError ? e.message : `The file could not be read: ${e instanceof Error ? e.message : String(e)}`;
      items.push(checkItem("format", "error", "splatUnreadable", { file: main.path.split("/").pop()! }, why));
      return { items, stats, nodes: [], georef: null };
    }
    read.set(main, r);
    const { cloud, info } = r;
    const others = files.files.filter((f) => f !== main && splatFormatOf(f.path));
    if (others.length) items.push(checkItem("structure", "warning", "splatOneModel", { file: main.path, count: others.length }, others.slice(0, 5).map((f) => f.path).join(", ")));
    items.push(
      info.format === "spz"
        ? checkItem("format", "ok", "splatSpz", { version: info.version ?? 2, count: info.count.toLocaleString("en"), sh: info.shDegree })
        : checkItem("format", "ok", "splatPly", { count: info.count.toLocaleString("en"), sh: info.shDegree }),
    );
    const conversion: SplatSourceInfo["conversion"] = info.count > 1_000_000 ? "retiled" : r.spzV2 ? "unchanged" : info.format === "spz" ? "spz3-to-spz2" : "ply-to-spz2";
    items.push(checkItem("conversion", "ok", `splat_${conversion.replace(/-/g, "_")}`));
    if (info.reducedRotationPrecision) items.push(checkItem("conversion", "warning", "splatRotationPrecision"));
    if (info.extraProperties?.length) items.push(checkItem("content", "warning", "splatExtraProps", {}, info.extraProperties.join(", ")));
    const b = robustBounds(cloud.pos, cloud.count);
    stats.splats = info.count;
    stats.shDegree = info.shDegree;
    stats.size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    return { items, stats, nodes: [], georef: null, splat: { ...info, conversion } };
  },
  async prepare(main, _files, url) {
    const r = read.get(main) ?? readSplatFile(main.path, await main.bytes());
    const t = splatTiles(r.cloud, { originalSpzV2: r.spzV2 });
    // Tile GLBs first, then the tileset with their URLs in place of the file names.
    const urls = new Map<string, string>();
    for (const f of t.files) if (f.path !== "tileset.json") urls.set(f.path, url(f.data, "model/gltf-binary"));
    const ts = new TextDecoder().decode(t.files.find((f) => f.path === "tileset.json")!.data);
    return url(ts.replace(/"uri":"([^"]+)"/g, (m, p: string) => (urls.has(p) ? `"uri":"${urls.get(p)}"` : m)), "application/json");
  },
};
