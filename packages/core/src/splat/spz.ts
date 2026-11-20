import { gunzipSync, gzipSync } from "fflate";
import { bytesPerSplat, shDim, SplatError, type SplatCloud } from "./cloud";

/**
 * SPZ, Niantic's compressed Gaussian splat format (github.com/nianticlabs/spz): a gzip stream
 * holding a 16-byte header and the splats attribute by attribute.
 *
 *   magic "NGSP" · version · count · SH degree · fraction bits · flags · reserved
 *
 * Read here: versions 2 and 3 (gzip; version 3 packs rotations as "smallest three" in 4 bytes).
 * Written: version 2, the payload Cesium decodes (KHR_gaussian_splatting_compression_spz_2).
 * Version 4 (a Zstandard container) and version 1 (16-bit float positions) are refused by name,
 * not guessed at; so are SH degree 4 and anything else this reader does not know.
 */

export const SPZ_MAGIC = 0x5053474e;
/** Most splats one file may hold. Larger clouds come as several files or as 3D Tiles. */
export const MAX_SPLATS = 10_000_000;
/** Most bytes a file may inflate to: 10 M splats at SH degree 3 with v3 rotations. */
export const MAX_INFLATED = 16 + MAX_SPLATS * (bytesPerSplat(3) + 1);

export interface SpzHeader {
  version: number;
  count: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
}

const isGzip = (b: Uint8Array) => b.length >= 18 && b[0] === 0x1f && b[1] === 0x8b;

/** What the file says it is, from its first bytes, before inflating all of it. */
export function sniffSpz(data: Uint8Array): { kind: "gzip" } | { kind: "ngsp"; version: number } | { kind: "unknown" } {
  if (isGzip(data)) return { kind: "gzip" };
  if (data.length >= 8) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (v.getUint32(0, true) === SPZ_MAGIC) return { kind: "ngsp", version: v.getUint32(4, true) };
  }
  return { kind: "unknown" };
}

function inflate(data: Uint8Array): Uint8Array {
  // gzip ends with the inflated size (mod 2^32): refuse a bomb before inflating it.
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const declared = v.getUint32(data.byteLength - 4, true);
  if (declared > MAX_INFLATED) throw new SplatError(`The SPZ file says it expands to ${(declared / 1048576).toFixed(0)} MB, over the ${(MAX_INFLATED / 1048576).toFixed(0)} MB limit.`);
  let out: Uint8Array;
  try {
    out = gunzipSync(data);
  } catch {
    throw new SplatError("The SPZ file is damaged: its compressed data cannot be read.");
  }
  if (out.byteLength > MAX_INFLATED) throw new SplatError("The SPZ file expands past the size limit.");
  return out;
}

export function readHeader(raw: Uint8Array): SpzHeader {
  if (raw.byteLength < 16) throw new SplatError("The SPZ file is too short to hold a header.");
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(0, true) !== SPZ_MAGIC) throw new SplatError("This is not an SPZ file: the header does not start with NGSP.");
  return { version: v.getUint32(4, true), count: v.getUint32(8, true), shDegree: raw[12]!, fractionalBits: raw[13]!, flags: raw[14]! };
}

/** Checks a header against what this reader supports, with a reason a person can act on. */
export function checkHeader(h: SpzHeader): void {
  if (h.version === 1) throw new SplatError("SPZ version 1 (16-bit float positions) is not supported. Save the model again as SPZ version 2 or 3.");
  if (h.version !== 2 && h.version !== 3) throw new SplatError(`SPZ version ${h.version} is not supported. Save the model as SPZ version 2 or 3.`);
  if (h.shDegree > 3) throw new SplatError(`Spherical harmonics degree ${h.shDegree} is not supported; the viewer draws degrees 0 to 3.`);
  if (h.count === 0) throw new SplatError("The SPZ file holds no splats.");
  if (h.count > MAX_SPLATS) throw new SplatError(`The SPZ file holds ${h.count.toLocaleString("en")} splats, over the ${MAX_SPLATS.toLocaleString("en")} limit for one file.`);
  if (h.fractionalBits > 23) throw new SplatError(`The SPZ header gives ${h.fractionalBits} fraction bits for 24-bit positions, which cannot be right.`);
}

const C_MASK = (1 << 9) - 1;
const SQRT1_2 = Math.SQRT1_2;

/** A version 3 "smallest three" rotation (4 bytes) as the version 2 form (3 bytes). */
function v3RotationToV2(src: Uint8Array, s: number, dst: Uint8Array, d: number): void {
  let comp = (src[s]! | (src[s + 1]! << 8) | (src[s + 2]! << 16) | (src[s + 3]! << 24)) >>> 0;
  const largest = comp >>> 30;
  const q = [0, 0, 0, 0];
  let sum = 0;
  for (let i = 3; i >= 0; i--) {
    if (i === largest) continue;
    const mag = comp & C_MASK;
    const neg = (comp >>> 9) & 1;
    comp >>>= 10;
    const v = (SQRT1_2 * mag) / C_MASK;
    q[i] = neg ? -v : v;
    sum += v * v;
  }
  q[largest] = Math.sqrt(Math.max(0, 1 - sum));
  // q is x, y, z, w; version 2 keeps x, y, z of the quaternion with w ≥ 0.
  const sign = q[3]! < 0 ? -1 : 1;
  for (let a = 0; a < 3; a++) {
    const b = q[a]! * sign * 127.5 + 127.5;
    dst[d + a] = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
  }
}

/** Packs x, y, z, w as a version 3 rotation; used to make test files. */
export function packRotationV3(q: [number, number, number, number], out: Uint8Array, o: number): void {
  const n = Math.hypot(...q) || 1;
  const u = q.map((x) => x / n);
  let largest = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(u[i]!) > Math.abs(u[largest]!)) largest = i;
  const negate = u[largest]! < 0;
  let comp = largest;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const neg = (u[i]! < 0) !== negate ? 1 : 0;
    const mag = Math.floor(C_MASK * (Math.abs(u[i]!) / SQRT1_2) + 0.5);
    comp = (comp << 10) | (neg << 9) | mag;
  }
  out[o] = comp & 0xff;
  out[o + 1] = (comp >>> 8) & 0xff;
  out[o + 2] = (comp >>> 16) & 0xff;
  out[o + 3] = (comp >>> 24) & 0xff;
}

export interface DecodedSpz {
  header: SpzHeader;
  cloud: SplatCloud;
}

/** Reads an SPZ file. Everything is checked before any of it is used; the reason says what is wrong. */
export function decodeSpz(file: Uint8Array): DecodedSpz {
  const kind = sniffSpz(file);
  if (kind.kind === "ngsp")
    throw new SplatError(
      kind.version >= 4
        ? `SPZ version ${kind.version} (Zstandard) is not supported yet. Save the model as SPZ version 2 or 3.`
        : "The SPZ file is not compressed the way SPZ versions 2 and 3 are (gzip).",
    );
  if (kind.kind !== "gzip") throw new SplatError("This is not an SPZ file: it is not gzip-compressed and has no NGSP header.");
  const raw = inflate(file);
  const h = readHeader(raw);
  checkHeader(h);
  const n = h.count;
  const deg = h.shDegree as 0 | 1 | 2 | 3;
  const rotBytes = h.version === 3 ? 4 : 3;
  const shBytes = shDim(deg) * 3;
  const expected = 16 + n * (9 + 1 + 3 + 3 + rotBytes + shBytes);
  if (raw.byteLength < expected) throw new SplatError(`The SPZ file is cut short: ${n.toLocaleString("en")} splats need ${expected.toLocaleString("en")} bytes, it has ${raw.byteLength.toLocaleString("en")}.`);
  if (raw.byteLength > expected) throw new SplatError(`The SPZ file has ${(raw.byteLength - expected).toLocaleString("en")} bytes after its splats; it is damaged or not a version ${h.version} file.`);

  let o = 16;
  const posBytes = raw.subarray(o, (o += n * 9));
  const alphas = raw.slice(o, (o += n));
  const colors = raw.slice(o, (o += n * 3));
  const scales = raw.slice(o, (o += n * 3));
  let rotations: Uint8Array;
  if (rotBytes === 3) rotations = raw.slice(o, (o += n * 3));
  else {
    rotations = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) v3RotationToV2(raw, o + i * 4, rotations, i * 3);
    o += n * 4;
  }
  const sh = raw.slice(o, (o += n * shBytes));

  const pos = new Float32Array(n * 3);
  const step = 1 / (1 << h.fractionalBits);
  for (let i = 0; i < n * 3; i++) {
    let v = posBytes[i * 3]! | (posBytes[i * 3 + 1]! << 8) | (posBytes[i * 3 + 2]! << 16);
    if (v & 0x800000) v |= ~0xffffff;
    pos[i] = v * step;
  }
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]!)) throw new SplatError("The SPZ file has positions that are not numbers.");
  return { header: h, cloud: { count: n, shDegree: deg, fractionalBits: h.fractionalBits, flags: h.flags, pos, alphas, colors, scales, rotations, sh } };
}

/** Writes a cloud as SPZ version 2 (gzip). Positions are rounded to the cloud's fraction bits. */
export function encodeSpzV2(c: SplatCloud, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const n = c.count;
  const shBytes = shDim(c.shDegree) * 3;
  const raw = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3 + shBytes));
  const v = new DataView(raw.buffer);
  v.setUint32(0, SPZ_MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, n, true);
  raw[12] = c.shDegree;
  raw[13] = c.fractionalBits;
  raw[14] = c.flags;
  let o = 16;
  const scale = 1 << c.fractionalBits;
  const lim = 0x7fffff;
  for (let i = 0; i < n * 3; i++) {
    let f = Math.round(c.pos[i]! * scale);
    if (f > lim || f < -lim - 1) throw new SplatError("A position is outside the range SPZ can hold at this precision.");
    f &= 0xffffff;
    raw[o++] = f & 0xff;
    raw[o++] = (f >>> 8) & 0xff;
    raw[o++] = (f >>> 16) & 0xff;
  }
  raw.set(c.alphas.subarray(0, n), o);
  o += n;
  raw.set(c.colors.subarray(0, n * 3), o);
  o += n * 3;
  raw.set(c.scales.subarray(0, n * 3), o);
  o += n * 3;
  raw.set(c.rotations.subarray(0, n * 3), o);
  o += n * 3;
  raw.set(c.sh.subarray(0, n * shBytes), o);
  return gzipSync(raw, { level, mtime: 0 });
}
