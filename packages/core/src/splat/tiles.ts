import { bounds, fractionBitsFor, robustBounds, shDim, subset, type SplatBounds, type SplatCloud } from "./cloud";
import { encodeSpzV2 } from "./spz";

/**
 * Gaussian splats as OGC 3D Tiles 1.1 that Cesium draws: each tile is a GLB whose one POINTS
 * primitive carries KHR_gaussian_splatting with KHR_gaussian_splatting_compression_spz_2, the
 * SPZ v2 bytes in the binary chunk. The tileset declares both as required glTF extensions, which
 * is how Cesium knows to draw the content as splats.
 *
 * A cloud up to `singleMax` splats is one tile. A larger one is split along its longest side at
 * the median until every leaf holds at most `leafMax`; each parent holds an even sample of its
 * leaves for far views (replace refinement), with the kept splats enlarged to cover the gaps.
 * Leaves keep every splat. Each tile's positions are relative to its own centre, so SPZ's 24-bit
 * positions keep their precision over a wide area.
 */

export const GS_EXTENSIONS = ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"];

export interface SplatTilesOptions {
  /** Most splats drawn as one tile (default 1 000 000). */
  singleMax?: number;
  /** Most splats in a leaf when the cloud is split (default 300 000). */
  leafMax?: number;
  /** The uploaded SPZ v2 file, used unchanged when the model is one tile. */
  originalSpzV2?: Uint8Array;
}

export interface SplatTiles {
  files: { path: string; data: Uint8Array }[];
  tiles: number;
  levels: number;
  /** Bounds without floaters, in the glTF frame (y up): what the model is framed and sized by. */
  focus: SplatBounds;
  /** Bounds of every splat centre. */
  extent: SplatBounds;
}

const pad4 = (n: number) => (n + 3) & ~3;

/** One GLB holding the cloud as SPZ v2 (`spz`, or encoded from the cloud). */
export function splatGlb(c: SplatCloud, spz = encodeSpzV2(c)): Uint8Array {
  const b = bounds(c.pos, c.count);
  const attributes: Record<string, number> = { POSITION: 0, COLOR_0: 1, "KHR_gaussian_splatting:SCALE": 2, "KHR_gaussian_splatting:ROTATION": 3 };
  const accessors: Record<string, unknown>[] = [
    { componentType: 5126, count: c.count, type: "VEC3", min: b.min, max: b.max },
    { componentType: 5121, normalized: true, count: c.count, type: "VEC4" },
    { componentType: 5126, count: c.count, type: "VEC3" },
    { componentType: 5126, count: c.count, type: "VEC4" },
  ];
  for (let l = 1; l <= c.shDegree; l++)
    for (let n = 0; n < 2 * l + 1; n++) {
      attributes[`KHR_gaussian_splatting:SH_DEGREE_${l}_COEF_${n}`] = accessors.length;
      accessors.push({ componentType: 5126, count: c.count, type: "VEC3" });
    }
  const doc = {
    asset: { version: "2.0", generator: "HOLO splat packager" },
    extensionsUsed: GS_EXTENSIONS,
    extensionsRequired: GS_EXTENSIONS,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            mode: 0,
            attributes,
            extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display", extensions: { KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 } } } },
          },
        ],
      },
    ],
    accessors,
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: spz.byteLength }],
    buffers: [{ byteLength: pad4(spz.byteLength) }],
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonLen = pad4(json.byteLength);
  const binLen = pad4(spz.byteLength);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.byteLength, 20 + jsonLen);
  v.setUint32(20 + jsonLen, binLen, true);
  v.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(spz, 28 + jsonLen);
  return out;
}

/** A glTF-frame (y up) box as a 3D Tiles box (z up) around `centre`, with a margin. */
function tileBox(b: SplatBounds, centre: [number, number, number], margin: number): number[] {
  const c = [(b.min[0] + b.max[0]) / 2 - centre[0], (b.min[1] + b.max[1]) / 2 - centre[1], (b.min[2] + b.max[2]) / 2 - centre[2]];
  const h = [0, 1, 2].map((a) => (b.max[a]! - b.min[a]!) / 2 + margin);
  // glTF (x, y, z) is drawn at 3D Tiles (x, −z, y).
  return [c[0]!, -c[2]!, c[1]!, h[0]!, 0, 0, 0, h[2]!, 0, 0, 0, h[1]!];
}

const diag = (b: SplatBounds) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

/** A splat's largest standard deviation, from its packed log scale. */
function maxSigma(c: SplatCloud): number {
  let m = 0;
  for (let i = 0; i < c.scales.length; i++) m = Math.max(m, c.scales[i]!);
  return Math.exp(m / 16 - 10);
}

interface Node {
  idx: Uint32Array;
  b: SplatBounds;
  children: Node[];
  depth: number;
}

function split(c: SplatCloud, idx: Uint32Array, leafMax: number, depth: number): Node {
  const sub = new Float32Array(idx.length * 3);
  for (let k = 0; k < idx.length; k++) for (let a = 0; a < 3; a++) sub[k * 3 + a] = c.pos[idx[k]! * 3 + a]!;
  const b = bounds(sub, idx.length);
  if (idx.length <= leafMax || depth > 24) return { idx, b, children: [], depth };
  const ext = [0, 1, 2].map((a) => b.max[a]! - b.min[a]!);
  const axis = ext.indexOf(Math.max(...ext));
  const order = Array.from(idx).sort((i, j) => c.pos[i * 3 + axis]! - c.pos[j * 3 + axis]! || i - j);
  const mid = order.length >> 1;
  return { idx, b, depth, children: [split(c, Uint32Array.from(order.slice(0, mid)), leafMax, depth + 1), split(c, Uint32Array.from(order.slice(mid)), leafMax, depth + 1)] };
}

/** An even, repeatable sample of `count` of the node's splats. */
function sample(idx: Uint32Array, count: number): Uint32Array {
  if (count >= idx.length) return idx;
  const sorted = Uint32Array.from(idx).sort();
  const out = new Uint32Array(count);
  const step = sorted.length / count;
  for (let k = 0; k < count; k++) out[k] = sorted[Math.floor(k * step)]!;
  return out;
}

/** A tile's content, positions relative to `centre` with fraction bits that fit its span. */
function tileCloud(c: SplatCloud, idx: Uint32Array, centre: [number, number, number], enlarge = 0): SplatCloud {
  const t = subset(c, idx, centre);
  let maxAbs = 0;
  for (let i = 0; i < t.pos.length; i++) maxAbs = Math.max(maxAbs, Math.abs(t.pos[i]!));
  t.fractionalBits = Math.min(c.fractionalBits, fractionBitsFor(maxAbs));
  if (enlarge > 0) {
    // Fewer splats cover the same surface: each grows by the area it now stands for (log scale, ×16 packed).
    const add = Math.round(enlarge * 16);
    for (let i = 0; i < t.scales.length; i++) t.scales[i] = Math.min(255, t.scales[i]! + add);
  }
  return t;
}

const roundCentre = (b: SplatBounds): [number, number, number] => [0, 1, 2].map((a) => Math.round((b.min[a]! + b.max[a]!) / 2)) as [number, number, number];

/** The cloud as a 3D Tiles tileset: tileset.json and one GLB per tile. */
export function splatTiles(c: SplatCloud, opts: SplatTilesOptions = {}): SplatTiles {
  const singleMax = opts.singleMax ?? 1_000_000;
  const leafMax = opts.leafMax ?? 300_000;
  const extent = bounds(c.pos, c.count);
  const focus = robustBounds(c.pos, c.count);
  const margin = Math.min(3 * maxSigma(c), diag(extent) * 0.05 + 0.01);
  const files: { path: string; data: Uint8Array }[] = [];
  const extras = {
    holo: {
      kind: "gaussian-splats",
      splats: c.count,
      shDegree: c.shDegree,
      // Framing ignores floaters: the view opens on these bounds (glTF frame, y up).
      focus,
    },
  };
  const header = {
    asset: { version: "1.1", generator: "HOLO splat packager" },
    extensionsUsed: ["3DTILES_content_gltf"],
    extensionsRequired: ["3DTILES_content_gltf"],
    extensions: { "3DTILES_content_gltf": { extensionsUsed: GS_EXTENSIONS, extensionsRequired: GS_EXTENSIONS } },
    extras,
  };

  if (c.count <= singleMax) {
    // One tile at the model origin; an uploaded SPZ v2 goes in byte for byte.
    let maxAbs = 0;
    for (let i = 0; i < c.pos.length; i++) maxAbs = Math.max(maxAbs, Math.abs(c.pos[i]!));
    const fits = fractionBitsFor(maxAbs) >= c.fractionalBits;
    const one = fits ? c : { ...c, fractionalBits: fractionBitsFor(maxAbs) };
    files.push({ path: "splats.glb", data: splatGlb(one, opts.originalSpzV2 && fits ? opts.originalSpzV2 : undefined) });
    const tileset = { ...header, geometricError: Math.max(diag(extent), 1), root: { boundingVolume: { box: tileBox(extent, [0, 0, 0], margin) }, geometricError: 0, refine: "ADD", content: { uri: "splats.glb" } } };
    files.push({ path: "tileset.json", data: new TextEncoder().encode(JSON.stringify(tileset)) });
    return { files, tiles: 1, levels: 1, focus, extent };
  }

  const all = new Uint32Array(c.count);
  for (let i = 0; i < c.count; i++) all[i] = i;
  const root = split(c, all, leafMax, 0);
  let tiles = 0;
  let levels = 0;
  const emit = (n: Node, parentCentre: [number, number, number]): Record<string, unknown> => {
    const id = tiles++;
    levels = Math.max(levels, n.depth + 1);
    const centre = roundCentre(n.b);
    const uri = `tiles/${id}.glb`;
    let enlarge = 0;
    let idx = n.idx;
    if (n.children.length) {
      const keep = Math.min(leafMax, Math.max(1, Math.floor(n.idx.length / 4)));
      idx = sample(n.idx, keep);
      // A sample of f of the splats: each covers 1/f of the area, so its sides grow by 1/√f.
      enlarge = 0.5 * Math.log(n.idx.length / keep);
    }
    files.push({ path: uri, data: splatGlb(tileCloud(c, idx, centre, enlarge)) });
    // The tile's frame is its centre, relative to its parent's, in 3D Tiles axes (z up).
    const d = [centre[0] - parentCentre[0], centre[1] - parentCentre[1], centre[2] - parentCentre[2]];
    const tile: Record<string, unknown> = {
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], -d[2]!, d[1], 1],
      boundingVolume: { box: tileBox(n.b, centre, margin) },
      // A parent is drawn until its splats would be about this far apart on screen.
      geometricError: n.children.length ? diag(n.b) / Math.sqrt(idx.length) * 4 : 0,
      refine: "REPLACE",
      content: { uri },
    };
    if (n.children.length) tile.children = n.children.map((ch) => emit(ch, centre));
    return tile;
  };
  const rootTile = emit(root, [0, 0, 0]);
  const tileset = { ...header, geometricError: diag(extent), root: rootTile };
  files.push({ path: "tileset.json", data: new TextEncoder().encode(JSON.stringify(tileset)) });
  return { files, tiles, levels, focus, extent };
}
