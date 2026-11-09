import { FileSet, expandFiles, ext, LoadError, type LocalFile } from "./files";
import { gltfLoader } from "./gltf";
import { tiles3dLoader } from "./tiles3d";
import { readSidecar } from "./sidecar";
import { checkItem, type CheckItem, type CheckReport, type LoaderPlugin, type Prepared, type UrlMaker } from "./types";

export * from "./types";
export { fromBytes, expandFiles, resolvePath, type LocalFile } from "./files";
export { parseGlb, SUPPORTED_GLTF_EXTENSIONS } from "./gltf";
export { parseMetadataXml } from "./sidecar";
export { placementFromGrid, type GridPosition, type Placement } from "../geo/place";

/** FBX is read on the server (FBX2glTF); the browser only recognises it. */
const fbxLoader: LoaderPlugin = {
  id: "fbx",
  format: "fbx",
  main: (files) => files.files.find((f) => ext(f.path) === "fbx") ?? null,
  async check(main, files) {
    const data = await main.bytes();
    const head = new TextDecoder().decode(data.subarray(0, 23));
    const binary = head.startsWith("Kaydara FBX Binary");
    const version = binary && data.byteLength >= 27 ? new DataView(data.buffer, data.byteOffset + 23, 4).getUint32(0, true) : null;
    const format: CheckItem =
      binary && (version === null || version < 6000 || version > 8000)
        ? checkItem("format", "error", "fbxDamaged", { version: version ?? "?" })
        : binary
          ? checkItem("format", "ok", "fbxBinary", { version: (version! / 1000).toFixed(1) })
          : /FBXHeaderExtension|FBXVersion/.test(new TextDecoder().decode(data.subarray(0, 2048)))
            ? checkItem("format", "ok", "fbxAscii")
            : checkItem("format", "error", "notFbx");
    return {
      items: [
        format,
        checkItem("conversion", "warning", "fbxConvert"),
      ],
      stats: { files: files.files.length, bytes: files.bytes },
      nodes: [],
      georef: null,
    };
  },
};

const registry: LoaderPlugin[] = [tiles3dLoader, gltfLoader, fbxLoader];

export function registerLoader(p: LoaderPlugin): void {
  const i = registry.findIndex((x) => x.id === p.id);
  if (i >= 0) registry[i] = p;
  else registry.unshift(p);
}

export const loaders = (): readonly LoaderPlugin[] => registry;

/** Size limits from UPL-03. */
export const LIMITS = { file: 2 * 1024 ** 3, tileset: 50 * 1024 ** 3 };

/** Reads what the user dropped, picks a loader, and lists every problem it finds. */
export async function checkFiles(input: LocalFile[]): Promise<{ report: CheckReport; files: LocalFile[] }> {
  let files: LocalFile[];
  try {
    files = await expandFiles(input);
  } catch (e) {
    const report: CheckReport = { loader: null, format: null, mainFile: null, ok: false, items: [{ id: "format", severity: "error", title: (e as LoadError).message }], stats: { files: input.length, bytes: 0 }, nodes: [], georef: null };
    return { report, files: input };
  }
  const set = new FileSet(files);
  for (const p of registry) {
    const main = p.main(set);
    if (!main) continue;
    const r = await p.check(main, set);
    const big = files.filter((f) => f.size > LIMITS.file);
    if (p.format !== "3dtiles" && big.length) r.items.push(checkItem("size", "error", "fileTooBig", {}, big.map((f) => f.path).join(", ")));
    else if (set.bytes > LIMITS.tileset) r.items.push(checkItem("size", "error", "tilesetTooBig"));
    else r.items.push(checkItem("size", "ok", "filesSize", { count: files.length, size: fmtBytes(set.bytes) }));
    const side = r.georef ? null : await readSidecar(set, main.path);
    if (side) {
      r.items.push(...side.items);
      r.filePosition = side.position;
    }
    if (r.georef) r.items.push(checkItem("georef", "ok", "georeferenced", { lat: r.georef.lat.toFixed(5), lon: r.georef.lon.toFixed(5) }));
    else if (!r.filePosition) r.items.push(checkItem("georef", "warning", "noPosition"));
    const report: CheckReport = { ...r, loader: p.id, format: p.format === "glb" && ext(main.path) === "gltf" ? "gltf" : p.format, mainFile: main.path, ok: !r.items.some((i) => i.severity === "error") };
    return { report, files };
  }
  const exts = [...new Set(files.map((f) => ext(f.path) || "(none)"))].join(", ");
  return {
    report: { loader: null, format: null, mainFile: null, ok: false, items: [checkItem("format", "error", "noModel", { found: exts })], stats: { files: files.length, bytes: set.bytes }, nodes: [], georef: null },
    files,
  };
}

/** Turns a checked set into a URL the engine can load. Object URLs live until release(). */
export async function prepareFiles(files: LocalFile[], report: CheckReport): Promise<Prepared> {
  const p = registry.find((x) => x.id === report.loader);
  const set = new FileSet(files);
  const main = report.mainFile ? set.get(report.mainFile) : undefined;
  if (!p?.prepare || !main) throw new LoadError("This file cannot be opened in the browser.");
  const kind = p.format === "3dtiles" ? "3dtiles" : "glb";
  // Read in place: tiles, buffers and textures resolve beside it, as on a server.
  if (main.url && (p === tiles3dLoader || p === gltfLoader)) return { kind, url: main.url, release: () => undefined };
  const made: string[] = [];
  const url: UrlMaker = (data, type) => {
    const u = URL.createObjectURL(new Blob([data] as ConstructorParameters<typeof Blob>[0], type ? { type } : undefined));
    made.push(u);
    return u;
  };
  const u = await p.prepare(main, set, url);
  return { kind, url: u, release: () => made.forEach((x) => URL.revokeObjectURL(x)) };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
