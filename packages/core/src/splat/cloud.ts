/**
 * A Gaussian splat cloud held the way SPZ v2 stores it (Niantic SPZ, the payload of glTF
 * KHR_gaussian_splatting_compression_spz_2), so a 2 million splat model needs about 130 MB
 * rather than the 500 MB the same model takes as floats:
 *
 *   alphas     1 byte   sigmoid(opacity) × 255
 *   colors     3 bytes  the SH DC term, dc × 0.15 × 255 + 127.5
 *   scales     3 bytes  (log scale + 10) × 16
 *   rotations  3 bytes  the unit quaternion's x, y, z with w ≥ 0, × 127.5 + 127.5
 *   sh         3 × (15 | 8 | 3 | 0) bytes, coefficient-major with r, g, b inside
 *
 * Positions are kept as floats (`pos`), in the glTF frame (x right, y up, z towards the viewer:
 * SPZ calls it RUB). They are what tiling, framing and picking need, and they are rounded to the
 * cloud's fixed-point grid, so writing them back to SPZ is exact.
 */
export interface SplatCloud {
  count: number;
  shDegree: 0 | 1 | 2 | 3;
  /** Fixed-point fraction bits of the positions (SPZ default 12: 1/4096 of a unit). */
  fractionalBits: number;
  /** SPZ flags; bit 0: trained with antialiasing. */
  flags: number;
  pos: Float32Array;
  alphas: Uint8Array;
  colors: Uint8Array;
  scales: Uint8Array;
  rotations: Uint8Array;
  sh: Uint8Array;
}

/** SH coefficients beyond the DC term, per colour channel, for each degree. */
export const SH_DIM = [0, 3, 8, 15] as const;

export const shDim = (degree: number): number => SH_DIM[degree] ?? 0;

/** Bytes per splat in the uncompressed SPZ v2 payload. */
export const bytesPerSplat = (degree: number): number => 9 + 1 + 3 + 3 + 3 + shDim(degree) * 3;

export class SplatError extends Error {
  override name = "SplatError";
}

// ---------------------------------------------------------------- quantisation (Niantic SPZ)

const COLOR_SCALE = 0.15;
export const toU8 = (x: number): number => (x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x));
export const packAlpha = (opacityLogit: number): number => toU8((1 / (1 + Math.exp(-opacityLogit))) * 255);
export const packColor = (dc: number): number => toU8(dc * (COLOR_SCALE * 255) + 0.5 * 255);
export const unpackColor = (b: number): number => (b / 255 - 0.5) / COLOR_SCALE;
export const packScale = (logScale: number): number => toU8((logScale + 10) * 16);
export const unpackScale = (b: number): number => b / 16 - 10;
/** SH coefficients: degree 1 keeps 5 bits, higher degrees 4 bits. */
export function packSh(x: number, degreeOne: boolean): number {
  const bucket = degreeOne ? 8 : 16;
  let q = Math.round(x * 128 + 128);
  q = Math.floor((q + bucket / 2) / bucket) * bucket;
  return q < 0 ? 0 : q > 255 ? 255 : q;
}
export const unpackSh = (b: number): number => (b - 128) / 128;

/** Packs a quaternion given as x, y, z, w into 3 bytes at out[o]. */
export function packRotation(x: number, y: number, z: number, w: number, out: Uint8Array, o: number): void {
  let n = Math.hypot(x, y, z, w);
  if (!(n > 0)) {
    x = y = z = 0;
    n = 1;
  }
  const s = (w < 0 ? -1 : 1) / n;
  out[o] = toU8(x * s * 127.5 + 127.5);
  out[o + 1] = toU8(y * s * 127.5 + 127.5);
  out[o + 2] = toU8(z * s * 127.5 + 127.5);
}

/** The x, y, z, w quaternion of splat i. */
export function unpackRotation(r: Uint8Array, i: number): [number, number, number, number] {
  const x = r[i * 3]! / 127.5 - 1;
  const y = r[i * 3 + 1]! / 127.5 - 1;
  const z = r[i * 3 + 2]! / 127.5 - 1;
  return [x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))];
}

/**
 * The fraction bits that keep every coordinate inside SPZ's signed 24-bit range, at most 12
 * (SPZ's default, 0.24 mm in metres). A wider cloud gets coarser steps: 20 km still keeps 2 mm.
 */
export function fractionBitsFor(maxAbs: number, preferred = 12): number {
  if (!(maxAbs > 0)) return preferred;
  const room = Math.floor(Math.log2((2 ** 23 - 1) / maxAbs));
  return Math.max(0, Math.min(preferred, room));
}

// ---------------------------------------------------------------- statistics

export interface SplatBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function bounds(pos: Float32Array, count = pos.length / 3): SplatBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  return { min, max };
}

/**
 * Bounds that leave out the sparse floaters training leaves far from the subject: per axis, the
 * `lo` and `hi` quantiles of a deterministic sample of up to 200 000 centres. Used to frame the
 * model and to state its size; nothing is removed from the model.
 */
export function robustBounds(pos: Float32Array, count = pos.length / 3, lo = 0.01, hi = 0.99): SplatBounds {
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const step = Math.max(1, Math.floor(count / 200_000));
  const n = Math.ceil(count / step);
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  const col = new Float32Array(n);
  for (let a = 0; a < 3; a++) {
    for (let k = 0, i = 0; i < count; i += step, k++) col[k] = pos[i * 3 + a]!;
    col.sort();
    min[a] = col[Math.min(n - 1, Math.floor(lo * (n - 1)))]!;
    max[a] = col[Math.min(n - 1, Math.ceil(hi * (n - 1)))]!;
  }
  return { min, max };
}

/** A new cloud with the splats at `idx`, positions moved by -offset. */
export function subset(c: SplatCloud, idx: Uint32Array, offset: [number, number, number] = [0, 0, 0]): SplatCloud {
  const n = idx.length;
  const d = shDim(c.shDegree) * 3;
  const out: SplatCloud = {
    count: n,
    shDegree: c.shDegree,
    fractionalBits: c.fractionalBits,
    flags: c.flags,
    pos: new Float32Array(n * 3),
    alphas: new Uint8Array(n),
    colors: new Uint8Array(n * 3),
    scales: new Uint8Array(n * 3),
    rotations: new Uint8Array(n * 3),
    sh: new Uint8Array(n * d),
  };
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    for (let a = 0; a < 3; a++) {
      out.pos[k * 3 + a] = c.pos[i * 3 + a]! - offset[a]!;
      out.colors[k * 3 + a] = c.colors[i * 3 + a]!;
      out.scales[k * 3 + a] = c.scales[i * 3 + a]!;
      out.rotations[k * 3 + a] = c.rotations[i * 3 + a]!;
    }
    out.alphas[k] = c.alphas[i]!;
    if (d) out.sh.set(c.sh.subarray(i * d, i * d + d), k * d);
  }
  return out;
}
