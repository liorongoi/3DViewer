import { fractionBitsFor, toU8, type SplatCloud } from "./cloud";
import { encodeSpzV2 } from "./spz";
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

type Tile = { content?: { uri?: string; url?: string }; children?: Tile[]; transform?: number[] };

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
    const c = t.content;
    const uri = c?.uri ?? c?.url;
    if (c && uri) {
      const plain = !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith("/") && !uri.split("/").includes("..");
      let name = plain ? decodeURIComponent(uri.split(/[?#]/)[0]!) : "";
      while (!name || files[name]) name = `local/${n++}.glb`;
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
