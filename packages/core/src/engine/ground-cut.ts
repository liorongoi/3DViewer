import {
  Cartesian3,
  Cartographic,
  Color,
  CustomShader,
  CustomShaderTranslucencyMode,
  LightingModel,
  Matrix4,
  OrthographicFrustum,
  Rectangle,
  UniformType,
  type Cesium3DTileset,
  type Model,
  type Scene,
} from "cesium";
import type { DemSource } from "./terrain";

/**
 * Keeps the terrain under the open model (WP 1.6, VWR-GEO-01: no terrain poke-through).
 *
 * Terrain models are coarse (10–30 m cells) and often measure the tops of buildings and
 * trees (SRTM is a surface model), so wherever a model's own ground is lower than that
 * terrain, the terrain shows through it: over roofs in a city, over the ground points of a
 * lidar survey, over the base of an object placed on a slope.
 *
 * The model is drawn once from straight below, with an orthographic camera and a shader
 * that writes each fragment's distance as a colour, so one frame gives the height of the
 * model's lowest surface at every pixel. Inside the model's outline the terrain is then
 * lowered to just below that surface (it is never raised); everywhere else it is untouched.
 */

/** How far the terrain is kept below the model's lowest surface, metres. */
export const CUT_MARGIN = 0.4;
/** The cut reaches this many pixels past the model's outline. */
const DILATE_PX = 1;

const SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  float d = floor(clamp(-fsInput.attributes.positionEC.z * u_scale, 0.0, 16777214.0)) + 1.0;
  float b0 = floor(d / 65536.0);
  float r = d - b0 * 65536.0;
  float b1 = floor(r / 256.0);
  float b2 = r - b1 * 256.0;
  // The frame is written as sRGB (HDR is off for the capture); undo that so the bytes come out exact.
  material.diffuse = czm_srgbToLinear(vec3(b0, b1, b2) / 255.0);
  material.alpha = 1.0;
}`;

type Target = Model | Cesium3DTileset;

/** The model's lowest surface seen from below, on the pixel grid of the capture. */
export interface Underside {
  /** Distance from the camera plane to the lowest surface, metres; NaN where there is no model. */
  dist: Float32Array;
  width: number;
  height: number;
  /** Metres per pixel. */
  mpp: number;
  camPos: Cartesian3;
  right: Cartesian3;
  up: Cartesian3;
  camHeight: number;
  /** Lon/lat bounds of the captured area, radians. */
  rectangle: Rectangle;
}

/** Min over a square window, ignoring NaN. Exported for tests. */
export function dilateMin(src: Float32Array, w: number, h: number, r: number): Float32Array {
  // Separable: rows, then columns.
  const tmp = new Float32Array(src.length).fill(NaN);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const v = src[y * w + k]!;
        if (v < m) m = v;
      }
      if (m !== Infinity) tmp[y * w + x] = m;
    }
  const out = new Float32Array(src.length).fill(NaN);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        const v = tmp[k * w + x]!;
        if (v < m) m = v;
      }
      if (m !== Infinity) out[y * w + x] = m;
    }
  return out;
}

/** Decodes the capture's RGBA bytes into distances (metres), NaN where nothing was drawn. */
export function decodeDistances(rgba: Uint8ClampedArray | Uint8Array, scale: number): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    const v = rgba[i * 4]! * 65536 + rgba[i * 4 + 1]! * 256 + rgba[i * 4 + 2]!;
    out[i] = v === 0 ? NaN : (v - 1 + 0.5) / scale;
  }
  return out;
}

/** Pixels with model in them. */
export function coverage(u: Underside | null): number {
  let n = 0;
  if (u) for (const v of u.dist) if (Number.isFinite(v)) n++;
  return n;
}

/** The model's bounding sphere spans the capture, so a capture with less than this did not draw. */
export const MIN_COVERAGE = 500;

/**
 * Draws `target` alone from straight below and reads back its lowest surface. Everything
 * the scene would normally draw is switched off for that one frame and restored before
 * returning, all in the same task, so the frame is never shown.
 */
export function captureUnderside(scene: Scene, target: Target, render: () => void): Underside | null {
  const bs = target.boundingSphere;
  if (!bs || !(bs.radius > 0)) return null;
  const canvas = scene.canvas;
  const W = scene.drawingBufferWidth, H = scene.drawingBufferHeight;
  if (W < 16 || H < 16) return null;
  const ellipsoid = scene.globe.ellipsoid;
  const normal = ellipsoid.geodeticSurfaceNormal(bs.center, new Cartesian3());
  // East/north at the centre, for an upward camera whose "up" is north.
  const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, normal, new Cartesian3()), new Cartesian3());
  const north = Cartesian3.cross(normal, east, new Cartesian3());
  const below = 2 * bs.radius + 10;
  const camPos = Cartesian3.add(bs.center, Cartesian3.multiplyByScalar(normal, -bs.radius - 10, new Cartesian3()), new Cartesian3());
  const range = below + 10;
  const scale = 16777000 / range;
  const width = 2 * bs.radius * 1.02;
  const aspect = W / H;
  // The frustum's width covers the sphere along the narrow side of the canvas.
  const frustumWidth = aspect >= 1 ? width * aspect : width;
  const mpp = frustumWidth / W;

  // Save what will be changed.
  const cam = scene.camera;
  const saved = {
    frustum: cam.frustum,
    // In world coordinates: the camera may be in a local frame (orbit, tour), restored after.
    transform: Matrix4.clone(cam.transform),
    position: Cartesian3.clone(cam.positionWC),
    direction: Cartesian3.clone(cam.directionWC),
    up: Cartesian3.clone(cam.upWC),
    right: Cartesian3.clone(cam.rightWC),
    hdr: scene.highDynamicRange,
    msaa: scene.msaaSamples,
    globe: scene.globe.show,
    sky: scene.skyBox?.show,
    atmosphere: scene.skyAtmosphere?.show,
    sun: scene.sun?.show,
    moon: scene.moon?.show,
    fog: scene.fog.enabled,
    bg: Color.clone(scene.backgroundColor),
    shadows: scene.shadowMap?.enabled,
    ground: scene.groundPrimitives.show,
    fxaa: scene.postProcessStages.fxaa.enabled,
    ao: scene.postProcessStages.ambientOcclusion.enabled,
    bloom: scene.postProcessStages.bloom.enabled,
    stages: [] as boolean[],
    prims: [] as boolean[],
    shader: target.customShader,
    cull: target.backFaceCulling,
    edl: "pointCloudShading" in target ? target.pointCloudShading.eyeDomeLighting : undefined,
    freeze: "debugFreezeFrame" in target ? target.debugFreezeFrame : undefined,
    envMap: target.environmentMapManager?.enabled,
  };
  const stages = scene.postProcessStages;
  const sscc = scene.screenSpaceCameraController;
  const collision = sscc.enableCollisionDetection;
  const prims = scene.primitives;
  let rgba: Uint8ClampedArray | null = null;
  // A normal frame first, so the tiles kept below are the ones chosen for the user's view
  // (a height sample in progress also chooses tiles, along its rays, and may have been last).
  render();
  try {
    scene.highDynamicRange = false;
    scene.msaaSamples = 1;
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    scene.backgroundColor = Color.BLACK;
    if (scene.shadowMap) scene.shadowMap.enabled = false;
    scene.groundPrimitives.show = false;
    stages.fxaa.enabled = false;
    stages.ambientOcclusion.enabled = false;
    stages.bloom.enabled = false;
    for (let i = 0; i < stages.length; i++) (saved.stages.push(stages.get(i).enabled), (stages.get(i).enabled = false));
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i) as { show: boolean };
      saved.prims.push(p.show);
      p.show = p === (target as unknown);
    }
    target.customShader = new CustomShader({
      lightingModel: LightingModel.UNLIT,
      translucencyMode: CustomShaderTranslucencyMode.OPAQUE,
      uniforms: { u_scale: { type: UniformType.FLOAT, value: scale } },
      fragmentShaderText: SHADER,
    });
    // Both faces count: the lowest surface is what the terrain must stay under, whichever way it faces.
    target.backFaceCulling = false;
    if ("pointCloudShading" in target) target.pointCloudShading.eyeDomeLighting = false;
    // Draw the tiles the user's last frame drew: they are loaded, and choosing tiles for the
    // capture's own camera could pick ones that are not, leaving holes. What the user has not
    // looked at yet comes in later captures, merged in as its tiles load.
    if ("debugFreezeFrame" in target) target.debugFreezeFrame = true;
    // Hiding the sky and the globe makes Cesium rebuild the model's environment map from the
    // sky, and its rebuild work queued from the frames before then drew with freed buffers,
    // which stopped all drawing ("This object was destroyed"). The capture is unlit, so it needs
    // no environment map: leave it as it was until the capture is over.
    if (target.environmentMapManager) target.environmentMapManager.enabled = false;

    // Cesium keeps the camera above the terrain; from below the ground that would move it up
    // and widen the frustum, so the model came out as a dot.
    sscc.enableCollisionDetection = false;
    cam.lookAtTransform(Matrix4.IDENTITY);
    cam.frustum = new OrthographicFrustum({ width: frustumWidth, aspectRatio: aspect, near: 0.5, far: range + 10 });
    cam.position = camPos;
    cam.direction = Cartesian3.clone(normal);
    cam.up = Cartesian3.clone(north);
    cam.right = Cartesian3.cross(cam.direction, cam.up, new Cartesian3());

    // The first frames build the new shaders; draw until the model shows (a few frames at most).
    const c2d = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (c2d) {
      c2d.canvas.width = W;
      c2d.canvas.height = H;
      for (let i = 0; i < 6; i++) {
        render();
        c2d.drawImage(canvas, 0, 0, W, H);
        const data = c2d.getImageData(0, 0, W, H).data;
        let drawn = 0;
        for (let p = 0; p < data.length && drawn < 1000; p += 4) if (data[p]! | data[p + 1]! | data[p + 2]!) drawn++;
        rgba = data;
        if (i >= 1 && drawn >= 1000) break;
      }
    }
  } finally {
    sscc.enableCollisionDetection = collision;
    cam.lookAtTransform(Matrix4.IDENTITY);
    cam.frustum = saved.frustum;
    cam.position = saved.position;
    cam.direction = saved.direction;
    cam.up = saved.up;
    cam.right = saved.right;
    if (!Matrix4.equals(saved.transform, Matrix4.IDENTITY)) cam.lookAtTransform(saved.transform);
    scene.highDynamicRange = saved.hdr;
    scene.msaaSamples = saved.msaa;
    scene.globe.show = saved.globe;
    if (scene.skyBox && saved.sky !== undefined) scene.skyBox.show = saved.sky;
    if (scene.skyAtmosphere && saved.atmosphere !== undefined) scene.skyAtmosphere.show = saved.atmosphere;
    if (scene.sun && saved.sun !== undefined) scene.sun.show = saved.sun;
    if (scene.moon && saved.moon !== undefined) scene.moon.show = saved.moon;
    scene.fog.enabled = saved.fog;
    scene.backgroundColor = saved.bg;
    if (scene.shadowMap && saved.shadows !== undefined) scene.shadowMap.enabled = saved.shadows;
    scene.groundPrimitives.show = saved.ground;
    stages.fxaa.enabled = saved.fxaa;
    stages.ambientOcclusion.enabled = saved.ao;
    stages.bloom.enabled = saved.bloom;
    saved.stages.forEach((e, i) => (stages.get(i).enabled = e));
    saved.prims.forEach((s, i) => ((prims.get(i) as { show: boolean }).show = s));
    target.customShader = saved.shader;
    target.backFaceCulling = saved.cull;
    if ("pointCloudShading" in target && saved.edl !== undefined) target.pointCloudShading.eyeDomeLighting = saved.edl;
    if ("debugFreezeFrame" in target && saved.freeze !== undefined) target.debugFreezeFrame = saved.freeze;
    if (target.environmentMapManager && saved.envMap !== undefined) target.environmentMapManager.enabled = saved.envMap;
    // Draw the normal frame now, so the capture is never what the user sees.
    render();
  }
  if (!rgba) return null;

  // The canvas is read top row first; with "up" north and looking up, screen right is west.
  const dist = decodeDistances(rgba, scale);
  const right = Cartesian3.cross(normal, north, new Cartesian3());
  const corners = [
    [-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2],
  ].map(([x, y]) => {
    const p = Cartesian3.add(camPos, Cartesian3.multiplyByScalar(right, x! * mpp, new Cartesian3()), new Cartesian3());
    Cartesian3.add(p, Cartesian3.multiplyByScalar(north, y! * mpp, new Cartesian3()), p);
    return Cartographic.fromCartesian(p, ellipsoid);
  });
  const rectangle = Rectangle.fromCartographicArray(corners);
  return {
    dist: dilateMin(dist, W, H, DILATE_PX),
    width: W,
    height: H,
    mpp,
    camPos,
    right,
    up: north,
    camHeight: Cartographic.fromCartesian(camPos, ellipsoid).height,
    rectangle,
  };
}

const R_EARTH = 6371000;

/**
 * Two captures of the same model from the same place, combined: the lower surface at each
 * pixel. "unchanged" when the second adds less than `minPixels` pixels of new or lower ground
 * (by more than 0.25 m); "incompatible" when they were not taken on the same pixel grid.
 */
export function mergeUndersides(a: Underside, b: Underside, minPixels = 30): Underside | "unchanged" | "incompatible" {
  if (a.width !== b.width || a.height !== b.height || Math.abs(a.mpp - b.mpp) > 1e-6) return "incompatible";
  // The camera sits below the model's bounding sphere, so it moves with the model's height
  // offset; only a sideways move makes the grids differ.
  const d = Cartesian3.subtract(b.camPos, a.camPos, new Cartesian3());
  if (Math.abs(Cartesian3.dot(d, a.right)) > a.mpp / 4 || Math.abs(Cartesian3.dot(d, a.up)) > a.mpp / 4) return "incompatible";
  let added = 0;
  const dist = new Float32Array(a.dist.length);
  for (let i = 0; i < dist.length; i++) {
    const x = a.dist[i]!, y = b.dist[i]!;
    if (Number.isFinite(y) && !(y >= x - 0.25)) added++;
    dist[i] = Number.isFinite(x) ? (Number.isFinite(y) ? Math.min(x, y) : x) : y;
  }
  return added < minPixels ? "unchanged" : { ...a, dist };
}

/** Levels of minimums, each half the size of the one before, for fast "lowest within a window". */
export class MinPyramid {
  readonly levels: { w: number; h: number; v: Float32Array }[] = [];
  constructor(v: Float32Array, w: number, h: number) {
    this.levels.push({ w, h, v });
    while (w > 1 || h > 1) {
      const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
      const prev = this.levels[this.levels.length - 1]!.v;
      const next = new Float32Array(nw * nh).fill(NaN);
      for (let y = 0; y < nh; y++)
        for (let x = 0; x < nw; x++) {
          let m = Infinity;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const sx = 2 * x + dx, sy = 2 * y + dy;
              if (sx < w && sy < h) {
                const val = prev[sy * w + sx]!;
                if (val < m) m = val;
              }
            }
          if (m !== Infinity) next[y * nw + x] = m;
        }
      this.levels.push({ w: nw, h: nh, v: next });
      w = nw;
      h = nh;
    }
  }

  /** The lowest value in pixels [x0, x1] × [y0, y1] (inclusive), or a little wider; NaN if none. */
  min(x0: number, y0: number, x1: number, y1: number): number {
    const base = this.levels[0]!;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(base.w - 1, x1);
    y1 = Math.min(base.h - 1, y1);
    if (x0 > x1 || y0 > y1) return NaN;
    const span = Math.max(x1 - x0, y1 - y0) + 1;
    const k = Math.min(this.levels.length - 1, Math.max(0, Math.ceil(Math.log2(span / 2))));
    const L = this.levels[k]!;
    let m = Infinity;
    for (let y = y0 >> k; y <= y1 >> k; y++)
      for (let x = x0 >> k; x <= x1 >> k; x++) {
        const val = L.v[y * L.w + x]!;
        if (val < m) m = val;
      }
    return m === Infinity ? NaN : m;
  }
}

/**
 * The terrain cut for one capture, as a terrain layer that lowers the terrain inside the
 * model's outline. `shift()` returns the metres the model has moved up since the capture.
 */
export function groundCut(u: Underside, shift: () => number): DemSource {
  const tmp = new Cartesian3();
  const pyramid = new MinPyramid(u.dist, u.width, u.height);
  /**
   * The cut at one terrain sample. The globe draws straight triangles between samples, so a
   * sample takes the lowest surface within one sample spacing around it: then no point
   * between samples can rise above the model, however coarse the terrain tile is.
   */
  const sample = (lon: number, lat: number, spacing: number): number => {
    const p = Cartesian3.fromRadians(lon, lat, u.camHeight, undefined, tmp);
    Cartesian3.subtract(p, u.camPos, p);
    const dx = Cartesian3.dot(p, u.right), dy = Cartesian3.dot(p, u.up);
    const px = dx / u.mpp + u.width / 2;
    const py = u.height / 2 - dy / u.mpp;
    const r = spacing / u.mpp;
    const d = pyramid.min(Math.floor(px - r), Math.floor(py - r), Math.floor(px + r), Math.floor(py + r));
    if (!Number.isFinite(d)) return NaN;
    // Heights above the ellipsoid rise by d²/2R away from where the camera plane touches it.
    return u.camHeight + d + (dx * dx + dy * dy) / (2 * R_EARTH) + shift() - CUT_MARGIN;
  };
  return {
    rectangle: u.rectangle,
    mode: "lower",
    async heightGrid(rect, n) {
      if (!Rectangle.intersection(rect, u.rectangle)) return null;
      const g = new Float32Array(n * n);
      let any = false;
      // Sample spacing in metres, the larger of the two directions.
      const mid = (rect.north + rect.south) / 2;
      const spacing = (Math.max((rect.east - rect.west) * Math.cos(mid), rect.north - rect.south) * R_EARTH) / (n - 1);
      for (let r = 0; r < n; r++) {
        const lat = rect.north - ((rect.north - rect.south) * r) / (n - 1);
        for (let c = 0; c < n; c++) {
          const lon = rect.west + ((rect.east - rect.west) * c) / (n - 1);
          const h = sample(lon, lat, spacing);
          g[r * n + c] = h;
          if (Number.isFinite(h)) any = true;
        }
      }
      return any ? g : null;
    },
  };
}


