import {
  Camera,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantPositionProperty,
  ConstantProperty,
  HeightReference,
  PostProcessStage,
  ShadowMap,
  ShadowMode,
  type Entity,
  type EntityCollection,
  type Scene,
} from "cesium";
import { signal } from "../signal";
import { computeViewshedGrid, viewshedCellFor, viewshedGridFrame, viewshedToGeoTiff, type ViewshedGridResult } from "./viewshed-grid";

/** The visible area on the ground, worked out on a grid (WP 2.9). */
export interface ViewshedArea {
  /** The state it was computed for; any change to the observer makes it stale and it is cleared. */
  for: ViewshedState;
  computing: boolean;
  result: ViewshedGridResult | null;
  frame: { epsg: number; easting: number; northing: number } | null;
  error?: string;
}

/**
 * 360° visibility (viewshed) from an observer point (VWR-ANL-03, plan WP 2.9).
 *
 * GPU method: a point-light shadow map is rendered from the observer's eye. Its cube
 * depth texture records, in every direction, the distance to the first surface the eye
 * sees, from terrain, models, 3D Tiles and point clouds alike. A post-process pass then
 * takes each screen pixel's world position and compares its distance to the observer
 * with the cube depth in that direction: equal means visible, farther means hidden.
 * Moving the observer only moves the light, so the map updates every frame while you drag.
 */

export interface ViewshedState {
  /** Ground point under the observer. */
  lon: number;
  lat: number;
  ground: number;
  /** Eye height above that ground, metres. */
  height: number;
  /** Analysis radius, metres. */
  radius: number;
}

const FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform samplerCube shadowCube;
uniform vec4 lightPositionEC;
uniform vec4 visibleColor;
uniform vec4 hiddenColor;
uniform float strength;
uniform float debugMode;
uniform float mapSize;
in vec2 v_textureCoordinates;

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  // Raw (logarithmic) depth; czm_windowToEyeCoordinates undoes it and puts 1/depth in w.
  float depth = texture(depthTexture, v_textureCoordinates).r;
  if (depth >= 1.0) { out_FragColor = color; return; }
  vec4 positionEC = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
  positionEC /= positionEC.w;
  vec3 toFrag = positionEC.xyz - lightPositionEC.xyz;
  float dist = length(toFrag);
  float radius = lightPositionEC.w;
  if (dist > radius) { out_FragColor = color; return; }
  vec3 dirWC = czm_inverseViewRotation * normalize(toFrag);
  float stored = czm_unpackDepth(czm_textureCube(shadowCube, dirWC));
  // Slope-scaled bias. One cube texel spans about 2/size radians, so at a grazing angle the
  // stored distance of neighbouring texels differs by dist * texel / cos(angle). Without
  // this, flat ground far from a low observer shows false "hidden" stripes.
  vec3 n = normalize(cross(dFdx(positionEC.xyz), dFdy(positionEC.xyz)));
  float cosA = abs(dot(n, normalize(toFrag)));
  float texel = 2.0 / mapSize;
  float bias = (0.3 + dist * texel * 1.5 / max(cosA, 0.06)) / radius;
  float visible = step(dist / radius - bias, stored);
  if (debugMode > 2.5) { float df = stored * radius - dist; out_FragColor = vec4(clamp(-df/20.0,0.0,1.0), clamp(df/20.0,0.0,1.0), abs(df) < 1.0 ? 1.0 : 0.0, 1.0); return; }
  if (debugMode > 0.5) { float v = debugMode > 1.5 ? dist / radius : stored; out_FragColor = vec4(fract(v*10.0), v, visible, 1.0); return; }
  vec4 tint = mix(hiddenColor, visibleColor, visible);
  // Soft edge at the radius so the analysis area reads as a disc.
  float edge = smoothstep(radius, radius * 0.985, dist);
  // Desaturate the scene a little so the tint reads the same on red roofs and green parks.
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 base = mix(color.rgb, vec3(lum), 0.55 * edge);
  out_FragColor = vec4(mix(base, tint.rgb, strength * tint.a * edge), color.a);
  if (dist > radius * 0.992) out_FragColor.rgb = mix(out_FragColor.rgb, vec3(1.0), 0.65);
}
`;

export class Viewshed {
  readonly state = signal<ViewshedState | null>(null);
  /** Waiting for the click that places the observer. */
  readonly placing = signal(false);
  readonly dragging = signal(false);
  /** The visible area within the radius, on the ground, once asked for. */
  readonly area = signal<ViewshedArea | null>(null);
  /** Development aid: 1 shows the cube depth, 2 the fragment distance. */
  debugMode = 0;
  /** Cube face size in pixels; set from the quality preset. */
  mapSize = 2048;

  private shadowMap: ShadowMap | null = null;
  private stage: PostProcessStage | null = null;
  private lightCamera: Camera;
  private hook: { update: (fs: { shadowMaps: ShadowMap[] }) => void; isDestroyed: () => boolean; destroy: () => void } | null = null;
  private eye: Entity | null = null;
  private pole: Entity | null = null;
  private prevGlobeShadows: ShadowMode | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly entities: EntityCollection,
    private readonly sampleGround?: (pts: Cartographic[]) => Promise<Cartographic[]>,
  ) {
    this.lightCamera = new Camera(scene);
  }

  start(): void {
    this.placing.set(true);
  }

  /** Place (or move) the observer on a picked surface point. */
  place(p: Cartesian3): void {
    const c = Cartographic.fromCartesian(p);
    const prev = this.state.get();
    this.placing.set(false);
    this.set({
      lon: (c.longitude * 180) / Math.PI,
      lat: (c.latitude * 180) / Math.PI,
      ground: c.height,
      height: prev?.height ?? 10,
      radius: prev?.radius ?? 800,
    });
  }

  set(s: ViewshedState): void {
    this.state.set(s);
    if (this.area.get()) this.area.set(null);
    this.ensure();
    this.update();
  }

  setHeight(h: number): void {
    const s = this.state.get();
    if (s) this.set({ ...s, height: Math.max(0.5, Math.min(2000, h)) });
  }

  setRadius(r: number): void {
    const s = this.state.get();
    if (!s) return;
    // The radius is baked into the shadow map, so it is rebuilt.
    this.disposeGpu();
    this.set({ ...s, radius: Math.max(50, Math.min(20000, r)) });
  }

  isObserver(id: unknown): boolean {
    return id === this.eye || id === this.pole;
  }

  /**
   * Works out the visible area on the ground within the radius, on a UTM grid of about 400 cells
   * across, as gdal_viewshed would on the same ground (terrain or the user's DEM). Buildings and
   * models are left out, as they have no heights on a grid; the overlay shows them.
   */
  async computeArea(): Promise<ViewshedArea | null> {
    const s = this.state.get();
    if (!s || !this.sampleGround) return null;
    this.area.set({ for: s, computing: true, result: null, frame: null });
    try {
      const cell = viewshedCellFor(s.radius);
      const f = viewshedGridFrame(s.lon, s.lat, s.radius, cell);
      const pts = f.centres().map((p) => Cartographic.fromDegrees(p.lon, p.lat));
      const ground = await this.sampleGround(pts);
      const heights = Float64Array.from(ground, (c) => c.height);
      const result = computeViewshedGrid({ size: f.size, cell, heights }, s.ground + s.height, s.radius);
      const done: ViewshedArea = { for: s, computing: false, result, frame: { epsg: f.epsg, easting: f.easting, northing: f.northing } };
      // Only if the observer has not moved meanwhile.
      if (this.state.get() === s) this.area.set(done);
      return done;
    } catch (e) {
      const failed: ViewshedArea = { for: s, computing: false, result: null, frame: null, error: e instanceof Error ? e.message : String(e) };
      if (this.state.get() === s) this.area.set(failed);
      return failed;
    }
  }

  /** The computed area as a GeoTIFF (1 seen, 0 hidden, 255 outside the radius). */
  async areaGeoTiff(): Promise<ArrayBuffer | null> {
    const a = this.area.get();
    return a?.result && a.frame ? viewshedToGeoTiff(a.result, a.frame) : null;
  }

  clear(): void {
    this.area.set(null);
    this.placing.set(false);
    this.dragging.set(false);
    this.state.set(null);
    this.disposeGpu();
    if (this.eye) this.entities.remove(this.eye);
    if (this.pole) this.entities.remove(this.pole);
    this.eye = this.pole = null;
    if (this.prevGlobeShadows !== null && this.scene.globe) this.scene.globe.shadows = this.prevGlobeShadows;
    this.prevGlobeShadows = null;
  }

  private eyePosition(s: ViewshedState): Cartesian3 {
    return Cartesian3.fromDegrees(s.lon, s.lat, s.ground + s.height);
  }

  private ensure(): void {
    const s = this.state.get();
    if (!s) return;
    const scene = this.scene;
    if (this.prevGlobeShadows === null) {
      this.prevGlobeShadows = scene.globe.shadows;
      scene.globe.shadows = ShadowMode.ENABLED; // terrain must block the view too
    }
    if (!this.shadowMap) {
      // ShadowMap is not public API in CesiumJS; pinned version 1.146 (plan 3.7). Covered by the WP 2.9 tests.
      const SM = ShadowMap as unknown as new (o: Record<string, unknown>) => ShadowMap;
      this.shadowMap = new SM({
        context: (scene as unknown as { context: unknown }).context,
        lightCamera: this.lightCamera,
        isPointLight: true,
        pointLightRadius: s.radius,
        cascadesEnabled: false,
        size: this.mapSize,
        softShadows: false,
        normalOffset: false,
        fromLightSource: false,
        darkness: 1.0, // do not darken normal shading; the post-process draws the result
        enabled: true,
      });
      const sm = this.shadowMap;
      this.hook = {
        update: (fs) => {
          if (this.state.get()) fs.shadowMaps.push(sm);
        },
        isDestroyed: () => false,
        destroy: () => undefined,
      };
      scene.primitives.add(this.hook as never);
    }
    if (!this.stage) {
      const sm = this.shadowMap as unknown as { _shadowMapTexture: unknown; _lightPositionEC: unknown };
      this.stage = new PostProcessStage({
        name: "viewer_viewshed",
        fragmentShader: FS,
        uniforms: {
          shadowCube: () => sm._shadowMapTexture,
          lightPositionEC: () => sm._lightPositionEC,
          visibleColor: Color.fromCssColorString("#3DD68C").withAlpha(1),
          hiddenColor: Color.fromCssColorString("#FF4D57").withAlpha(1),
          strength: 0.5,
          debugMode: () => this.debugMode,
          mapSize: () => this.mapSize,
        },
      });
      scene.postProcessStages.add(this.stage);
    }
    if (!this.eye) {
      this.eye = this.entities.add({
        id: "viewshed:eye",
        position: new ConstantPositionProperty(Cartesian3.ZERO),
        point: { pixelSize: 16, color: Color.WHITE, outlineColor: Color.fromCssColorString("#F05BDC"), outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      this.pole = this.entities.add({
        id: "viewshed:pole",
        polyline: { positions: [Cartesian3.ZERO, Cartesian3.UNIT_X], width: 2, material: new ColorMaterialProperty(Color.WHITE) },
      });
    }
  }

  private update(): void {
    const s = this.state.get();
    if (!s || !this.eye || !this.pole) return;
    const eye = this.eyePosition(s);
    Cartesian3.clone(eye, this.lightCamera.position);
    (this.eye.position as ConstantPositionProperty).setValue(eye);
    this.pole.polyline!.positions = new ConstantProperty([Cartesian3.fromDegrees(s.lon, s.lat, s.ground), eye]);
    void HeightReference;
    this.scene.requestRender();
  }

  private disposeGpu(): void {
    if (this.stage) {
      this.scene.postProcessStages.remove(this.stage);
      this.stage = null;
    }
    if (this.hook) {
      this.scene.primitives.remove(this.hook as never);
      this.hook = null;
    }
    if (this.shadowMap) {
      (this.shadowMap as unknown as { destroy: () => void }).destroy();
      this.shadowMap = null;
    }
  }
}
