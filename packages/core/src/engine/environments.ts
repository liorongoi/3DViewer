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

export const ENVIRONMENTS: EnvironmentDef[] = [
  { id: "atmosphere", label: "Sky and sun", sun: 2, shadow: 0.35, sky: 1 },
  // Clouds hide the sun: weak direct light, faint soft shadows, the sky does most of the work.
  { id: "overcast", label: "Overcast", sun: 0.5, shadow: 0.8, sky: 2.2 },
  { id: "clear-noon", label: "Clear noon", sun: 2.4, shadow: 0.25, sky: 1.3 },
  // Even light for inspecting a model: low sun, soft box overhead, light shadows.
  { id: "studio", label: "Studio neutral", sun: 0.9, shadow: 0.7, sky: 2 },
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
