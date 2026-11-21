import { fractionBitsFor, packAlpha, packColor, packRotation, packScale, packSh, shDim, SplatError, unpackColor, unpackRotation, unpackScale, unpackSh, type SplatCloud } from "./cloud";
import { MAX_SPLATS } from "./spz";

/**
 * The PLY that 3D Gaussian Splatting trainers write (INRIA 3DGS, gsplat, Nerfstudio Splatfacto,
 * Brush, OpenSplat, PGSR, CityGaussian…): one `vertex` element with x y z, f_dc_0..2,
 * f_rest_0..(3·k−1), opacity (logit), scale_0..2 (log) and rot_0..3 (w x y z).
 *
 * The trainers work in COLMAP's frame (x right, y down, z forward). The viewer's frame is glTF's
 * (x right, y up, z back), so every splat is turned 180° about x: y and z change sign, the
 * rotation is premultiplied by that turn, and the SH coefficients that are odd in y·z change sign.
 */

type PlyType = "char" | "uchar" | "short" | "ushort" | "int" | "uint" | "float" | "double";
const SIZES: Record<PlyType, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
const ALIASES: Record<string, PlyType> = { int8: "char", uint8: "uchar", int16: "short", uint16: "ushort", int32: "int", uint32: "uint", float32: "float", float64: "double" };

interface Element {
  name: string;
  count: number;
  props: { name: string; type: PlyType; offset: number }[];
  stride: number;
}

export interface PlyHeader {
  format: string;
  elements: Element[];
  bodyOffset: number;
}

/** Reads the text header; a PLY that is not binary little-endian is refused with the reason. */
export function readPlyHeader(data: Uint8Array): PlyHeader {
  const head = new TextDecoder("latin1").decode(data.subarray(0, Math.min(data.byteLength, 64 * 1024)));
  if (!head.startsWith("ply\n") && !head.startsWith("ply\r\n")) throw new SplatError("This is not a PLY file: it does not start with “ply”.");
  const end = head.indexOf("end_header");
  if (end < 0) throw new SplatError("The PLY header has no end_header line.");
  const nl = head.indexOf("\n", end);
  if (nl < 0) throw new SplatError("The PLY header has no end_header line.");
  const lines = head.slice(0, end).split(/\r?\n/);
  let format = "";
  const elements: Element[] = [];
  for (const line of lines) {
    const w = line.trim().split(/\s+/);
    if (w[0] === "format") format = w[1] ?? "";
    else if (w[0] === "element") elements.push({ name: w[1] ?? "", count: Number(w[2]), props: [], stride: 0 });
    else if (w[0] === "property") {
      const el = elements[elements.length - 1];
      if (!el) throw new SplatError("The PLY header has a property before any element.");
      if (w[1] === "list") {
        el.props.push({ name: w[4] ?? "list", type: "uchar", offset: -1 });
        el.stride = -1;
        continue;
      }
      const type = (ALIASES[w[1]!] ?? w[1]) as PlyType;
      if (!(type in SIZES)) throw new SplatError(`The PLY property ${w[2]} has a type this reader does not know: ${w[1]}.`);
      if (el.stride >= 0) {
        el.props.push({ name: w[2] ?? "", type, offset: el.stride });
        el.stride += SIZES[type];
      }
    }
  }
  for (const e of elements) if (!Number.isInteger(e.count) || e.count < 0) throw new SplatError(`The PLY element ${e.name} has a count that is not a whole number.`);
  return { format, elements, bodyOffset: nl + 1 };
}

const RESTS = [0, 9, 24, 45];
/** Sign of each SH basis function, by its index after the DC term, under the 180° turn about x. */
const SH_SIGN = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];

export interface PlyInfo {
  count: number;
  shDegree: number;
  /** Other properties the file carries (normals, semantic features…); kept in the original only. */
  extra: string[];
}

/** Checks that a PLY header describes Gaussian splats, and says what is missing if not. */
export function plyInfo(h: PlyHeader): PlyInfo {
  if (h.format === "ascii") throw new SplatError("This PLY is written as text (ASCII). Gaussian splat PLYs are binary; export it again as binary little-endian.");
  if (h.format !== "binary_little_endian") throw new SplatError(`This PLY is ${h.format || "of an unknown format"}; only binary little-endian PLYs are read.`);
  const v = h.elements.find((e) => e.name === "vertex");
  if (!v) throw new SplatError("The PLY has no vertex element.");
  if (h.elements.some((e) => e.name === "face")) throw new SplatError("This PLY is a mesh (it has faces), not Gaussian splats. Open meshes as glTF, GLB or FBX.");
  if (isCompressed(h)) return compressedInfo(h);
  if (h.elements[0] !== v) throw new SplatError("The PLY has data before its vertices, which this reader does not expect.");
  if (v.stride < 0) throw new SplatError("The PLY's vertices have list properties, which Gaussian splat PLYs do not.");
  const names = new Set(v.props.map((p) => p.name));
  const need = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const missing = need.filter((n) => !names.has(n));
  if (missing.length === need.length - 3 && names.has("x")) throw new SplatError("This PLY is a point cloud, not Gaussian splats: it has positions but no splat shape or opacity.");
  if (missing.length) throw new SplatError(`This PLY is missing Gaussian splat properties: ${missing.join(", ")}.`);
  let rest = 0;
  while (names.has(`f_rest_${rest}`)) rest++;
  const shDegree = RESTS.indexOf(rest);
  if (shDegree < 0) throw new SplatError(`The PLY has ${rest} f_rest values per splat; Gaussian splats have 0, 9, 24 or 45 (SH degree 0–3).`);
  if (v.count === 0) throw new SplatError("The PLY holds no splats.");
  if (v.count > MAX_SPLATS) throw new SplatError(`The PLY holds ${v.count.toLocaleString("en")} splats, over the ${MAX_SPLATS.toLocaleString("en")} limit for one file.`);
  const known = new Set([...need, ...Array.from({ length: rest }, (_, i) => `f_rest_${i}`)]);
  return { count: v.count, shDegree, extra: v.props.map((p) => p.name).filter((n) => !known.has(n)) };
}

/** Reads a Gaussian splat PLY into the packed cloud, turned into the viewer's frame. */
export function decodePly(data: Uint8Array): { cloud: SplatCloud; info: PlyInfo } {
  const h = readPlyHeader(data);
  const info = plyInfo(h);
  if (isCompressed(h)) return { cloud: decodeCompressed(data, h, info), info };
  const v = h.elements[0]!;
  const n = info.count;
  const need = h.bodyOffset + n * v.stride;
  if (data.byteLength < need) throw new SplatError(`The PLY is cut short: ${n.toLocaleString("en")} splats need ${need.toLocaleString("en")} bytes, it has ${data.byteLength.toLocaleString("en")}.`);
  if (h.elements.length === 1 && data.byteLength > need) throw new SplatError(`The PLY has ${(data.byteLength - need).toLocaleString("en")} bytes after its splats; it is damaged.`);

  const dv = new DataView(data.buffer, data.byteOffset + h.bodyOffset, n * v.stride);
  const off = new Map(v.props.map((p) => [p.name, p]));
  const reader = (name: string): ((o: number) => number) => {
    const p = off.get(name)!;
    const at = p.offset;
    switch (p.type) {
      case "float": return (o) => dv.getFloat32(o + at, true);
      case "double": return (o) => dv.getFloat64(o + at, true);
      case "uchar": return (o) => dv.getUint8(o + at) / 255;
      case "char": return (o) => dv.getInt8(o + at);
      case "short": return (o) => dv.getInt16(o + at, true);
      case "ushort": return (o) => dv.getUint16(o + at, true);
      case "int": return (o) => dv.getInt32(o + at, true);
      case "uint": return (o) => dv.getUint32(o + at, true);
    }
  };
  const [rx, ry, rz] = ["x", "y", "z"].map(reader) as [(o: number) => number, (o: number) => number, (o: number) => number];
  const dc = ["f_dc_0", "f_dc_1", "f_dc_2"].map(reader);
  const op = reader("opacity");
  const sc = ["scale_0", "scale_1", "scale_2"].map(reader);
  const rot = ["rot_0", "rot_1", "rot_2", "rot_3"].map(reader);
  const dim = RESTS[info.shDegree]! / 3;
  const rest = Array.from({ length: dim * 3 }, (_, i) => reader(`f_rest_${i}`));

  const pos = new Float32Array(n * 3);
  let maxAbs = 0;
  for (let i = 0, o = 0; i < n; i++, o += v.stride) {
    const x = rx(o);
    const y = -ry(o);
    const z = -rz(o);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new SplatError(`Splat ${i + 1} has a position that is not a number.`);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
  }
  const fractionalBits = fractionBitsFor(maxAbs);
  const grid = 1 << fractionalBits;
  for (let i = 0; i < pos.length; i++) pos[i] = Math.round(pos[i]! * grid) / grid;

  const alphas = new Uint8Array(n);
  const colors = new Uint8Array(n * 3);
  const scales = new Uint8Array(n * 3);
  const rotations = new Uint8Array(n * 3);
  const sh = new Uint8Array(n * dim * 3);
  for (let i = 0, o = 0; i < n; i++, o += v.stride) {
    const a = op(o);
    alphas[i] = packAlpha(Number.isFinite(a) ? a : -20);
    for (let c = 0; c < 3; c++) {
      colors[i * 3 + c] = packColor(dc[c]!(o) || 0);
      const s = sc[c]!(o);
      scales[i * 3 + c] = packScale(Number.isFinite(s) ? s : -10);
    }
    // PLY: w, x, y, z. Turned 180° about x: (w, x, y, z) → (−x, w, −z, y), as x, y, z, w.
    const w = rot[0]!(o) || 0;
    const qx = rot[1]!(o) || 0;
    const qy = rot[2]!(o) || 0;
    const qz = rot[3]!(o) || 0;
    packRotation(w, -qz, qy, -qx, rotations, i * 3);
    // PLY keeps the rest channel by channel (all of red, then green, then blue); SPZ coefficient by coefficient.
    for (let j = 0; j < dim; j++)
      for (let c = 0; c < 3; c++) sh[(i * dim + j) * 3 + c] = packSh(SH_SIGN[j]! * (rest[c * dim + j]!(o) || 0), j < 3);
  }
  return { cloud: { count: n, shDegree: info.shDegree as 0 | 1 | 2 | 3, fractionalBits, flags: 0, pos, alphas, colors, scales, rotations, sh }, info };
}

// ---------------------------------------------------------------- SuperSplat / PlayCanvas compressed PLY

/**
 * The compressed PLY SuperSplat and PlayCanvas write: splats in chunks of 256, each chunk with
 * its own position, scale and colour ranges, and each splat packed into four 32-bit words
 * (position 11-10-11 bits, rotation "smallest three" 2-10-10-10, log scale 11-10-11, colour and
 * opacity 8-8-8-8). An optional `sh` element holds the SH rest as bytes. Same frame as a trainer's PLY.
 */
const CHUNK = 256;
const CHUNK_PROPS = ["min_x", "min_y", "min_z", "max_x", "max_y", "max_z", "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z", "min_r", "min_g", "min_b", "max_r", "max_g", "max_b"];
const PACKED = ["packed_position", "packed_rotation", "packed_scale", "packed_color"];

function isCompressed(h: PlyHeader): boolean {
  const v = h.elements.find((e) => e.name === "vertex");
  return !!h.elements.find((e) => e.name === "chunk") && !!v && PACKED.every((p) => v.props.some((q) => q.name === p));
}

function compressedInfo(h: PlyHeader): PlyInfo {
  const [chunk, vertex, sh] = h.elements;
  if (chunk?.name !== "chunk" || vertex?.name !== "vertex" || (sh && sh.name !== "sh") || h.elements.length > 3)
    throw new SplatError("This compressed PLY has its parts in an order this reader does not know (chunk, vertex, sh).");
  const cp = new Set(chunk.props.map((p) => p.name));
  const miss = CHUNK_PROPS.filter((p) => !cp.has(p));
  if (miss.length) throw new SplatError(`This compressed PLY's chunks are missing ${miss.join(", ")}.`);
  if (chunk.props.some((p) => p.type !== "float") || vertex.props.some((p) => PACKED.includes(p.name) && p.type !== "uint")) throw new SplatError("This compressed PLY stores its values in types this reader does not expect.");
  if (chunk.count !== Math.ceil(vertex.count / CHUNK)) throw new SplatError(`This compressed PLY has ${chunk.count} chunks for ${vertex.count} splats; it needs ${Math.ceil(vertex.count / CHUNK)}.`);
  let shDegree = 0;
  if (sh) {
    if (sh.count !== vertex.count) throw new SplatError("This compressed PLY has colour detail for a different number of splats.");
    shDegree = RESTS.indexOf(sh.props.length);
    if (shDegree < 0 || sh.props.some((p) => p.type !== "uchar")) throw new SplatError(`This compressed PLY has ${sh.props.length} colour detail values per splat; it needs 9, 24 or 45 bytes.`);
  }
  if (vertex.count === 0) throw new SplatError("The PLY holds no splats.");
  if (vertex.count > MAX_SPLATS) throw new SplatError(`The PLY holds ${vertex.count.toLocaleString("en")} splats, over the ${MAX_SPLATS.toLocaleString("en")} limit for one file.`);
  return { count: vertex.count, shDegree, extra: [] };
}

const SH_C0 = 0.28209479177387814;
const unorm = (v: number, bits: number) => (v & ((1 << bits) - 1)) / ((1 << bits) - 1);

function decodeCompressed(data: Uint8Array, h: PlyHeader, info: PlyInfo): SplatCloud {
  const [chunk, vertex, shEl] = h.elements as [Element, Element, Element | undefined];
  const n = info.count;
  const need = h.bodyOffset + chunk.count * chunk.stride + n * vertex.stride + (shEl ? n * shEl.stride : 0);
  if (data.byteLength < need) throw new SplatError(`The PLY is cut short: it needs ${need.toLocaleString("en")} bytes, it has ${data.byteLength.toLocaleString("en")}.`);
  if (data.byteLength > need) throw new SplatError(`The PLY has ${(data.byteLength - need).toLocaleString("en")} bytes after its splats; it is damaged.`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cBase = h.bodyOffset;
  const vBase = cBase + chunk.count * chunk.stride;
  const sBase = vBase + n * vertex.stride;
  const cOff = Object.fromEntries(chunk.props.map((p) => [p.name, p.offset]));
  const vOff = Object.fromEntries(vertex.props.map((p) => [p.name, p.offset]));
  const ch = (c: number, name: string) => dv.getFloat32(cBase + c * chunk.stride + cOff[name]!, true);

  const pos = new Float32Array(n * 3);
  const alphas = new Uint8Array(n);
  const colors = new Uint8Array(n * 3);
  const scales = new Uint8Array(n * 3);
  const rotations = new Uint8Array(n * 3);
  const dim = RESTS[info.shDegree]! / 3;
  const sh = new Uint8Array(n * dim * 3);
  let maxAbs = 0;
  const norm = Math.SQRT2;
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / CHUNK);
    const o = vBase + i * vertex.stride;
    const lerp = (lo: string, hi: string, t: number) => ch(c, lo) + (ch(c, hi) - ch(c, lo)) * t;
    const pp = dv.getUint32(o + vOff.packed_position!, true);
    const x = lerp("min_x", "max_x", unorm(pp >>> 21, 11));
    const y = -lerp("min_y", "max_y", unorm(pp >>> 11, 10));
    const z = -lerp("min_z", "max_z", unorm(pp, 11));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new SplatError(`Splat ${i + 1} has a position that is not a number.`);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
    const ps = dv.getUint32(o + vOff.packed_scale!, true);
    scales[i * 3] = packScale(lerp("min_scale_x", "max_scale_x", unorm(ps >>> 21, 11)));
    scales[i * 3 + 1] = packScale(lerp("min_scale_y", "max_scale_y", unorm(ps >>> 11, 10)));
    scales[i * 3 + 2] = packScale(lerp("min_scale_z", "max_scale_z", unorm(ps, 11)));
    const pc = dv.getUint32(o + vOff.packed_color!, true);
    // Colours are stored as 0.5 + C0 · dc; opacity after the sigmoid.
    colors[i * 3] = packColor((lerp("min_r", "max_r", unorm(pc >>> 24, 8)) - 0.5) / SH_C0);
    colors[i * 3 + 1] = packColor((lerp("min_g", "max_g", unorm(pc >>> 16, 8)) - 0.5) / SH_C0);
    colors[i * 3 + 2] = packColor((lerp("min_b", "max_b", unorm(pc >>> 8, 8)) - 0.5) / SH_C0);
    alphas[i] = pc & 255;
    // Smallest three, in PLY order w, x, y, z.
    const pr = dv.getUint32(o + vOff.packed_rotation!, true);
    const a = (unorm(pr >>> 20, 10) - 0.5) * norm;
    const b = (unorm(pr >>> 10, 10) - 0.5) * norm;
    const d = (unorm(pr, 10) - 0.5) * norm;
    const m = Math.sqrt(Math.max(0, 1 - a * a - b * b - d * d));
    const q = [[m, a, b, d], [a, m, b, d], [a, b, m, d], [a, b, d, m]][pr >>> 30]!;
    packRotation(q[0]!, -q[3]!, q[2]!, -q[1]!, rotations, i * 3);
    if (shEl)
      for (let j = 0; j < dim; j++)
        for (let k = 0; k < 3; k++) {
          const raw = dv.getUint8(sBase + i * shEl.stride + k * dim + j);
          sh[(i * dim + j) * 3 + k] = packSh(SH_SIGN[j]! * ((raw / 255 - 0.5) * 8), j < 3);
        }
  }
  const fractionalBits = fractionBitsFor(maxAbs);
  const grid = 1 << fractionalBits;
  for (let i = 0; i < pos.length; i++) pos[i] = Math.round(pos[i]! * grid) / grid;
  return { count: n, shDegree: info.shDegree as 0 | 1 | 2 | 3, fractionalBits, flags: 0, pos, alphas, colors, scales, rotations, sh };
}

// ---------------------------------------------------------------- writing

/**
 * The cloud as a standard Gaussian splat PLY, the format trainers write (3DGS, gsplat, Brush):
 * float x, y, z, normals, f_dc, f_rest, opacity (logit), scale (log), rot (w, x, y, z), in the
 * trainer's frame, the inverse of decodePly. SuperSplat, Blender add-ons and game engines read it.
 */
export function encodePly(c: SplatCloud): Uint8Array {
  const dim = shDim(c.shDegree);
  const names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({ length: dim * 3 }, (_, i) => `f_rest_${i}`), "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment HOLO\nelement vertex ${c.count}\n${names.map((n) => `property float ${n}`).join("\n")}\nend_header\n`);
  const stride = names.length * 4;
  const out = new Uint8Array(header.length + c.count * stride);
  out.set(header);
  const dv = new DataView(out.buffer, header.length);
  for (let i = 0; i < c.count; i++) {
    let o = i * stride;
    const put = (v: number) => {
      dv.setFloat32(o, v, true);
      o += 4;
    };
    put(c.pos[i * 3]!);
    put(-c.pos[i * 3 + 1]!);
    put(-c.pos[i * 3 + 2]!);
    put(0);
    put(0);
    put(0);
    for (let k = 0; k < 3; k++) put(unpackColor(c.colors[i * 3 + k]!));
    for (let k = 0; k < 3; k++) for (let j = 0; j < dim; j++) put(SH_SIGN[j]! * unpackSh(c.sh[(i * dim + j) * 3 + k]!));
    const a = Math.min(254.5, Math.max(0.5, c.alphas[i]!)) / 255;
    put(Math.log(a / (1 - a)));
    for (let k = 0; k < 3; k++) put(unpackScale(c.scales[i * 3 + k]!));
    // Stored as x, y, z, w in the viewer's frame = (w, −qz, qy, −qx) of the PLY's (w, qx, qy, qz).
    const [X, Y, Z, W] = unpackRotation(c.rotations, i);
    put(X);
    put(-W);
    put(Z);
    put(-Y);
  }
  return out;
}
