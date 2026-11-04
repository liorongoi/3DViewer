import { baseName, ext, resolvePath, type FileSet, type LocalFile } from "./files";
import type { CheckItem, LoaderPlugin } from "./types";
import { ecefToGeodetic } from "../geo/wgs84";

/** glTF extensions CesiumJS 1.146 reads. A required extension outside this list blocks the upload. */
export const SUPPORTED_GLTF_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
  "KHR_texture_basisu",
  "KHR_texture_transform",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_materials_specular",
  "KHR_materials_clearcoat",
  "KHR_materials_anisotropy",
  "KHR_materials_ior",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_sheen",
  "KHR_lights_punctual",
  "KHR_techniques_webgl",
  "EXT_texture_webp",
  "EXT_mesh_gpu_instancing",
  "EXT_mesh_features",
  "EXT_structural_metadata",
  "EXT_instance_features",
  "CESIUM_RTC",
  "CESIUM_primitive_outline",
]);

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  buffers?: { uri?: string; byteLength?: number }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[];
  accessors?: { count?: number; min?: number[]; max?: number[] }[];
  images?: { uri?: string; bufferView?: number }[];
  textures?: unknown[];
  meshes?: { primitives?: { mode?: number; indices?: number; attributes?: Record<string, number> }[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  extensions?: { CESIUM_RTC?: { center?: number[] } };
}

export interface ParsedGlb {
  json: Gltf;
  bin: Uint8Array | null;
}

/** Reads a GLB container. Throws an Error with a reason a person can act on. */
export function parseGlb(data: Uint8Array): ParsedGlb {
  if (data.byteLength < 20) throw new Error("The file is too short to be a GLB.");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("The file does not start with the GLB signature, so it is not a GLB.");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported; only glTF 2.0 is.`);
  const length = dv.getUint32(8, true);
  if (length > data.byteLength) throw new Error(`The file is cut short: the header says ${length} bytes, the file has ${data.byteLength}.`);
  let off = 12;
  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  while (off + 8 <= length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > length) throw new Error("A chunk inside the GLB runs past the end of the file.");
    const chunk = data.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON && !json) json = parseJson(chunk, "GLB");
    else if (type === CHUNK_BIN && !bin) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("The GLB has no JSON chunk.");
  return { json, bin };
}

export function parseJson<T = Gltf>(data: Uint8Array, what: string): T {
  const text = new TextDecoder().decode(data).replace(/^﻿/, "").replace(/\0+$/, "");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`The ${what} JSON cannot be read: ${(e as Error).message}`);
  }
}

function nodeNames(g: Gltf): string[] {
  const nodes = g.nodes ?? [];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const names: string[] = [];
  const walk = (i: number, depth: number) => {
    const n = nodes[i];
    if (!n || names.length >= 300 || depth > 32) return;
    if (n.name) names.push(n.name);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return names;
}

type M4 = number[];
const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
function local(n: NonNullable<Gltf["nodes"]>[number]): M4 {
  if (n.matrix?.length === 16) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  // Column-major T · R · S, as glTF defines it.
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

/**
 * The model's extent in its own units along x, y, z (glTF is metres and y-up), from the
 * POSITION bounds of every mesh in the scene, placed by the node transforms. Null when
 * the file does not carry bounds.
 */
export function gltfSize(g: Gltf): [number, number, number] | null {
  const b = gltfBounds(g);
  return b ? [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]] : null;
}

type V3 = [number, number, number];

/** The scene's box in the file's own coordinates, node transforms applied; largest stored coordinate too. */
function gltfBounds(g: Gltf): { lo: V3; hi: V3; stored: number } | null {
  const nodes = g.nodes ?? [];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  let stored = 0;
  const walk = (i: number, parent: M4, depth: number) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    const m = mul(parent, local(n));
    for (const p of g.meshes?.[n.mesh ?? -1]?.primitives ?? []) {
      const a = g.accessors?.[p.attributes?.POSITION ?? -1];
      if (!a?.min || !a.max || a.min.length < 3) continue;
      stored = Math.max(stored, ...a.min.map(Math.abs), ...a.max.map(Math.abs));
      for (let c = 0; c < 8; c++) {
        const v = [0, 1, 2].map((k) => ((c >> k) & 1 ? a.max![k]! : a.min![k]!));
        for (let r = 0; r < 3; r++) {
          const w = m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]!;
          lo[r] = Math.min(lo[r]!, w);
          hi[r] = Math.max(hi[r]!, w);
        }
      }
    }
    for (const ch of n.children ?? []) walk(ch, m, depth + 1);
  };
  for (const r of roots) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  return Number.isFinite(lo[0]) ? { lo, hi, stored } : null;
}

/**
 * Earth position a glTF carries itself (plan 4.1): a CESIUM_RTC centre, or node transforms or
 * vertices in Earth-centred (ECEF) metres. Read the way Cesium draws it: the glTF's Y-up axes
 * turned to Z-up, (x, y, z) → (x, −z, y), then the RTC centre added.
 */
export function gltfGeoref(g: Gltf): { georef: { lat: number; lon: number; height: number } | null; items: CheckItem[] } {
  const b = gltfBounds(g);
  const rtc = g.extensions?.CESIUM_RTC?.center;
  const c = b ? ([0, 1, 2].map((k) => (b.lo[k]! + b.hi[k]!) / 2) as V3) : ([0, 0, 0] as V3);
  const e = { x: (rtc?.[0] ?? 0) + c[0], y: (rtc?.[1] ?? 0) - c[2], z: (rtc?.[2] ?? 0) + c[1] };
  if (Math.hypot(e.x, e.y, e.z) < 6.0e6) return { georef: null, items: [] };
  const geo = ecefToGeodetic(e);
  const items: CheckItem[] = [];
  // Vertices are 32-bit floats: far from the origin they snap to a coarse step.
  const step = b ? b.stored * 2 ** -24 : 0;
  if (step > 0.02)
    items.push({
      id: "georef",
      severity: "warning",
      title: `Vertex positions are only accurate to about ${step < 1 ? `${Math.round(step * 100)} cm` : `${step.toFixed(1)} m`}`,
      detail: "The file stores Earth-centred coordinates in each vertex. Export with CESIUM_RTC or a node offset so the vertices stay small.",
    });
  return { georef: { lat: geo.lat, lon: geo.lon, height: geo.height }, items };
}

function triangles(g: Gltf): number {
  let t = 0;
  for (const m of g.meshes ?? [])
    for (const p of m.primitives ?? []) {
      const mode = p.mode ?? 4;
      const count = p.indices !== undefined ? g.accessors?.[p.indices]?.count : g.accessors?.[p.attributes?.POSITION ?? -1]?.count;
      if (!count) continue;
      if (mode === 4) t += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) t += Math.max(0, count - 2);
    }
  return t;
}

/** Checks a glTF document and the files it references. Shared by the glTF and 3D Tiles plugins. */
export async function checkGltfDoc(g: Gltf, from: string, files: FileSet, binBytes: number | null): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const v = g.asset?.version ?? "";
  if (!v.startsWith("2.")) {
    items.push({ id: "format", severity: "error", title: v ? `glTF ${v} is not supported` : "The glTF has no asset version", detail: "Only glTF 2.0 can be opened. Re-export the model as glTF 2.0." });
    return items;
  }
  const unsupported = (g.extensionsRequired ?? []).filter((e) => !SUPPORTED_GLTF_EXTENSIONS.has(e));
  if (unsupported.length)
    items.push({ id: "extensions", severity: "error", title: "Uses extensions VIEWER cannot read", detail: unsupported.join(", ") });
  const missing: string[] = [];
  const short: string[] = [];
  const sizes: number[] = [];
  for (const [i, b] of (g.buffers ?? []).entries()) {
    if (b.uri === undefined) {
      sizes[i] = binBytes ?? 0;
      if (binBytes === null) missing.push(`buffer ${i} (the GLB has no binary chunk)`);
    } else if (b.uri.startsWith("data:")) {
      sizes[i] = Math.floor((b.uri.length - b.uri.indexOf(",") - 1) * 0.75);
    } else {
      const p = resolvePath(from, b.uri);
      const f = p ? files.get(p) : undefined;
      if (!f) missing.push(b.uri);
      sizes[i] = f?.size ?? 0;
      if (f && b.byteLength && f.size < b.byteLength) short.push(`${b.uri} has ${f.size} bytes, needs ${b.byteLength}`);
    }
  }
  for (const img of g.images ?? []) {
    if (img.uri && !img.uri.startsWith("data:")) {
      const p = resolvePath(from, img.uri);
      if (!p || !files.get(p)) missing.push(img.uri);
    }
  }
  if (missing.length)
    items.push({ id: "references", severity: "error", title: `${missing.length} referenced file${missing.length > 1 ? "s are" : " is"} missing`, detail: list(missing) });
  const badViews = (g.bufferViews ?? []).filter((bv) => {
    const size = sizes[bv.buffer ?? -1];
    return size !== undefined && size > 0 && (bv.byteOffset ?? 0) + (bv.byteLength ?? 0) > Math.max(size, g.buffers?.[bv.buffer ?? 0]?.byteLength ?? 0);
  }).length;
  if (short.length) items.push({ id: "structure", severity: "error", title: "A binary file is shorter than declared", detail: list(short) });
  else if (badViews) items.push({ id: "structure", severity: "error", title: "The geometry data is damaged", detail: `${badViews} buffer view${badViews > 1 ? "s point" : " points"} past the end of the data.` });
  return items;
}

const list = (xs: string[]) => (xs.length > 8 ? `${xs.slice(0, 8).join(", ")} and ${xs.length - 8} more` : xs.join(", "));

export const gltfLoader: LoaderPlugin = {
  id: "gltf",
  format: "glb",
  main(files) {
    const cands = files.files.filter((f) => ext(f.path) === "glb" || ext(f.path) === "gltf");
    return cands.sort((a, b) => a.path.split("/").length - b.path.split("/").length || b.size - a.size)[0] ?? null;
  },
  async check(main, files) {
    const data = await main.bytes();
    let g: Gltf;
    let bin: Uint8Array | null = null;
    try {
      if (ext(main.path) === "glb") ({ json: g, bin } = parseGlb(data));
      else g = parseJson(data, "glTF");
    } catch (e) {
      return { items: [{ id: "format", severity: "error", title: `${baseName(main.path)} cannot be read`, detail: (e as Error).message }], stats: { files: files.files.length, bytes: files.bytes }, nodes: [], georef: null };
    }
    const items = await checkGltfDoc(g, main.path, files, bin ? bin.byteLength : null);
    if (!items.some((i) => i.id === "format"))
      items.unshift({ id: "format", severity: "ok", title: `glTF 2.0 ${ext(main.path) === "glb" ? "binary (GLB)" : "with separate files"}` });
    const own = gltfGeoref(g);
    items.push(...own.items);
    return {
      items,
      stats: { files: files.files.length, bytes: files.bytes, triangles: triangles(g), textures: g.textures?.length ?? 0, size: gltfSize(g) ?? undefined },
      nodes: nodeNames(g),
      georef: own.georef,
    };
  },
  async prepare(main, files, url) {
    const data = await main.bytes();
    if (ext(main.path) === "glb") return url(data, "model/gltf-binary");
    const urlFor = async (f: LocalFile) => url(await f.bytes());
    return url(JSON.stringify(await rewriteGltfUris(parseJson(data, "glTF"), main.path, files, urlFor)), "model/gltf+json");
  },
};

/** Points every external buffer and image at an object URL, so a glTF with separate files opens from memory. */
export async function rewriteGltfUris(g: Gltf, from: string, files: FileSet, urlFor: (f: LocalFile) => Promise<string>): Promise<Gltf> {
  const swap = async (uri: string | undefined) => {
    if (!uri || uri.startsWith("data:")) return uri;
    const p = resolvePath(from, uri);
    const f = p ? files.get(p) : undefined;
    return f ? urlFor(f) : uri;
  };
  for (const b of g.buffers ?? []) b.uri = await swap(b.uri);
  for (const i of g.images ?? []) i.uri = await swap(i.uri);
  return g;
}
