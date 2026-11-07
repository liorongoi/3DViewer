/**
 * Lighting environments (WP 1.4, RND-03): Overcast, Clear noon and Studio neutral.
 *
 * Each one is a small sky model: a function from a direction to a radiance. It is projected
 * onto 9 spherical-harmonic coefficients in the form Cesium's image-based lighting shader
 * evaluates directly (the irradiance convolution and the basis constants are folded in),
 * so there are no image files to ship and it works offline. "Atmosphere" keeps Cesium's
 * own light, which follows the sun and the sky over the model.
 */
export type EnvironmentId = "atmosphere" | "overcast" | "clear-noon" | "studio";

export interface EnvironmentDef {
  id: EnvironmentId;
  label: string;
  /** Sun strength (Cesium's sun is 2.0). */
  sun: number;
  /** Shadow darkness as Cesium means it: 0 black, 1 none. */
  shadow: number;
  /** Scales the sky light. */
  sky: number;
}

// Labels are for scripts and logs; the app shows its own translated names (settings.environments.*).
export const ENVIRONMENTS: EnvironmentDef[] = [
  { id: "atmosphere", label: "Sky and sun", sun: 2, shadow: 0.35, sky: 1 }, // i18n-ignore
  // Clouds hide the sun: weak direct light, faint soft shadows, the sky does most of the work.
  { id: "overcast", label: "Overcast", sun: 0.5, shadow: 0.8, sky: 2.2 }, // i18n-ignore
  { id: "clear-noon", label: "Clear noon", sun: 2.4, shadow: 0.25, sky: 1.3 }, // i18n-ignore
  // Even light for inspecting a model: low sun, soft box overhead, light shadows.
  { id: "studio", label: "Studio neutral", sun: 0.9, shadow: 0.7, sky: 2 }, // i18n-ignore
];

type Rgb = [number, number, number];
/** Radiance for a unit direction in east, north, up (z is up). */
type Sky = (x: number, y: number, z: number) => Rgb;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const SKIES: Record<Exclude<EnvironmentId, "atmosphere">, Sky> = {
  // Thick cloud: bright, even and white overhead (about 3:1 zenith to horizon), dull grey-brown ground.
  overcast: (_x, _y, z) => (z >= 0 ? mix([0.52, 0.54, 0.56], [0.9, 0.92, 0.95], Math.pow(z, 0.7)) : mix([0.3, 0.29, 0.27], [0.18, 0.17, 0.16], -z)),
  // Blue sky, a warm ground bounce and the sun high in the south-east (the direct sun itself stays with the shadow-casting light).
  "clear-noon": (x, y, z) => {
    if (z < 0) return mix([0.32, 0.27, 0.21], [0.2, 0.17, 0.13], -z);
    const sky = mix([0.62, 0.72, 0.85], [0.22, 0.42, 0.78], Math.pow(z, 0.6));
    const s = [0.35, -0.35, 0.87];
    const glow = Math.pow(Math.max(0, x * s[0]! + y * s[1]! + z * s[2]!), 8) * 0.9;
    return [sky[0] + glow, sky[1] + glow * 0.95, sky[2] + glow * 0.85];
  },
  // A photo studio: a large soft box overhead, a dim fill from the front-left, a neutral floor.
  studio: (x, y, z) => {
    const top = smooth(0.55, 0.9, z) * 1.6;
    const fill = smooth(0.6, 0.95, -0.6 * x - 0.6 * y + 0.5 * z) * 0.5;
    const base = z >= 0 ? 0.3 : 0.16;
    const v = base + top + fill;
    return [v, v, v];
  },
};

/**
 * Cesium turns the normal into the model's frame and then swaps it to y-up (Model.js, yUpToZUp):
 * shader x = east, y = up, z = south.
 */
const toShader = (e: number, n: number, u: number): [number, number, number] => [e, u, -n];
const basis = (x: number, y: number, z: number) => [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];

/** Irradiance ÷ π convolution weights per band (π, 2π/3, π/4 over π). */
const BAND = [1, 2 / 3, 1 / 4];

/** Projects a sky onto 9 coefficients in Cesium's order: L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22. */
export function shCoefficients(sky: Sky, samples = 64): Rgb[] {
  const L: Rgb[] = Array.from({ length: 9 }, () => [0, 0, 0] as Rgb);
  // Equal-area grid in (cos θ, φ): every sample covers the same solid angle.
  const n = samples;
  const dw = (4 * Math.PI) / (n * 2 * n);
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    for (let j = 0; j < 2 * n; j++) {
      const phi = (Math.PI * (j + 0.5)) / n;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      const c = sky(x, y, z);
      const Y = basis(...toShader(x, y, z));
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) L[k]![ch]! += c[ch]! * Y[k]! * dw;
    }
  }
  // Fold in the convolution and the basis constants, so the shader's polynomial gives irradiance ÷ π.
  const K = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
  const band = [0, 1, 1, 1, 2, 2, 2, 2, 2];
  return L.map((v, k) => v.map((c) => c * BAND[band[k]!]! * K[k]!) as Rgb);
}

/** Evaluates coefficients the way Cesium's shader does, for a direction in east, north, up. */
export function evalSh(c: Rgb[], e: number, n: number, u: number): Rgb {
  const [x, y, z] = toShader(e, n, u);
  const b = [1, y, z, x, y * x, y * z, 3 * z * z - 1, z * x, x * x - y * y];
  return [0, 1, 2].map((ch) => c.reduce((s, v, k) => s + v[ch]! * b[k]!, 0)) as Rgb;
}

const cache = new Map<EnvironmentId, Rgb[]>();
/** Coefficients for an environment, or null for "atmosphere" (Cesium's own sky light). */
export function environmentSh(id: EnvironmentId): Rgb[] | null {
  if (id === "atmosphere") return null;
  const k = ENVIRONMENTS.find((e) => e.id === id)!.sky;
  if (!cache.has(id)) cache.set(id, shCoefficients(SKIES[id]).map((v) => v.map((c) => c * k) as Rgb));
  return cache.get(id)!;
}

/**
 * Pre-filtered specular map (WP 1.4, RND-03): the same sky as a cube map whose mip levels are
 * the sky blurred by the GGX lobe for roughness 0 (mirror) to 1, which is how Cesium reads it
 * (lod = roughness × top level). Made in code like the sky light, so nothing ships as a file.
 */
export interface SpecularCube {
  size: number;
  /** One entry per mip level, largest first: 6 faces (+X, −X, +Y, −Y, +Z, −Z), RGBA float. */
  levels: Float32Array[];
}

/** Direction of a cube texel in the shader frame, as WebGL's cube map lookup defines it. */
function faceDir(face: number, s: number, t: number): [number, number, number] {
  const d: [number, number, number] =
    face === 0 ? [1, -t, -s] : face === 1 ? [-1, -t, s] : face === 2 ? [s, 1, t] : face === 3 ? [s, -1, -t] : face === 4 ? [s, -t, 1] : [-s, -t, -1];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** Sky radiance for a direction in the shader frame (x east, y up, z south). */
const skyAt = (sky: Sky, x: number, y: number, z: number): Rgb => sky(x, -z, y);

/** The GGX-filtered radiance around `n` (taken as both normal and view, the usual split-sum approximation). */
function prefilter(sky: Sky, n: [number, number, number], roughness: number, samples: number): Rgb {
  if (roughness === 0) return skyAt(sky, ...n);
  const a = roughness * roughness;
  // A frame around n.
  const up: [number, number, number] = Math.abs(n[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const tx = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const tl = Math.hypot(tx[0]!, tx[1]!, tx[2]!);
  const t1 = tx.map((v) => v / tl);
  const t2 = [n[1] * t1[2]! - n[2] * t1[1]!, n[2] * t1[0]! - n[0] * t1[2]!, n[0] * t1[1]! - n[1] * t1[0]!];
  const sum: Rgb = [0, 0, 0];
  let w = 0;
  for (let i = 0; i < samples; i++) {
    // Hammersley point, importance-sampled to the GGX distribution of half vectors.
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u = i / samples, v = bits / 4294967296;
    const phi = 2 * Math.PI * u;
    const cos = Math.sqrt((1 - v) / (1 + (a * a - 1) * v));
    const sin = Math.sqrt(1 - cos * cos);
    const h = [0, 1, 2].map((k) => t1[k]! * sin * Math.cos(phi) + t2[k]! * sin * Math.sin(phi) + n[k]! * cos);
    const nh = n[0] * h[0]! + n[1] * h[1]! + n[2] * h[2]!;
    const l = [0, 1, 2].map((k) => 2 * nh * h[k]! - n[k]!);
    const nl = n[0] * l[0]! + n[1] * l[1]! + n[2] * l[2]!;
    if (nl <= 0) continue;
    const c = skyAt(sky, l[0]!, l[1]!, l[2]!);
    for (let k = 0; k < 3; k++) sum[k] = sum[k]! + c[k]! * nl;
    w += nl;
  }
  return sum.map((c) => c / (w || 1)) as Rgb;
}

/** Builds the filtered cube for a sky, `size` texels on a side at the top level. */
export function specularCube(sky: Sky, size = 32, scale = 1): SpecularCube {
  const levelsN = Math.log2(size) + 1;
  const levels: Float32Array[] = [];
  for (let m = 0; m < levelsN; m++) {
    const s = size >> m;
    const roughness = m / (levelsN - 1);
    const out = new Float32Array(6 * s * s * 4);
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const c = prefilter(sky, faceDir(f, ((x + 0.5) / s) * 2 - 1, ((y + 0.5) / s) * 2 - 1), roughness, m === 0 ? 1 : 96);
          out.set([c[0] * scale, c[1] * scale, c[2] * scale, 1], ((f * s + y) * s + x) * 4);
        }
    levels.push(out);
  }
  return { size, levels };
}

const cubes = new Map<EnvironmentId, SpecularCube>();
/** The filtered cube for an environment, or null for "atmosphere" (Cesium makes its own). */
export function environmentSpecular(id: EnvironmentId): SpecularCube | null {
  if (id === "atmosphere") return null;
  if (!cubes.has(id)) cubes.set(id, specularCube(SKIES[id], 32, ENVIRONMENTS.find((e) => e.id === id)!.sky));
  return cubes.get(id)!;
}
