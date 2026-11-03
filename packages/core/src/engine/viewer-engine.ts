import {
  Axis,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Matrix3,
  ImageBasedLighting,
  Cartographic,
  Cesium3DTileset,
  type Cesium3DTile,
  OrientedBoundingBox,
  CesiumWidget,
  Color,
  CustomShader,
  HeadingPitchRange,
  HeadingPitchRoll,
  ImageryLayer,
  Ion,
  JulianDate,
  LightingModel,
  Math as CMath,
  Matrix4,
  Model,
  NearFarScalar,
  PostProcessStageLibrary,
  type PostProcessStage,
  type PostProcessStageComposite,
  ScreenSpaceEventType,
  ShadowMode,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  type TerrainProvider,
  sampleTerrain,
  sampleTerrainMostDetailed,
  Tonemapper,
  Transforms,
  HorizontalOrigin,
  VerticalOrigin,
  LabelStyle,
  Entity,
  HeightReference,
  DistanceDisplayCondition,
} from "cesium";
import type { BaseMapConfig, ModelSummary, UpdateStatus } from "@viewer/shared";
import { CameraController } from "./camera-controller";
import { MeasureTool } from "./measure-tool";
import { FlyByTour, FlyMode, captureViewpoint, type Viewpoint } from "./fly";
import { signal } from "../signal";
import { effectiveVisibility, layersFromGltf, type Layer } from "../layers/layers";
import { applySiteConfig, catalogue, makeBaseLayers } from "./basemaps";
import { ENVIRONMENTS, environmentSh, environmentSpecular, type EnvironmentId } from "./environments";
import { cubeToKtx2 } from "./ktx2";
import { asLayerable, createLayeredTerrain, type DemSource } from "./terrain";
import { captureUnderside, coverage, groundCut, MIN_COVERAGE, mergeUndersides, type Underside } from "./ground-cut";
import { SightlineTool } from "./sightline";
import { Viewshed } from "./viewshed";
import { UserLayers } from "./user-layers";
import { LodInspector } from "./lod-inspector";

export type ViewMode = "shaded" | "edges" | "wireframe" | "unlit";
export type Quality = "low" | "balanced" | "high" | "ultra";
export type PresetView = "top" | "front" | "back" | "left" | "right" | "iso";

export interface CursorInfo {
  lat: number;
  lon: number;
  height: number;
  onModel: boolean;
}

export interface CameraInfo {
  heading: number; // radians
  pitch: number; // radians
  metresPerPixel: number;
  height: number; // camera height above ellipsoid, metres
}

export interface OpenError {
  file: string;
  reason: string;
  detail: string;
}

const STATUS_COLOURS: Record<UpdateStatus, string> = {
  draft: "#A7ADB8",
  inProduction: "#F2B33D",
  current: "#3DD68C",
  superseded: "#8F98A8",
};

/**
 * The only class in the product that talks to CesiumJS. The UI drives it through
 * plain methods and reads per-frame state from signals (plan section 2.3).
 */
/**
 * Camera heading and pitch (degrees) that look at a target from direction `dir` (east, north, up).
 * Level views tilt down 5° so the ground stays readable; straight up or down stops just short of 90°.
 */
export function cubeView([e, n, u]: [number, number, number]): { heading: number; pitch: number } {
  const flat = Math.hypot(e, n);
  const heading = flat < 1e-9 ? 0 : ((Math.atan2(-e, -n) * 180) / Math.PI + 360) % 360;
  let pitch = (-Math.atan2(u, flat) * 180) / Math.PI;
  if (Math.abs(u) < 1e-9) pitch = -5;
  pitch = Math.max(-89.9, Math.min(89.9, pitch));
  return { heading: Math.abs(heading) < 1e-9 ? 0 : heading, pitch };
}

/** Screen-space error per quality preset: lower draws finer tiles (WP 1.5). */
const SSE: Record<Quality, number> = { low: 24, balanced: 16, high: 8, ultra: 4 };

export class ViewerEngine {
  readonly widget: CesiumWidget;
  readonly camera: CameraController;
  readonly measure: MeasureTool;
  readonly fly: FlyMode;
  readonly tour: FlyByTour;
  readonly sight: SightlineTool;
  readonly viewshed: Viewshed;
  readonly userLayers: UserLayers;
  readonly lod: LodInspector;

  readonly cursor = signal<CursorInfo | null>(null);
  readonly cameraInfo = signal<CameraInfo>({ heading: 0, pitch: -0.5, metresPerPixel: 1, height: 0 });
  readonly fps = signal(0);
  /** Numbers for the performance overlay (Shift+P), refreshed twice a second (WP 1.5). */
  readonly perf = signal<PerfStats | null>(null);
  /** Lower the render resolution while frames are slow, and restore it when they are fast (NFR-03). */
  adaptiveResolution = true;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private baseScale = 1;
  readonly layers = signal<Layer[]>([]);
  readonly loading = signal(false);
  readonly error = signal<OpenError | null>(null);
  readonly current = signal<ModelSummary | null>(null);
  readonly viewMode = signal<ViewMode>("shaded");
  readonly viewpoints = signal<Viewpoint[]>([]);
  readonly baseMapId = signal("bundled");
  readonly terrainId = signal("none");
  /** Lighting environment for models and tilesets (WP 1.4). */
  readonly environment = signal<EnvironmentId>("atmosphere");
  /** GPU memory for 3D Tiles, shared by every open tileset (WP 1.5, NFR-04). */
  private memoryBudget = 2 * 1024 ** 3;
  /** Vertical shift applied to a 3D Tiles dataset to meet the terrain, metres. */
  readonly groundOffset = signal(0);
  private userDems: DemSource[] = [];
  /** The chosen terrain as its source gives it, before DEMs and the ground cut. */
  private terrainBase: TerrainProvider = new EllipsoidTerrainProvider();
  /** The ground: the chosen terrain with the user's DEMs. Heights are sampled from this. */
  private groundTerrain: TerrainProvider = this.terrainBase;
  /** Terrain lowered under the open model so it never shows through it (WP 1.6). */
  private cut: { source: DemSource; offset: number; u: Underside } | null = null;
  private cutRefineTimer: ReturnType<typeof setTimeout> | null = null;
  private offTilesLoaded: (() => void) | null = null;
  private cutTimer: ReturnType<typeof setTimeout> | null = null;
  private cutRun = 0;

  private model: Model | null = null;
  private tileset: Cesium3DTileset | null = null;
  private edges: PostProcessStageComposite | PostProcessStage | null = null;
  private pins: Entity[] = [];
  private pivotMarker: Entity | null = null;
  private onPinClick: ((id: string) => void) | null = null;
  private baseLayers: ImageryLayer[] = [];
  private baseShown = true;
  /** Ground height under a glTF model before the user's offset. */
  private modelBaseHeight = 0;
  private frames = 0;
  private lastFpsTime = performance.now();
  private quality: Quality = "high";
  private shadowsWanted = true;

  static async create(container: HTMLElement): Promise<ViewerEngine> {
    // No Cesium ion, no Bing, no external requests: everything is bundled (NFR-12).
    Ion.defaultAccessToken = "";
    const [base] = await makeBaseLayers("bundled");
    const engine = new ViewerEngine(container, base!);
    // Prototype defaults: the offline demo imagery and terrain, so models sit on real ground
    // with no network. The deployment config picks internal sources instead (WP 3.9).
    await engine.setBaseMap("local-s2");
    await engine.setTerrain("local");
    return engine;
  }

  private constructor(container: HTMLElement, baseLayer: ImageryLayer) {
    const credits = document.createElement("div");
    credits.style.display = "none";
    this.widget = new CesiumWidget(container, {
      baseLayer,
      creditContainer: credits,
      shadows: true,
      msaaSamples: 4,
      scene3DOnly: true,
      requestRenderMode: false,
      useBrowserRecommendedResolution: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true, powerPreference: "high-performance" } },
    });
    this.baseLayers = [baseLayer];
    const scene = this.widget.scene;
    scene.postProcessStages.fxaa.enabled = true;
    scene.postProcessStages.tonemapper = Tonemapper.PBR_NEUTRAL;
    scene.highDynamicRange = true;
    scene.pickTranslucentDepth = true;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.baseColor = Color.fromCssColorString("#3A3B36");
    scene.backgroundColor = Color.fromCssColorString("#0E0F12");
    scene.shadowMap.softShadows = true;
    scene.shadowMap.size = 4096;
    scene.shadowMap.darkness = 0.35;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    // Fixed late-morning sun (UTC 08:30 ≈ 10:30 local in the region) for readable shadows.
    const now = new Date();
    this.widget.clock.currentTime = JulianDate.fromDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 30)));
    this.widget.clock.shouldAnimate = false;

    // Remove Cesium's default double-click "track entity" behaviour.
    this.widget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this.camera = new CameraController({
      scene,
      canvas: this.widget.canvas,
      pick: (p) => this.pick(p),
      isToolActive: () => this.measure.active.get() !== null || this.sight.active.get() || this.viewshed.placing.get() || this.viewshed.dragging.get(),
      onPivotSet: (p) => this.showPivot(p),
    });
    this.camera.onMoveStart = () => this.setMovingQuality(true);
    this.camera.onMoveEnd = () => this.setMovingQuality(false);
    this.measure = new MeasureTool(this.widget.entities, () => scene.requestRender());
    this.fly = new FlyMode(scene, this.widget.canvas);
    this.tour = new FlyByTour(scene);
    this.sight = new SightlineTool(scene, this.widget.entities, (pts) => this.sampleGround(pts));
    this.viewshed = new Viewshed(scene, this.widget.entities);
    this.lod = new LodInspector(scene);
    this.userLayers = new UserLayers(
      this.widget,
      (shown) => this.setBaseImagery(shown),
      async (dems) => {
        this.userDems = dems;
        await this.setTerrain(this.terrainId.get());
      },
    );

    this.bindPointer();
    scene.postRender.addEventListener(() => this.afterFrame());
    this.flyHome(0);
  }

  destroy(): void {
    this.fly.disable();
    this.tour.stop();
    this.camera.destroy();
    this.widget.destroy();
  }

  // ---------- models ----------

  async open(summary: ModelSummary, opts: { fly?: boolean } = {}): Promise<void> {
    this.close();
    this.current.set(summary);
    this.loading.set(true);
    this.error.set(null);
    const scene = this.widget.scene;
    try {
      if (summary.source.kind === "3dtiles") {
        const tileset = await Cesium3DTileset.fromUrl(summary.source.url, {
          maximumScreenSpaceError: SSE[this.quality],
          cacheBytes: this.memoryBudget,
          maximumCacheOverflowBytes: this.memoryBudget / 2,
          imageBasedLighting: this.makeIbl(),
          shadows: ShadowMode.ENABLED,
        });
        if (this.current.get()?.id !== summary.id) return tileset.destroy();
        scene.primitives.add(tileset);
        this.tileset = tileset;
        // Finer tiles can hold ground the first capture did not see: refine the cut as they load.
        this.offTilesLoaded = tileset.allTilesLoaded.addEventListener(() => this.scheduleGroundCutRefine());
        this.lod.attach(tileset);
        this.layers.set([{ id: "tileset", name: summary.name, children: [], visible: true }]);
        if (summary.source.localFrame && summary.placement) {
          // A tileset in local coordinates: placed like a model, from the upload's Place step.
          this.modelBaseHeight = await this.placementHeight(summary.placement);
          this.groundOffset.set(0);
          tileset.modelMatrix = placeMatrix(summary.placement, this.modelBaseHeight);
        } else void this.fitTilesetToGround(tileset, summary).then(() => this.updateGroundCut());
      } else {
        const place = summary.placement ?? { ...summary.centre, height: 0 };
        const height = await this.placementHeight(place);
        this.modelBaseHeight = height;
        this.groundOffset.set(0);
        let gltfJson: unknown = null;
        const model = await Model.fromGltfAsync({
          url: summary.source.url,
          modelMatrix: placeMatrix(place, height, place.upAxis === "z"),
          scale: place.scale ?? 1,
          upAxis: place.upAxis === "z" ? Axis.Z : Axis.Y,
          forwardAxis: place.upAxis === "z" ? Axis.X : Axis.Z,
          shadows: ShadowMode.ENABLED,
          enableDebugWireframe: true,
          imageBasedLighting: this.makeIbl(),
          gltfCallback: (g) => {
            gltfJson = g;
          },
        });
        if (this.current.get()?.id !== summary.id) return model.destroy();
        scene.primitives.add(model);
        this.model = model;
        await new Promise<void>((resolve, reject) => {
          if (model.ready) return resolve();
          const off1 = model.readyEvent.addEventListener(() => { off1(); off2(); resolve(); });
          const off2 = model.errorEvent.addEventListener((e: unknown) => { off1(); off2(); reject(e); });
        });
        this.layers.set(gltfJson ? layersFromGltf(gltfJson as Parameters<typeof layersFromGltf>[0]) : []);
      }
      this.setLocalTime(summary.centre.lon, 10.5);
      this.applyViewMode(this.viewMode.get());
      this.applyPinVisibility();
      // The model's bounding sphere is final only after its first update, so render once first.
      this.widget.render();
      // A tileset that is fitted to the ground gets its cut after the fit.
      if (summary.source.kind !== "3dtiles" || summary.source.localFrame) void this.updateGroundCut();
      if (opts.fly !== false) await this.home(1.6);
      else await this.home(0);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.error.set({
        file: summary.source.url.split("/").pop() ?? summary.source.url,
        reason: friendlyReason(err),
        detail: `${err.name}: ${err.message}`,
      });
      this.current.set(summary);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.tour.stop();
    this.measure.cancel();
    this.measure.clear();
    this.sight.cancel();
    this.sight.clear();
    this.viewshed.clear();
    this.lod.attach(null);
    if (this.model) this.widget.scene.primitives.remove(this.model);
    if (this.tileset) this.widget.scene.primitives.remove(this.tileset);
    this.model = null;
    this.tileset = null;
    this.layers.set([]);
    this.current.set(null);
    this.error.set(null);
    this.applyPinVisibility();
    this.cutRun++;
    this.offTilesLoaded?.();
    this.offTilesLoaded = null;
    if (this.cutRefineTimer) clearTimeout(this.cutRefineTimer);
    if (this.cut) {
      this.cut = null;
      this.applyTerrain();
    }
  }

  boundingSphere(): BoundingSphere | null {
    return this.model?.boundingSphere ?? this.tileset?.boundingSphere ?? null;
  }

  // ---------- camera ----------

  async home(duration = 1.2): Promise<void> {
    const bs = this.boundingSphere();
    if (!bs) return this.flyHome(duration);
    Cartesian3.clone(bs.center, this.camera.pivot);
    await this.flySphere(bs, CMath.toRadians(35), CMath.toRadians(-28), duration);
  }

  /** Whole-region view used before any model is open (Earth workspace). */
  flyHome(duration = 1.5): void {
    this.widget.camera.flyTo({
      destination: Cartesian3.fromDegrees(34.9, 30.2, 4_200_000),
      orientation: { heading: 0, pitch: CMath.toRadians(-80), roll: 0 },
      duration,
    });
    Cartesian3.clone(Cartesian3.fromDegrees(34.9, 31.4, 0), this.camera.pivot);
  }

  async focusLayer(_layerId: string): Promise<void> {
    // Per-node bounds need runtime node data; for now focus fits the whole model.
    await this.home(0.8);
  }

  /** Looks at the model from a direction in east, north, up: a face, edge or corner of the view cube (NAV-05). */
  async viewFrom(dir: [number, number, number]): Promise<void> {
    const bs = this.boundingSphere() ?? new BoundingSphere(this.camera.pivot, 200);
    const { heading, pitch } = cubeView(dir);
    await this.flySphere(bs, CMath.toRadians(heading), CMath.toRadians(pitch), 0.8);
  }

  async preset(view: PresetView): Promise<void> {
    const bs = this.boundingSphere() ?? new BoundingSphere(this.camera.pivot, 200);
    const h = { top: 0, front: 0, back: 180, left: 90, right: 270, iso: 45 }[view];
    const p = { top: -89.9, front: -5, back: -5, left: -5, right: -5, iso: -35 }[view];
    await this.flySphere(bs, CMath.toRadians(h), CMath.toRadians(p), 0.8);
  }

  flyTo(lat: number, lon: number, height = 1500): void {
    this.tour.stop();
    this.widget.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, height), duration: 1.6 });
    Cartesian3.clone(Cartesian3.fromDegrees(lon, lat, 0), this.camera.pivot);
  }

  private flySphere(bs: BoundingSphere, heading: number, pitch: number, duration: number): Promise<void> {
    return new Promise((resolve) => {
      const range = Math.max(bs.radius * 3.1, 3);
      this.widget.camera.flyToBoundingSphere(bs, {
        offset: new HeadingPitchRange(heading, pitch, range),
        duration,
        complete: () => resolve(),
        cancel: () => resolve(),
      });
    });
  }

  saveViewpoint(): void {
    this.viewpoints.set([...this.viewpoints.get(), captureViewpoint(this.widget.camera)]);
  }

  clearViewpoints(): void {
    this.viewpoints.set([]);
  }

  startOrbitTour(): void {
    const bs = this.boundingSphere();
    if (bs) this.tour.orbit(bs);
  }

  startViewpointTour(): void {
    void this.tour.viewpoints(this.viewpoints.get());
  }

  // ---------- rendering ----------

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
    this.applyViewMode(mode);
  }

  private applyViewMode(mode: ViewMode): void {
    const unlit = mode === "unlit" ? new CustomShader({ lightingModel: LightingModel.UNLIT }) : undefined;
    if (this.model) {
      this.model.debugWireframe = mode === "wireframe";
      this.model.customShader = unlit as CustomShader;
    }
    if (this.tileset) {
      this.tileset.debugWireframe = mode === "wireframe";
      this.tileset.customShader = unlit;
    }
    const stages = this.widget.scene.postProcessStages;
    if (mode === "edges" && !this.edges) {
      const edge = PostProcessStageLibrary.createEdgeDetectionStage();
      edge.uniforms.color = Color.fromCssColorString("#0B0C0E").withAlpha(0.9);
      edge.uniforms.length = 0.6;
      this.edges = stages.add(PostProcessStageLibrary.createSilhouetteStage([edge]));
    }
    if (this.edges) this.edges.enabled = mode === "edges";
    this.widget.scene.requestRender();
  }

  /** Puts the sun where it is at the given local solar hour over a longitude (readable light by default). */
  setLocalTime(lon: number, localHour: number): void {
    const now = new Date();
    const utcHours = localHour - lon / 15;
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0));
    d.setUTCMinutes(Math.round(utcHours * 60));
    this.widget.clock.currentTime = JulianDate.fromDate(d);
  }

  setShadows(on: boolean): void {
    this.shadowsWanted = on;
    this.widget.scene.shadowMap.enabled = on;
  }

  setBaseImagery(on: boolean): void {
    this.baseShown = on;
    for (const l of this.baseLayers) l.show = on;
  }

  /** Swap the base map (VWR-GEO-01). User layers above it are kept. */
  async setBaseMap(id: string): Promise<void> {
    const def = catalogue.get().baseMaps.find((b) => b.id === id);
    if (!def) return;
    const layers = await makeBaseLayers(id);
    const coll = this.widget.imageryLayers;
    for (const l of this.baseLayers) coll.remove(l, true);
    layers.forEach((l, i) => {
      l.show = this.baseShown;
      coll.add(l, i);
    });
    this.baseLayers = layers;
    this.baseMapId.set(id);
    this.applyPinVisibility();
  }

  /**
   * This site's base map sources from the server (WP 3.9). They join the pickers, and the
   * admin's defaults are shown. A source that fails to load leaves the current one in place.
   */
  async useSiteBaseMaps(cfg: BaseMapConfig, serverBase: string): Promise<string[]> {
    applySiteConfig(cfg, serverBase);
    const problems: string[] = [];
    const { baseMaps, terrains } = catalogue.get();
    const imagery = cfg.defaultImagery && baseMaps.some((b) => b.id === cfg.defaultImagery) ? cfg.defaultImagery : baseMaps.some((b) => b.id === this.baseMapId.get()) ? null : "bundled";
    const terrain = cfg.defaultTerrain && terrains.some((t) => t.id === cfg.defaultTerrain) ? cfg.defaultTerrain : terrains.some((t) => t.id === this.terrainId.get()) ? null : "none";
    if (imagery) await this.setBaseMap(imagery).catch((e) => problems.push(`Base map "${imagery}": ${e instanceof Error ? e.message : e}`));
    if (terrain) await this.setTerrain(terrain).catch((e) => problems.push(`Terrain "${terrain}": ${e instanceof Error ? e.message : e}`));
    return problems;
  }

  /** Swap the terrain (VWR-GEO-01) and put the open model back on the ground. */
  async setTerrain(id: string): Promise<void> {
    const def = catalogue.get().terrains.find((t) => t.id === id);
    if (!def) return;
    this.terrainBase = await def.create();
    this.cut = null;
    this.terrainId.set(id);
    this.applyTerrain();
    await this.placeOnGround();
  }

  /**
   * Builds the terrain the globe draws: the chosen terrain, the user's elevation GeoTIFFs
   * over it (inside their footprints they replace it), and the ground cut under the open model.
   */
  private applyTerrain(): void {
    const base = this.terrainBase;
    const layerable = this.userDems.length || this.cut ? asLayerable(base) : null;
    this.groundTerrain = this.userDems.length ? createLayeredTerrain(layerable, this.userDems) : base;
    const cut = this.cut && layerable ? [this.cut.source] : [];
    this.widget.scene.terrainProvider = cut.length || this.userDems.length ? createLayeredTerrain(layerable, [...this.userDems, ...cut]) : base;
  }

  /**
   * Lowers the terrain under the open model to just below the model's lowest surface, so the
   * terrain cannot show through it (VWR-GEO-01). Waits for the model's tiles first.
   */
  private async updateGroundCut(): Promise<void> {
    const run = ++this.cutRun;
    const target = this.tileset ?? this.model;
    const had = !!this.cut;
    this.cut = null;
    if (!target || this.terrainBase instanceof EllipsoidTerrainProvider || !(this.terrainBase.tilingScheme instanceof GeographicTilingScheme || "tileHeights" in this.terrainBase)) {
      if (had) this.applyTerrain();
      return;
    }
    if (this.tileset && !this.tileset.tilesLoaded) {
      const t = this.tileset;
      await new Promise<void>((resolve) => {
        const off = t.allTilesLoaded.addEventListener(() => (off(), clearTimeout(timer), resolve()));
        const timer = setTimeout(() => (off(), resolve()), 8000);
      });
    }
    const u = await this.captureGround(target, () => run === this.cutRun && (this.tileset ?? this.model) === target);
    if (run !== this.cutRun || (this.tileset ?? this.model) !== target) return;
    if (!u) {
      if (had) this.applyTerrain();
      return;
    }
    this.setCut(u, this.groundOffset.get());
  }

  /** The model's underside, retried a few frames apart if a capture comes out empty. */
  private async captureGround(target: Model | Cesium3DTileset, current: () => boolean): Promise<Underside | null> {
    let best: Underside | null = null;
    for (let i = 0; i < 4 && current(); i++) {
      await this.afterFrames(2);
      if (!current()) break;
      const u = captureUnderside(this.widget.scene, target, () => this.widget.render());
      if (coverage(u) > coverage(best)) best = u;
      if (coverage(best) >= MIN_COVERAGE) break;
    }
    return best;
  }

  /** Resolves after `n` frames have been drawn (or after a second, if nothing is drawing). */
  private afterFrames(n: number): Promise<void> {
    return new Promise((resolve) => {
      let left = n;
      const done = () => (off(), clearTimeout(timer), setTimeout(resolve, 0));
      const off = this.widget.scene.postRender.addEventListener(() => --left <= 0 && done());
      const timer = setTimeout(done, 1000);
    });
  }

  private setCut(u: Underside, offset: number): void {
    const cut = { offset, u, source: null as unknown as DemSource };
    cut.source = groundCut(u, () => this.groundOffset.get() - cut.offset);
    this.cut = cut;
    this.applyTerrain();
  }

  /**
   * Once newly loaded tiles settle, capture again and keep the lower of the two. The terrain
   * is rebuilt only if that uncovers ground the cut missed, so most refines change nothing.
   */
  private scheduleGroundCutRefine(): void {
    if (!this.cut || !this.tileset) return;
    if (this.cutRefineTimer) clearTimeout(this.cutRefineTimer);
    this.cutRefineTimer = setTimeout(async () => {
      this.cutRefineTimer = null;
      const cut = this.cut, t = this.tileset;
      if (!cut || !t) return;
      const u = await this.captureGround(t, () => this.cut === cut && this.tileset === t);
      if (!u || coverage(u) < MIN_COVERAGE || this.cut !== cut) return;
      const merged = mergeUndersides(cut.u, u);
      // The canvas changed size: start again from this capture.
      if (merged === "incompatible") this.setCut(u, this.groundOffset.get());
      else if (merged !== "unchanged") this.setCut(merged, cut.offset);
    }, 1200);
  }

  /** The cut follows the model when the user moves it up or down; rebuilt once they stop. */
  private scheduleGroundCutShift(): void {
    if (!this.cut) return;
    if (this.cutTimer) clearTimeout(this.cutTimer);
    this.cutTimer = setTimeout(() => {
      this.cutTimer = null;
      if (this.cut) this.applyTerrain();
    }, 400);
  }

  /**
   * Terrain heights at points. Uses the most detailed tiles when the provider knows its
   * availability (quantized-mesh), otherwise a fixed deep level (heightmap sources).
   */
  async sampleGround(points: Cartographic[], level = 14): Promise<Cartographic[]> {
    // The ground itself, not the cut the globe draws under the open model.
    const tp = this.groundTerrain;
    if (tp instanceof EllipsoidTerrainProvider) return points.map((p) => ((p.height = 0), p));
    return tp.availability ? sampleTerrainMostDetailed(tp, points) : sampleTerrain(tp, level, points);
  }

  /** The point on the globe at the centre of the view, used as the default place for uploads. */
  viewCentre(): { lat: number; lon: number } | null {
    const scene = this.widget.scene;
    const c = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    const p = scene.camera.pickEllipsoid(c);
    if (!p) return null;
    const g = Cartographic.fromCartesian(p);
    return { lat: CMath.toDegrees(g.latitude), lon: CMath.toDegrees(g.longitude) };
  }

  /** Model height from its placement: terrain height + aboveGround when terrain is on. */
  private async placementHeight(place: NonNullable<ModelSummary["placement"]>): Promise<number> {
    if (place.aboveGround === undefined || this.groundTerrain instanceof EllipsoidTerrainProvider) return place.height;
    try {
      const [c] = await this.sampleGround([Cartographic.fromDegrees(place.lon, place.lat)]);
      return c && Number.isFinite(c.height) ? c.height + place.aboveGround : place.height;
    } catch {
      return place.height;
    }
  }

  /** Put the open model back on the ground: automatic fit, offset reset to zero. */
  async placeOnGround(): Promise<void> {
    const m = this.current.get();
    if (this.tileset && m && !m.source.localFrame) await this.fitTilesetToGround(this.tileset, m);
    else if ((this.model || this.tileset) && m?.placement) {
      this.modelBaseHeight = await this.placementHeight(m.placement);
      this.setGroundOffset(0);
    }
    this.sight.recomputeAll();
    await this.updateGroundCut();
  }

  /**
   * Make a georeferenced city meet the terrain (VWR-GEO-01). Datasets often use another
   * height datum than the terrain (orthometric vs ellipsoidal, or a local datum), which
   * leaves them floating or buried by tens of metres. We sample the dataset's surface and
   * the terrain on a grid over its footprint and shift the dataset so its streets (the low
   * surfaces) sit on the terrain. The shift is shown in Properties and can be adjusted.
   */
  private async fitTilesetToGround(tileset: Cesium3DTileset, summary: ModelSummary): Promise<void> {
    this.setGroundOffset(0);
    if (this.terrainId.get() === "none") return;
    if (summary.source.groundFit === "surface") return this.fitSurfaceToGround(tileset);
    if (summary.source.groundFit !== "street") return;
    // Cities: the lowest surfaces the camera can hit are streets and squares. Tile bounding
    // boxes are no help here: they reach far below the streets, which lifted Lyon ~80 m.
    return this.fitSurfaceToGround(tileset, 0.1, 1);
  }

  /**
   * Fit for lidar and photogrammetry, which have ground points everywhere: sample the
   * dataset's own surface (globe hidden) and the terrain on a grid, and move the dataset so
   * its lower surfaces (bare ground, not tree tops or roofs) meet the terrain.
   */
  private async fitSurfaceToGround(tileset: Cesium3DTileset, quantile = 0.5, minOffset = 8): Promise<void> {
    const scene = this.widget.scene;
    const bs = tileset.boundingSphere;
    const c = Cartographic.fromCartesian(bs.center);
    const r = bs.radius * 0.5;
    const dLat = r / 6371000;
    const dLon = dLat / Math.cos(c.latitude);
    const pts: Cartographic[] = [];
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) pts.push(new Cartographic(c.longitude + (dLon * i) / 4, c.latitude + (dLat * j) / 4));
    const globeShown = scene.globe.show;
    scene.globe.show = false;
    let surf: (Cartographic | undefined)[] = [];
    try {
      surf = await scene.sampleHeightMostDetailed(pts.map((p) => Cartographic.clone(p)), this.widget.entities.values);
    } finally {
      scene.globe.show = globeShown;
    }
    const ground = await this.sampleGround(pts.map((p) => Cartographic.clone(p)));
    const diffs = surf
      .map((s, k) => (s && Number.isFinite(s.height) ? s.height - (ground[k]?.height ?? NaN) : NaN))
      // A sample that misses the dataset can hit the far side of the globe: drop those.
      .filter((d) => Number.isFinite(d) && Math.abs(d) < 500)
      .sort((a, b) => a - b);
    if (diffs.length < 5 || this.tileset !== tileset) return;
    // Lidar heights are usually better than a 30 m terrain model, which smooths valleys and
    // ridges by metres. So only a clear, consistent gap is corrected: that is a height-datum
    // mismatch (ellipsoid vs geoid is 20–50 m in Europe and the Middle East).
    // Cities use a low quantile (streets, not roofs) and any gap over 1 m.
    const offset = -diffs[Math.floor(diffs.length * quantile)]!;
    if (Math.abs(offset) > minOffset) this.setGroundOffset(offset);
  }

  /** Shift the open 3D Tiles dataset up or down along the local vertical. */
  setGroundOffset(metres: number): void {
    this.groundOffset.set(metres);
    this.scheduleGroundCutShift();
    const m = this.current.get();
    const placed = this.model ?? (m?.source.localFrame ? this.tileset : null);
    if (placed && m?.placement) {
      placed.modelMatrix = placeMatrix(m.placement, this.modelBaseHeight + metres, placed === this.model && m.placement.upAxis === "z");
      this.widget.scene.requestRender();
      return;
    }
    const t = this.tileset;
    if (!t) return;
    const c = t.boundingSphere.center;
    const up = Cartesian3.normalize(c, new Cartesian3());
    Cartesian3.multiplyByScalar(up, metres, up);
    t.modelMatrix = Matrix4.fromTranslation(up);
  }

  setGlobe(on: boolean): void {
    this.widget.scene.globe.show = on;
    this.camera.maxPolarDeg = on ? 100 : 179;
  }

  private makeIbl(): ImageBasedLighting {
    const id = this.environment.get();
    const sh = environmentSh(id);
    const ibl = new ImageBasedLighting();
    if (sh) ibl.sphericalHarmonicCoefficients = sh.map(([r, g, b]) => new Cartesian3(r, g, b));
    const url = this.specularUrl(id);
    if (url) ibl.specularEnvironmentMaps = url;
    return ibl;
  }

  private specularUrls = new Map<EnvironmentId, string>();
  /** The environment's pre-filtered reflections as a KTX2 in memory, made once per session. */
  private specularUrl(id: EnvironmentId): string | null {
    const cube = environmentSpecular(id);
    if (!cube || typeof URL.createObjectURL !== "function") return null;
    if (!this.specularUrls.has(id)) this.specularUrls.set(id, URL.createObjectURL(new Blob([cubeToKtx2(cube)] as ConstructorParameters<typeof Blob>[0], { type: "image/ktx2" })));
    return this.specularUrls.get(id)!;
  }

  /** Switches the light that models and tilesets receive from their surroundings. */
  setEnvironment(id: EnvironmentId): void {
    if (this.environment.get() === id && (this.model ?? this.tileset)) return;
    this.environment.set(id);
    const def = ENVIRONMENTS.find((e) => e.id === id)!;
    const scene = this.widget.scene;
    (scene.light as { intensity: number }).intensity = def.sun;
    scene.shadowMap.darkness = def.shadow;
    if (this.model) this.model.imageBasedLighting = this.makeIbl();
    if (this.tileset) this.tileset.imageBasedLighting = this.makeIbl();
  }

  /** Caps the GPU memory 3D Tiles may hold. Tiles over the cap are unloaded, farthest first. */
  setMemoryBudget(bytes: number): void {
    this.memoryBudget = Math.max(256 * 1024 ** 2, bytes);
    if (this.tileset) {
      this.tileset.cacheBytes = this.memoryBudget;
      this.tileset.maximumCacheOverflowBytes = this.memoryBudget / 2;
    }
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const scene = this.widget.scene;
    this.baseScale = { low: 0.75, balanced: 1, high: 1, ultra: Math.min(2, window.devicePixelRatio || 1) }[q];
    this.widget.resolutionScale = this.baseScale;
    scene.msaaSamples = { low: 1, balanced: 2, high: 4, ultra: 8 }[q];
    scene.shadowMap.size = { low: 1024, balanced: 2048, high: 4096, ultra: 4096 }[q];
    this.viewshed.mapSize = { low: 1024, balanced: 2048, high: 2048, ultra: 4096 }[q];
    scene.postProcessStages.ambientOcclusion.enabled = q === "ultra";
    if (this.tileset) this.tileset.maximumScreenSpaceError = SSE[q];
  }

  /** Cheaper rendering while the camera moves; full quality fades back when it stops (UI spec 1.1 #8). */
  private setMovingQuality(moving: boolean): void {
    const scene = this.widget.scene;
    if (this.quality === "ultra") scene.postProcessStages.ambientOcclusion.enabled = !moving;
    scene.shadowMap.enabled = this.shadowsWanted && !(moving && this.quality === "low");
  }

  // ---------- layers ----------

  setLayers(next: Layer[]): void {
    this.layers.set(next);
    const vis = effectiveVisibility(next);
    if (this.tileset) this.tileset.show = vis.get("tileset") ?? true;
    if (this.model) {
      const apply = (ls: Layer[]) => {
        for (const l of ls) {
          if (l.nodeName) {
            try {
              const node = this.model!.getNode(l.nodeName);
              if (node) node.show = vis.get(l.id) ?? true;
            } catch {
              /* node not addressable */
            }
          }
          apply(l.children);
        }
      };
      apply(next);
    }
    this.widget.scene.requestRender();
  }

  // ---------- globe workspace pins ----------

  setPins(models: ModelSummary[], onClick: (id: string) => void): void {
    for (const p of this.pins) this.widget.entities.remove(p);
    this.onPinClick = onClick;
    this.pins = models.map((m) =>
      this.widget.entities.add({
        id: `pin:${m.id}`,
        position: Cartesian3.fromDegrees(m.centre.lon, m.centre.lat, 0),
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString(STATUS_COLOURS[m.status]),
          outlineColor: Color.fromCssColorString("#0E0F12"),
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(1e3, 1.3, 8e6, 0.8),
        },
        label: {
          text: m.name,
          font: "500 13px 'IBM Plex Sans', 'IBM Plex Sans Hebrew', sans-serif",
          fillColor: Color.fromCssColorString("#E8EAED"),
          showBackground: true,
          backgroundColor: Color.fromCssColorString("#15171B").withAlpha(0.82),
          backgroundPadding: new Cartesian2(8, 4),
          style: LabelStyle.FILL,
          horizontalOrigin: HorizontalOrigin.LEFT,
          verticalOrigin: VerticalOrigin.CENTER,
          pixelOffset: new Cartesian2(12, 0),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e6),
        },
      }),
    );
    this.applyPinVisibility();
  }

  private applyPinVisibility(): void {
    // With a model open, the model is the subject: hide every pin and mute the base map
    // so the model is the brightest thing on screen (UI spec 1, "Quiet").
    const open = !!this.current.get();
    for (const p of this.pins) p.show = !open;
    for (const l of this.baseLayers) {
      l.brightness = open ? 0.55 : 1;
      l.saturation = open ? 0.45 : 1;
      l.contrast = open ? 0.92 : 1;
    }
  }

  // ---------- picking & pointer ----------

  /**
   * World position under a screen point: depth-accurate on models, tiles and terrain.
   * With surfaceOnly, our own drawings (lines, labels, markers) are looked through.
   */
  pick(pos: Cartesian2, surfaceOnly = false): Cartesian3 | undefined {
    const scene = this.widget.scene;
    const onDrawing = surfaceOnly && (scene.pick(pos)?.id as unknown) instanceof Entity;
    if (scene.pickPositionSupported && !onDrawing) {
      const p = scene.pickPosition(pos);
      if (p && Number.isFinite(p.x) && Cartesian3.magnitude(p) > 1000) return p;
    }
    const ray = this.widget.camera.getPickRay(pos);
    const g = ray && scene.globe.show ? scene.globe.pick(ray, scene) : undefined;
    return g ?? this.widget.camera.pickEllipsoid(pos) ?? undefined;
  }

  private bindPointer(): void {
    const canvas = this.widget.canvas;
    let pending: Cartesian2 | null = null;
    let downAt: { x: number; y: number } | null = null;
    canvas.addEventListener("pointermove", (e) => {
      pending = new Cartesian2(e.offsetX, e.offsetY);
    });
    canvas.addEventListener("pointerleave", () => {
      pending = null;
      this.cursor.set(null);
      this.measure.setHover(undefined);
      this.sight.setHover(null);
    });
    // Viewshed observer: drag to move it on the ground, Shift+drag to raise or lower it.
    let vsDrag: { y: number; h: number } | null = null;
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        downAt = { x: e.offsetX, y: e.offsetY };
        if (e.button !== 0 || !this.viewshed.state.get()) return;
        const picked = this.widget.scene.pick(new Cartesian2(e.offsetX, e.offsetY));
        if (picked && this.viewshed.isObserver(picked.id)) {
          vsDrag = { y: e.offsetY, h: this.viewshed.state.get()!.height };
          this.viewshed.dragging.set(true);
          canvas.setPointerCapture(e.pointerId);
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    canvas.addEventListener("pointermove", (e) => {
      if (!vsDrag) return;
      if (e.shiftKey) {
        // Vertical: 1 px = 0.5 % of the radius, so it scales from a room to a valley.
        const r = this.viewshed.state.get()!.radius;
        this.viewshed.setHeight(vsDrag.h + (vsDrag.y - e.offsetY) * r * 0.005);
      } else {
        const p = this.pick(new Cartesian2(e.offsetX, e.offsetY), true);
        if (p) this.viewshed.place(p);
        vsDrag.y = e.offsetY;
        vsDrag.h = this.viewshed.state.get()!.height;
      }
    });
    const endDrag = () => {
      if (!vsDrag) return;
      vsDrag = null;
      downAt = null;
      setTimeout(() => this.viewshed.dragging.set(false), 0);
    };
    canvas.addEventListener("pointerup", endDrag, { capture: true });
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !downAt) return;
      const moved = Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const pos = new Cartesian2(e.offsetX, e.offsetY);
      if (this.measure.active.get()) {
        const p = this.pick(pos);
        if (p) this.measure.addPoint(p);
        return;
      }
      if (this.viewshed.placing.get()) {
        const p = this.pick(pos, true);
        if (p) this.viewshed.place(p);
        return;
      }
      if (this.sight.active.get()) {
        const p = this.pick(pos, true);
        if (p) this.sight.addPoint(p);
        return;
      }
      const picked = this.widget.scene.pick(pos);
      const id = picked?.id?.id as string | undefined;
      if (id?.startsWith("pin:") && this.onPinClick) {
        this.onPinClick(id.slice(4));
        return;
      }
      // A feature of the user's own vector data: show its attributes.
      if (picked?.id instanceof Entity) {
        const world = this.pick(pos) ?? this.pick(pos, true);
        if (world && this.userLayers.pickFeature(picked.id, world)) return;
      }
      this.userLayers.clearPick();
    });
    canvas.addEventListener("dblclick", () => {
      if (this.measure.active.get() === "path") this.measure.finish();
    });
    this.widget.scene.preRender.addEventListener(() => {
      if (!pending) return;
      const pos = pending;
      pending = null;
      const p = this.pick(pos);
      if (!p) {
        this.cursor.set(null);
        this.measure.setHover(undefined);
        return;
      }
      const c = Cartographic.fromCartesian(p);
      if (!c) return;
      this.cursor.set({ lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude), height: c.height, onModel: true });
      this.measure.setHover(p);
      this.sight.setHover(p);
    });
  }

  private showPivot(p: Cartesian3): void {
    if (this.pivotMarker) this.widget.entities.remove(this.pivotMarker);
    this.pivotMarker = this.widget.entities.add({
      position: p,
      point: { pixelSize: 14, color: Color.TRANSPARENT, outlineColor: Color.fromCssColorString("#F05BDC"), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    const marker = this.pivotMarker;
    setTimeout(() => {
      if (this.pivotMarker === marker) {
        this.widget.entities.remove(marker);
        this.pivotMarker = null;
      }
    }, 1000);
  }

  private afterFrame(): void {
    this.frames++;
    const now = performance.now();
    if (this.lastFrameAt) this.frameTimes.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (now - this.lastFpsTime >= 500) {
      this.fps.set(Math.round((this.frames * 1000) / (now - this.lastFpsTime)));
      this.frames = 0;
      this.lastFpsTime = now;
      this.updatePerf();
    }
    const cam = this.widget.camera;
    const carto = Cartographic.fromCartesian(cam.positionWC);
    const prev = this.cameraInfo.get();
    const next = {
      heading: cam.heading,
      pitch: cam.pitch,
      metresPerPixel: this.camera.metresPerPixelAtPivot(),
      height: carto?.height ?? 0,
    };
    if (
      Math.abs(prev.heading - next.heading) > 1e-4 ||
      Math.abs(prev.pitch - next.pitch) > 1e-4 ||
      Math.abs(prev.metresPerPixel - next.metresPerPixel) / (prev.metresPerPixel || 1) > 0.01
    ) {
      this.cameraInfo.set(next);
    }
  }

  private updatePerf(): void {
    // Pauses over 5 s (a hidden tab) are not frames. Slow frames accumulate until there are three.
    const times = this.frameTimes.filter((t) => t < 5000);
    if (times.length < 3) return;
    this.frameTimes = [];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const worst = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)] ?? avg;
    // Adaptive resolution: step down to 60% of the preset while frames take over 20 ms, back up under 12 ms.
    if (this.adaptiveResolution) {
      const s = this.widget.resolutionScale;
      if (avg > 20 && s > this.baseScale * 0.6 + 1e-3) this.widget.resolutionScale = Math.max(this.baseScale * 0.6, s - 0.1);
      else if (avg < 12 && s < this.baseScale - 1e-3) this.widget.resolutionScale = Math.min(this.baseScale, s + 0.05);
    } else if (!this.adaptiveResolution && this.widget.resolutionScale !== this.baseScale) this.widget.resolutionScale = this.baseScale;
    const t = this.tileset;
    const ts = t ? (t as unknown as { statistics: Record<string, number> }).statistics : null;
    const ms = this.model ? (this.model as unknown as { statistics?: Record<string, number> }).statistics : null;
    const scene = this.widget.scene;
    this.perf.set({
      fps: Math.round(1000 / avg),
      frameMs: avg,
      worstFrameMs: worst,
      resolution: this.widget.resolutionScale,
      adaptive: this.adaptiveResolution,
      tilesVisible: ts?.selected ?? 0,
      tilesLoaded: ts?.numberOfLoadedTilesTotal ?? 0,
      tilesPending: ts ? (ts.numberOfPendingRequests ?? 0) + (ts.numberOfTilesProcessing ?? 0) : 0,
      tileMemoryMB: t ? t.totalMemoryUsageInBytes / 1048576 : 0,
      modelMemoryMB: ms ? ((ms.geometryByteLength ?? 0) + (ms.texturesByteLength ?? 0)) / 1048576 : 0,
      globeTilesLoading: scene.globe.tilesLoaded ? 0 : 1,
      canvas: `${scene.drawingBufferWidth}×${scene.drawingBufferHeight}`,
      msaa: scene.msaaSamples,
    });
  }

  /** The current camera, as plain numbers for a share link (WP 4.6). */
  getView(): SharedView {
    const c = this.widget.camera;
    const g = Cartographic.fromCartesian(c.positionWC);
    return { lon: CMath.toDegrees(g.longitude), lat: CMath.toDegrees(g.latitude), h: g.height, heading: c.heading, pitch: c.pitch, roll: c.roll };
  }

  setView(v: SharedView, duration = 0): void {
    const destination = Cartesian3.fromDegrees(v.lon, v.lat, v.h);
    const orientation = { heading: v.heading, pitch: v.pitch, roll: v.roll };
    if (duration > 0) this.widget.camera.flyTo({ destination, orientation, duration });
    else this.widget.camera.setView({ destination, orientation });
  }

  /** PNG of the current view; the UI burns the classification banner on top (UPL-10). */
  snapshot(): string {
    // Full resolution, even while adaptive resolution has lowered it.
    const scale = this.widget.resolutionScale;
    this.widget.resolutionScale = this.baseScale;
    this.widget.render();
    const png = this.widget.canvas.toDataURL("image/png");
    this.widget.resolutionScale = scale;
    return png;
  }
}

export interface PerfStats {
  fps: number;
  frameMs: number;
  /** 95th percentile frame time over the last half second. */
  worstFrameMs: number;
  resolution: number;
  adaptive: boolean;
  tilesVisible: number;
  tilesLoaded: number;
  tilesPending: number;
  tileMemoryMB: number;
  modelMemoryMB: number;
  globeTilesLoading: number;
  canvas: string;
  msaa: number;
}

export interface SharedView {
  lon: number;
  lat: number;
  h: number;
  heading: number;
  pitch: number;
  roll: number;
}

/**
 * Where a model or local-frame tileset stands. For a model loaded Z-up (`zUpModel`) Cesium is
 * given forward X, since its default glTF forward axis (Z) would turn the model onto its side;
 * the quarter turn here then makes a Z-up file face the same way as the same file in Y-up,
 * so switching the up axis in the Place step stands a model up without spinning it.
 * The tiler bakes the same orientation into tiles (apps/server/src/tiler.ts).
 */
function placeMatrix(p: NonNullable<ModelSummary["placement"]>, height: number, zUpModel = false): Matrix4 {
  const m = Transforms.headingPitchRollToFixedFrame(Cartesian3.fromDegrees(p.lon, p.lat, height), new HeadingPitchRoll(CMath.toRadians(p.headingDeg ?? 0), 0, 0));
  return zUpModel ? Matrix4.multiply(m, Matrix4.fromRotation(Matrix3.fromRotationZ(CMath.PI_OVER_TWO)), m) : m;
}

function friendlyReason(err: Error): string {
  const m = `${err.name} ${err.message}`.toLowerCase();
  if (m.includes("404") || m.includes("not found")) return "The file, or a file it references, could not be found.";
  if (m.includes("json") || m.includes("unexpected token")) return "The file is not valid glTF or 3D Tiles JSON.";
  if (m.includes("magic") || m.includes("glb")) return "The file is not a valid GLB.";
  if (m.includes("version")) return "This file uses a version VIEWER does not support.";
  return "The file is damaged or in a format VIEWER cannot read.";
}
