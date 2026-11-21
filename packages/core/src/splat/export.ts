import { fractionBitsFor, toU8, type SplatCloud } from "./cloud";
import { encodeSpzV2 } from "./spz";
import { encodePly } from "./ply";
import { splatGlb } from "./tiles";
import { readSplatFile } from "./index";

/**
 * Splat downloads (docs/GAUSSIAN_SPLATS.md, "Export"). A floating model leaves as it came, in its
 * own units with no position. A model given a real size leaves at that size: positions are
 * multiplied by the scale and every splat's size grows with them (sizes are stored as logarithms
 * in steps of 1/16, so a size can move by up to 3 %; positions are exact).
 */

/** The cloud at `k` times its size. */
export function scaledCloud(c: SplatCloud, k: number): SplatCloud {
  if (!(k > 0) || !Number.isFinite(k)) throw new RangeError("The scale must be a positive number.");
  const pos = new Float32Array(c.pos.length);
  let maxAbs = 0;
  for (let i = 0; i < pos.length; i++) {
    pos[i] = c.pos[i]! * k;
    maxAbs = Math.max(maxAbs, Math.abs(pos[i]!));
  }
  const step = Math.log(k) * 16;
  const scales = new Uint8Array(c.scales.length);
  for (let i = 0; i < scales.length; i++) scales[i] = toU8(c.scales[i]! + step);
  return { ...c, pos, scales, fractionalBits: fractionBitsFor(maxAbs) };
}

/**
 * An SPZ of the splat file `name`, scaled by `k` (1 or undefined: unscaled). An unscaled SPZ
 * version 2 file is returned byte for byte; anything else is written as SPZ version 2.
 */
export function splatToSpz(name: string, data: Uint8Array, k?: number): Uint8Array {
  const scale = k && k !== 1 ? k : 1;
  const r = readSplatFile(name, data);
  if (scale === 1 && r.spzV2) return r.spzV2;
  return encodeSpzV2(scale === 1 ? r.cloud : scaledCloud(r.cloud, scale));
}

/** A standard splat PLY of the splat file `name`, scaled by `k` (1 or undefined: unscaled). */
export function splatToPly(name: string, data: Uint8Array, k?: number): Uint8Array {
  const scale = k && k !== 1 ? k : 1;
  const r = readSplatFile(name, data);
  return encodePly(scale === 1 ? r.cloud : scaledCloud(r.cloud, scale));
}

/**
 * The splat file `name` as one GLB with KHR_gaussian_splatting (SPZ v2 compressed, as HOLO's own
 * tiles carry it), scaled by `k`. glTF's y-up frame, the same as the viewer's.
 */
export function splatToGlb(name: string, data: Uint8Array, k?: number): Uint8Array {
  const scale = k && k !== 1 ? k : 1;
  const r = readSplatFile(name, data);
  const c = scale === 1 ? r.cloud : scaledCloud(r.cloud, scale);
  return splatGlb(c, scale === 1 && r.spzV2 ? r.spzV2 : undefined);
}

/** Where a splat model stands, written beside a download of a model that has a real size. */
export interface PlacementSidecar {
  format: "holo-placement/1";
  crs: "EPSG:4979";
  lat: number;
  lon: number;
  height: number;
  headingDeg: number;
  /** Metres per unit of the downloaded file (1 when the scale is already applied to it). */
  metresPerUnit: number;
  upAxis: "y" | "z";
  note: string;
}

type Tile = { content?: { uri?: string; url?: string }; contents?: unknown[]; children?: Tile[]; transform?: number[]; implicitTiling?: unknown };

const mul4 = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A 3D Tiles download as a zip: tileset.json and every tile it names, fetched with `get`. Tiles
 * whose address is not a plain relative path (object URLs of a model opened on this computer) are
 * renamed local/<n>.glb. With `placeMatrix` (column-major, from the viewer) the root is placed on
 * the globe, so other 3D Tiles viewers show it where HOLO does; without it the tiles stay in their
 * own frame, floating. A sidecar, when given, goes in as holo-placement.json.
 */
export async function tilesetZip(tilesetUrl: string, get: (url: string) => Promise<Uint8Array>, opts: { placeMatrix?: number[]; sidecar?: PlacementSidecar } = {}): Promise<Uint8Array> {
  const { zipSync } = await import("fflate");
  const ts = JSON.parse(new TextDecoder().decode(await get(tilesetUrl))) as { root: Tile } & Record<string, unknown>;
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  const visit = async (t: Tile) => {
    // What this cannot copy whole is refused, never downloaded in part (SRS GS-31).
    if (t.implicitTiling) throw new Error("Tilesets with implicit tiling are not downloaded yet: the tiles are not all listed in tileset.json.");
    if (t.contents) throw new Error("Tiles with several contents are not downloaded yet.");
    const c = t.content;
    const uri = c?.uri ?? c?.url;
    if (c && uri) {
      const plain = !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith("/") && !uri.split("/").includes("..");
      let name = plain ? decodeURIComponent(uri.split(/[?#]/)[0]!) : "";
      // A decoded name must still be a plain relative path, so the zip never holds "../" entries.
      if (name.split(/[\\/]/).some((p) => p === ".." || p === "") || /^[a-z]:/i.test(name)) name = "";
      const ext = /\.(glb|b3dm|i3dm|pnts|cmpt)(?=$|[?#])/i.exec(uri)?.[1]?.toLowerCase() ?? "glb";
      while (!name || files[name]) name = `local/${n++}.${ext}`;
      if (/\.json$/i.test(name)) throw new Error("External tilesets inside a tileset are not downloaded.");
      files[name] = await get(new URL(uri, tilesetUrl).href);
      t.content = { uri: name.split("/").map(encodeURIComponent).join("/") };
    }
    for (const ch of t.children ?? []) await visit(ch);
  };
  await visit(ts.root);
  if (opts.placeMatrix) ts.root.transform = mul4(opts.placeMatrix, ts.root.transform ?? IDENTITY);
  files["tileset.json"] = new TextEncoder().encode(JSON.stringify(ts));
  if (opts.sidecar) files["holo-placement.json"] = new TextEncoder().encode(JSON.stringify(opts.sidecar, null, 2));
  return zipSync(files, { level: 0 });
}

/** Several files as one uncompressed zip (the contents are compressed already). */
export async function zipFiles(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const { zipSync } = await import("fflate");
  return zipSync(files, { level: 0 });
}

/** Splits a GLB into a .gltf (JSON) and its .bin, the images staying inside the .bin as buffer views. */
export function glbToGltf(glb: Uint8Array, name: string): Record<string, Uint8Array> {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error("This is not a glTF 2.0 binary (GLB) file.");
  let o = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (o + 8 <= glb.byteLength) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const chunk = glb.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>;
    else if (type === 0x004e4942) bin = chunk;
    o += 8 + len;
  }
  if (!json) throw new Error("The GLB has no JSON part.");
  const buffers = (json.buffers as { uri?: string; byteLength: number }[] | undefined) ?? [];
  if (buffers.some((b, i) => (i === 0 ? !!b.uri : !b.uri))) throw new Error("The GLB refers to buffers outside itself, so it cannot be split exactly.");
  const out: Record<string, Uint8Array> = {};
  if (bin && buffers[0]) {
    buffers[0].uri = `${encodeURIComponent(name)}.bin`;
    out[`${name}.bin`] = bin.slice(0, buffers[0].byteLength);
  }
  out[`${name}.gltf`] = new TextEncoder().encode(JSON.stringify(json));
  return out;
}

/** A GLB as a one-tile 3D Tiles set, placed by `transform` (column-major), with its bounding sphere in that frame. */
export async function glbTilesetZip(glb: Uint8Array, name: string, transform: number[], sphere: [number, number, number, number], sidecar?: PlacementSidecar): Promise<Uint8Array> {
  const { zipSync } = await import("fflate");
  const uri = `${name}.glb`;
  const tileset = { asset: { version: "1.1", generator: "HOLO" }, geometricError: sphere[3] * 2, root: { transform, boundingVolume: { sphere }, geometricError: 0, refine: "ADD", content: { uri: encodeURIComponent(uri) } } };
  const files: Record<string, Uint8Array> = { "tileset.json": new TextEncoder().encode(JSON.stringify(tileset)), [uri]: glb };
  if (sidecar) files["holo-placement.json"] = new TextEncoder().encode(JSON.stringify(sidecar, null, 2));
  return zipSync(files, { level: 0 });
}
