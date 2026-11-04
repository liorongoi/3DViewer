import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeIO, type Material, type Node, type Primitive, type Texture, type TextureInfo } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";

/**
 * Tiling a large model into 3D Tiles 1.1 (WP 3.4 step 7, AD-04).
 *
 * The model is split in space (median cuts along the longest side) until each cell holds at
 * most `leafTriangles`. Leaves keep every original triangle; each parent merges its children
 * and simplifies them with meshoptimizer, so a far view draws a few light tiles and a close
 * view the full detail. A parent's geometric error is the simplifier's own error in metres.
 *
 * Textures are written once, under textures/, and every tile points at them, so they are not
 * copied into each tile and Cesium loads each one once.
 *
 * Node transforms, the up axis and the scale from the Place step are baked into the tiles,
 * which stay in the model's local frame (the viewer places the tileset like a model).
 */
export const TILE_IF = { triangles: 1_500_000, bytes: 300 * 1024 * 1024 };

export interface TileOptions {
  upAxis?: "y" | "z";
  scale?: number;
  /** Most triangles in one tile. */
  leafTriangles?: number;
}

export interface TileResult {
  tiles: number;
  levels: number;
  triangles: number;
  /** Primitives that are not triangles (lines, points) and were left out. */
  skipped: number;
  /** Paths of everything written, relative to the output folder. */
  files: string[];
}

/** Triangles that share one material and one set of attributes. */
interface Geo {
  key: string;
  mat: number;
  pos: Float32Array;
  nor: Float32Array | null;
  tan: Float32Array | null;
  uv: Float32Array | null;
  col: Float32Array | null;
  idx: Uint32Array;
}

/** A cell: for each geometry, the triangles in it. */
interface Cell {
  parts: { g: number; tris: Uint32Array }[];
  count: number;
}

interface Built {
  json: Record<string, unknown>;
  geos: Geo[];
  min: number[];
  max: number[];
  error: number;
  depth: number;
}

type Vec3 = [number, number, number];

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Reads every triangle primitive in world space, with the Place step's axis and scale applied. */
async function flatten(file: string, opts: TileOptions) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc = await io.read(file);
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const s = opts.scale ?? 1;
  const zUp = opts.upAxis === "z";
  const chunks = new Map<string, { mat: number; parts: { pos: Float32Array; nor: Float32Array | null; tan: Float32Array | null; uv: Float32Array | null; col: Float32Array | null; idx: Uint32Array }[] }>();
  let skipped = 0;
  const el: number[] = [];

  const visit = (node: Node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      // Normals use the inverse transpose of the upper 3×3.
      const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
      const det = a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[3]! * (a[1]! * a[8]! - a[2]! * a[7]!) + a[6]! * (a[1]! * a[5]! - a[2]! * a[4]!);
      const inv = [
        (a[4]! * a[8]! - a[5]! * a[7]!) / det, (a[2]! * a[7]! - a[1]! * a[8]!) / det, (a[1]! * a[5]! - a[2]! * a[4]!) / det,
        (a[5]! * a[6]! - a[3]! * a[8]!) / det, (a[0]! * a[8]! - a[2]! * a[6]!) / det, (a[2]! * a[3]! - a[0]! * a[5]!) / det,
        (a[3]! * a[7]! - a[4]! * a[6]!) / det, (a[1]! * a[6]! - a[0]! * a[7]!) / det, (a[0]! * a[4]! - a[1]! * a[3]!) / det,
      ];
      // Tile content is Y-up glTF with east +X and north −Z, as the viewer reads a single model
      // (packages/core/src/geo/place.ts), so a Y-up file passes through and a Z-up file
      // (east +X, north +Y) is stood up.
      const out = (x: number, y: number, z: number): Vec3 => (zUp ? [x, z, -y] : [x, y, z]);
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) {
          skipped++;
          continue;
        }
        const P = prim.getAttribute("POSITION");
        if (!P) continue;
        const n = P.getCount();
        const N = prim.getAttribute("NORMAL");
        const T = prim.getAttribute("TEXCOORD_0");
        const G = N ? prim.getAttribute("TANGENT") : null;
        const C = prim.getAttribute("COLOR_0");
        const pos = new Float32Array(n * 3);
        const nor = N ? new Float32Array(n * 3) : null;
        const uv = T ? new Float32Array(n * 2) : null;
        const tan = G ? new Float32Array(n * 4) : null;
        const col = C ? new Float32Array(n * 4) : null;
        for (let i = 0; i < n; i++) {
          P.getElement(i, el);
          const x = el[0]!, y = el[1]!, z = el[2]!;
          const w = out((m[0] * x + m[4] * y + m[8] * z + m[12]) * s, (m[1] * x + m[5] * y + m[9] * z + m[13]) * s, (m[2] * x + m[6] * y + m[10] * z + m[14]) * s);
          pos.set(w, i * 3);
          if (N && nor) {
            N.getElement(i, el);
            // (inverse)ᵀ · n: row-major inverse, so the transpose reads its columns.
            const nx = inv[0]! * el[0]! + inv[3]! * el[1]! + inv[6]! * el[2]!;
            const ny = inv[1]! * el[0]! + inv[4]! * el[1]! + inv[7]! * el[2]!;
            const nz = inv[2]! * el[0]! + inv[5]! * el[1]! + inv[8]! * el[2]!;
            const l = Math.hypot(nx, ny, nz) || 1;
            nor.set(out(nx / l, ny / l, nz / l), i * 3);
          }
          if (G && tan) {
            G.getElement(i, el);
            // Tangents follow the surface: the upper 3×3 itself; w flips with a mirror.
            const tx = a[0]! * el[0]! + a[3]! * el[1]! + a[6]! * el[2]!;
            const ty = a[1]! * el[0]! + a[4]! * el[1]! + a[7]! * el[2]!;
            const tz = a[2]! * el[0]! + a[5]! * el[1]! + a[8]! * el[2]!;
            const l = Math.hypot(tx, ty, tz) || 1;
            tan.set([...out(tx / l, ty / l, tz / l), (el[3] ?? 1) * (det < 0 ? -1 : 1)], i * 4);
          }
          if (T && uv) {
            T.getElement(i, el);
            uv[i * 2] = el[0]!;
            uv[i * 2 + 1] = el[1]!;
          }
          if (C && col) {
            C.getElement(i, el);
            col.set([el[0]!, el[1]!, el[2]!, el.length > 3 && C.getType() === "VEC4" ? el[3]! : 1], i * 4);
          }
        }
        const I = prim.getIndices();
        let idx = I ? Uint32Array.from(I.getArray()!) : Uint32Array.from({ length: n }, (_, i) => i);
        idx = idx.subarray(0, idx.length - (idx.length % 3));
        // A mirroring transform turns the triangles inside out; swap two corners back.
        if (det < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
        const mat = prim.getMaterial() ? materials.indexOf(prim.getMaterial()!) : -1;
        const key = `${mat}|${nor ? "n" : ""}${tan ? "g" : ""}${uv ? "t" : ""}${col ? "c" : ""}`;
        const c = chunks.get(key) ?? { mat, parts: [] };
        c.parts.push({ pos, nor, tan, uv, col, idx });
        chunks.set(key, c);
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  for (const node of scene?.listChildren() ?? []) visit(node);

  const geos: Geo[] = [];
  for (const [key, c] of chunks) {
    const nv = c.parts.reduce((t, p) => t + p.pos.length / 3, 0);
    const ni = c.parts.reduce((t, p) => t + p.idx.length, 0);
    const g: Geo = {
      key,
      mat: c.mat,
      pos: new Float32Array(nv * 3),
      nor: c.parts[0]!.nor ? new Float32Array(nv * 3) : null,
      tan: c.parts[0]!.tan ? new Float32Array(nv * 4) : null,
      uv: c.parts[0]!.uv ? new Float32Array(nv * 2) : null,
      col: c.parts[0]!.col ? new Float32Array(nv * 4) : null,
      idx: new Uint32Array(ni),
    };
    let vo = 0, io2 = 0;
    for (const p of c.parts) {
      g.pos.set(p.pos, vo * 3);
      if (g.nor) g.nor.set(p.nor!, vo * 3);
      if (g.tan) g.tan.set(p.tan!, vo * 4);
      if (g.uv) g.uv.set(p.uv!, vo * 2);
      if (g.col) g.col.set(p.col!, vo * 4);
      for (let i = 0; i < p.idx.length; i++) g.idx[io2 + i] = p.idx[i]! + vo;
      vo += p.pos.length / 3;
      io2 += p.idx.length;
    }
    geos.push(g);
  }
  return { doc, materials, geos, skipped };
}

/** Keeps only the vertices the indices use. */
function compact(g: Geo, idx: Uint32Array): Geo {
  const map = new Int32Array(g.pos.length / 3).fill(-1);
  let n = 0;
  for (const v of idx) if (map[v] === -1) map[v] = n++;
  const out: Geo = { key: g.key, mat: g.mat, pos: new Float32Array(n * 3), nor: g.nor && new Float32Array(n * 3), tan: g.tan && new Float32Array(n * 4), uv: g.uv && new Float32Array(n * 2), col: g.col && new Float32Array(n * 4), idx: new Uint32Array(idx.length) };
  for (let v = 0; v < map.length; v++) {
    const k = map[v]!;
    if (k < 0) continue;
    out.pos.set(g.pos.subarray(v * 3, v * 3 + 3), k * 3);
    if (g.nor) out.nor!.set(g.nor.subarray(v * 3, v * 3 + 3), k * 3);
    if (g.tan) out.tan!.set(g.tan.subarray(v * 4, v * 4 + 4), k * 4);
    if (g.uv) out.uv!.set(g.uv.subarray(v * 2, v * 2 + 2), k * 2);
    if (g.col) out.col!.set(g.col.subarray(v * 4, v * 4 + 4), k * 4);
  }
  for (let i = 0; i < idx.length; i++) out.idx[i] = map[idx[i]!]!;
  return out;
}

/** The cell's triangles as their own geometries. */
function extract(geos: Geo[], cell: Cell): Geo[] {
  return cell.parts.map(({ g, tris }) => {
    const src = geos[g]!;
    const idx = new Uint32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) idx.set(src.idx.subarray(tris[i]! * 3, tris[i]! * 3 + 3), i * 3);
    return compact(src, idx);
  });
}

/** Splits a cell in two at the median triangle centre along its longest side. */
function split(geos: Geo[], cell: Cell): [Cell, Cell] {
  const cent = (g: Geo, t: number, k: number) => (g.pos[g.idx[t * 3]! * 3 + k]! + g.pos[g.idx[t * 3 + 1]! * 3 + k]! + g.pos[g.idx[t * 3 + 2]! * 3 + k]!) / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { g, tris } of cell.parts) for (const t of tris) for (let k = 0; k < 3; k++) {
    const c = cent(geos[g]!, t, k);
    if (c < lo[k]!) lo[k] = c;
    if (c > hi[k]!) hi[k] = c;
  }
  const axis = [0, 1, 2].reduce((best, k) => (hi[k]! - lo[k]! > hi[best]! - lo[best]! ? k : best), 0);
  const vals = new Float64Array(cell.count);
  let n = 0;
  for (const { g, tris } of cell.parts) for (const t of tris) vals[n++] = cent(geos[g]!, t, axis);
  const sorted = vals.slice().sort();
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const allSame = sorted[0] === sorted[sorted.length - 1];
  const halves: [Cell, Cell] = [{ parts: [], count: 0 }, { parts: [], count: 0 }];
  n = 0;
  let seen = 0;
  for (const { g, tris } of cell.parts) {
    const a: number[] = [], b: number[] = [];
    for (const t of tris) {
      // Everything in one plane: split by order instead.
      const left = allSame ? seen++ < cell.count / 2 : vals[n]! < median;
      n++;
      (left ? a : b).push(t);
    }
    if (a.length) halves[0].parts.push({ g, tris: Uint32Array.from(a) }), (halves[0].count += a.length);
    if (b.length) halves[1].parts.push({ g, tris: Uint32Array.from(b) }), (halves[1].count += b.length);
  }
  // All centres equal to the median on one side: fall back to an even split by order.
  if (!halves[0].count || !halves[1].count) {
    const all: { g: number; t: number }[] = [];
    for (const { g, tris } of cell.parts) for (const t of tris) all.push({ g, t });
    const mk = (xs: { g: number; t: number }[]): Cell => {
      const by = new Map<number, number[]>();
      for (const x of xs) (by.get(x.g) ?? by.set(x.g, []).get(x.g)!).push(x.t);
      return { parts: [...by].map(([g, ts]) => ({ g, tris: Uint32Array.from(ts) })), count: xs.length };
    };
    return [mk(all.slice(0, all.length >> 1)), mk(all.slice(all.length >> 1))];
  }
  return halves;
}

/** Joins geometries that share a material and layout. */
function merge(list: Geo[]): Geo[] {
  const by = new Map<string, Geo[]>();
  for (const g of list) (by.get(g.key) ?? by.set(g.key, []).get(g.key)!).push(g);
  return [...by.values()].map((gs) => {
    if (gs.length === 1) return gs[0]!;
    const nv = gs.reduce((t, g) => t + g.pos.length / 3, 0);
    const out: Geo = { key: gs[0]!.key, mat: gs[0]!.mat, pos: new Float32Array(nv * 3), nor: gs[0]!.nor && new Float32Array(nv * 3), tan: gs[0]!.tan && new Float32Array(nv * 4), uv: gs[0]!.uv && new Float32Array(nv * 2), col: gs[0]!.col && new Float32Array(nv * 4), idx: new Uint32Array(gs.reduce((t, g) => t + g.idx.length, 0)) };
    let vo = 0, io = 0;
    for (const g of gs) {
      out.pos.set(g.pos, vo * 3);
      if (out.nor) out.nor.set(g.nor!, vo * 3);
      if (out.tan) out.tan.set(g.tan!, vo * 4);
      if (out.uv) out.uv.set(g.uv!, vo * 2);
      if (out.col) out.col.set(g.col!, vo * 4);
      for (let i = 0; i < g.idx.length; i++) out.idx[io + i] = g.idx[i]! + vo;
      vo += g.pos.length / 3;
      io += g.idx.length;
    }
    return out;
  });
}

/** Simplifies to about `target` triangles in all; returns the error in metres. */
function simplify(geos: Geo[], target: number): { geos: Geo[]; error: number } {
  const total = geos.reduce((t, g) => t + g.idx.length / 3, 0);
  let error = 0;
  const out: Geo[] = [];
  for (const g of geos) {
    const want = Math.max(3, Math.floor(((g.idx.length / 3) * target) / total) * 3);
    let [idx, err] = MeshoptSimplifier.simplify(g.idx, g.pos, 3, want, 1);
    // Many small separate parts cannot collapse along edges; cluster them instead.
    if (idx.length > want * 1.5) [idx, err] = MeshoptSimplifier.simplifySloppy(g.idx, g.pos, 3, null, want, 1);
    error = Math.max(error, err * MeshoptSimplifier.getScale(g.pos, 3));
    if (idx.length) out.push(compact(g, idx));
  }
  return { geos: out, error };
}

function bounds(geos: Geo[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of geos) for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = g.pos[i + k]!;
    if (v < min[k]!) min[k] = v;
    if (v > max[k]!) max[k] = v;
  }
  return { min, max };
}

/** glTF is y-up; the tileset frame is z-up (x east, y north, z up), as 3D Tiles turns glTF content. */
function box(min: number[], max: number[]): number[] {
  const c = [(min[0]! + max[0]!) / 2, -(min[2]! + max[2]!) / 2, (min[1]! + max[1]!) / 2];
  const h = [(max[0]! - min[0]!) / 2, (max[2]! - min[2]!) / 2, (max[1]! - min[1]!) / 2].map((x) => Math.max(x, 0.001));
  return [c[0]!, c[1]!, c[2]!, h[0]!, 0, 0, 0, h[1]!, 0, 0, 0, h[2]!];
}

/** Materials and textures in glTF JSON, with each texture written once as its own file. */
async function exportMaterials(materials: Material[], outDir: string, files: string[]) {
  const images = new Map<Texture, { uri: string; mime: string }>();
  const ext = (mime: string) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/ktx2": "ktx2" })[mime] ?? "bin";
  const used = new Set<string>();
  const image = async (t: Texture) => {
    if (!images.has(t)) {
      const name = `textures/${images.size}.${ext(t.getMimeType())}`;
      await writeFile(path.join(outDir, name), t.getImage()!);
      files.push(name);
      images.set(t, { uri: `../${name}`, mime: t.getMimeType() });
    }
    return images.get(t)!;
  };
  type TexRef = { image: { uri: string; mime: string }; sampler: Record<string, number> };
  const out: { json: Record<string, unknown>; textures: TexRef[] }[] = [];
  for (const m of materials) {
    const textures: TexRef[] = [];
    const ref = async (t: Texture | null, info: TextureInfo | null, extra: Record<string, number> = {}) => {
      if (!t || !t.getImage() || !info || info.getTexCoord() !== 0) return undefined;
      const sampler: Record<string, number> = { wrapS: info.getWrapS(), wrapT: info.getWrapT() };
      if (info.getMagFilter() != null) sampler.magFilter = info.getMagFilter()!;
      if (info.getMinFilter() != null) sampler.minFilter = info.getMinFilter()!;
      textures.push({ image: await image(t), sampler });
      return { index: textures.length - 1, ...extra };
    };
    const json: Record<string, unknown> = {
      name: m.getName() || undefined,
      pbrMetallicRoughness: {
        baseColorFactor: m.getBaseColorFactor(),
        metallicFactor: m.getMetallicFactor(),
        roughnessFactor: m.getRoughnessFactor(),
        baseColorTexture: await ref(m.getBaseColorTexture(), m.getBaseColorTextureInfo()),
        metallicRoughnessTexture: await ref(m.getMetallicRoughnessTexture(), m.getMetallicRoughnessTextureInfo()),
      },
      normalTexture: await ref(m.getNormalTexture(), m.getNormalTextureInfo(), { scale: m.getNormalScale() }),
      occlusionTexture: await ref(m.getOcclusionTexture(), m.getOcclusionTextureInfo(), { strength: m.getOcclusionStrength() }),
      emissiveTexture: await ref(m.getEmissiveTexture(), m.getEmissiveTextureInfo()),
      emissiveFactor: m.getEmissiveFactor(),
      alphaMode: m.getAlphaMode(),
      alphaCutoff: m.getAlphaMode() === "MASK" ? m.getAlphaCutoff() : undefined,
      doubleSided: m.getDoubleSided() || undefined,
    };
    if (m.getExtension("KHR_materials_unlit")) (json.extensions = { KHR_materials_unlit: {} }), used.add("KHR_materials_unlit");
    out.push({ json, textures });
  }
  return out;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** One tile's GLB: the geometries, their materials, textures pointing at the shared files. */
function writeGlb(geos: Geo[], mats: Awaited<ReturnType<typeof exportMaterials>>): Uint8Array {
  const views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const add = (data: Float32Array | Uint32Array | Uint16Array, accessor: Record<string, unknown>, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes, new Uint8Array(pad4(bytes.length)));
    offset += bytes.length + pad4(bytes.length);
    accessors.push({ bufferView: views.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const gltf: Record<string, unknown> & { materials: unknown[]; textures: unknown[]; images: unknown[]; samplers: unknown[] } = {
    asset: { version: "2.0", generator: "VIEWER tiler" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [],
    textures: [],
    images: [],
    samplers: [],
  };
  const extUsed = new Set<string>();
  const localMat = new Map<number, number>();
  const imageIdx = new Map<string, number>();
  const material = (mat: number) => {
    if (mat < 0) return undefined;
    if (!localMat.has(mat)) {
      const m = mats[mat]!;
      const texBase = gltf.textures.length;
      for (const t of m.textures) {
        if (!imageIdx.has(t.image.uri)) imageIdx.set(t.image.uri, gltf.images.push({ uri: t.image.uri, mimeType: t.image.mime }) - 1);
        gltf.samplers.push(t.sampler);
        const source = imageIdx.get(t.image.uri)!;
        const extName = t.image.mime === "image/webp" ? "EXT_texture_webp" : t.image.mime === "image/ktx2" ? "KHR_texture_basisu" : null;
        if (extName) extUsed.add(extName);
        gltf.textures.push(extName ? { sampler: gltf.samplers.length - 1, extensions: { [extName]: { source } } } : { sampler: gltf.samplers.length - 1, source });
      }
      // Shift this material's texture indices to where they landed in this tile.
      const json = JSON.parse(JSON.stringify(m.json), (k, v) => (k === "index" && typeof v === "number" ? v + texBase : v));
      if (json.extensions?.KHR_materials_unlit) extUsed.add("KHR_materials_unlit");
      localMat.set(mat, gltf.materials.push(json) - 1);
    }
    return localMat.get(mat);
  };
  const primitives = geos.map((g) => {
    const nv = g.pos.length / 3;
    const { min, max } = bounds([g]);
    const attributes: Record<string, number> = { POSITION: add(g.pos, { componentType: 5126, count: nv, type: "VEC3", min, max }, 34962) };
    if (g.nor) attributes.NORMAL = add(g.nor, { componentType: 5126, count: nv, type: "VEC3" }, 34962);
    if (g.tan) attributes.TANGENT = add(g.tan, { componentType: 5126, count: nv, type: "VEC4" }, 34962);
    if (g.uv) attributes.TEXCOORD_0 = add(g.uv, { componentType: 5126, count: nv, type: "VEC2" }, 34962);
    if (g.col) attributes.COLOR_0 = add(g.col, { componentType: 5126, count: nv, type: "VEC4" }, 34962);
    const small = nv < 65536;
    const indices = add(small ? Uint16Array.from(g.idx) : g.idx, { componentType: small ? 5123 : 5125, count: g.idx.length, type: "SCALAR" }, 34963);
    return { attributes, indices, material: material(g.mat), mode: 4 };
  });
  gltf.meshes = [{ primitives }];
  gltf.buffers = [{ byteLength: offset }];
  gltf.bufferViews = views;
  gltf.accessors = accessors;
  for (const k of ["materials", "textures", "images", "samplers"] as const) if (!gltf[k].length) delete (gltf as Record<string, unknown>)[k];
  if (extUsed.size) {
    gltf.extensionsUsed = [...extUsed];
    const required = [...extUsed].filter((e) => e !== "KHR_materials_unlit");
    if (required.length) gltf.extensionsRequired = required;
  }
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = json.length + pad4(json.length);
  const total = 12 + 8 + jsonLen + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLen);
  dv.setUint32(20 + jsonLen, offset, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true);
  let o = 28 + jsonLen;
  for (const c of chunks) out.set(c, o), (o += c.length);
  return out;
}

/** Tiles `file` (GLB or glTF) into `outDir`/tileset.json, tiles/ and textures/. */
export async function tileModel(file: string, outDir: string, opts: TileOptions = {}, onProgress?: (done: number, total: number) => void): Promise<TileResult> {
  await MeshoptSimplifier.ready;
  const leaf = opts.leafTriangles ?? 100_000;
  const { materials, geos, skipped } = await flatten(file, opts);
  const total = geos.reduce((t, g) => t + g.idx.length / 3, 0);
  if (!total) throw new Error("The model has no triangles to tile.");
  await mkdir(path.join(outDir, "tiles"), { recursive: true });
  await mkdir(path.join(outDir, "textures"), { recursive: true });
  const files: string[] = [];
  const mats = await exportMaterials(materials, outDir, files);
  let tiles = 0;
  let leafDone = 0;

  const writeTile = async (content: Geo[]) => {
    const name = `tiles/${tiles++}.glb`;
    await writeFile(path.join(outDir, name), writeGlb(content, mats));
    files.push(name);
    return name;
  };

  const build = async (cell: Cell, depth: number): Promise<Built> => {
    if (cell.count <= leaf) {
      const content = extract(geos, cell);
      const { min, max } = bounds(content);
      const uri = await writeTile(content);
      leafDone += cell.count;
      onProgress?.(leafDone, total);
      await yieldNow();
      return { json: { boundingVolume: { box: box(min, max) }, geometricError: 0, content: { uri } }, geos: content, min, max, error: 0, depth };
    }
    // Up to four children per tile: each parent then simplifies to about a quarter.
    const cells = split(geos, cell).flatMap((c) => (c.count > leaf ? split(geos, c) : [c]));
    const children: Built[] = [];
    for (const c of cells) children.push(await build(c, depth + 1));
    const merged = merge(children.flatMap((c) => c.geos));
    const { geos: content, error } = simplify(merged, leaf);
    const min = [0, 1, 2].map((k) => Math.min(...children.map((c) => c.min[k]!)));
    const max = [0, 1, 2].map((k) => Math.max(...children.map((c) => c.max[k]!)));
    const diag = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
    const geometricError = Math.max(error, ...children.map((c) => c.error * 1.5), diag / 1000);
    // Simplified away entirely (tiny parts far off): a tile with no content of its own.
    const uri = content.length ? await writeTile(content) : null;
    await yieldNow();
    return {
      json: { boundingVolume: { box: box(min, max) }, geometricError, refine: "REPLACE", ...(uri ? { content: { uri } } : {}), children: children.map((c) => c.json) },
      geos: content,
      min,
      max,
      error: geometricError,
      depth: Math.max(...children.map((c) => c.depth)),
    };
  };

  const all: Cell = { parts: geos.map((g, i) => ({ g: i, tris: Uint32Array.from({ length: g.idx.length / 3 }, (_, t) => t) })), count: total };
  const root = await build(all, 1);
  const diag = Math.hypot(root.max[0]! - root.min[0]!, root.max[1]! - root.min[1]!, root.max[2]! - root.min[2]!);
  const tileset = {
    asset: { version: "1.1", generator: "VIEWER tiler" },
    geometricError: Math.max(root.error * 2, diag),
    root: { ...root.json, refine: "REPLACE" },
  };
  await writeFile(path.join(outDir, "tileset.json"), JSON.stringify(tileset));
  files.push("tileset.json");
  return { tiles, levels: root.depth, triangles: total, skipped, files };
}
