import {
  ArcType,
  Axis,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Rectangle,
  ImageBasedLighting,
  Cartographic,
  Cesium3DTileset,
  Cesium3DTileFeature,
  Cesium3DTileStyle,
  type Cesium3DTile,
  OrientedBoundingBox,
  CesiumWidget,
  Color,
  CustomShader,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  JulianDate,
  LightingModel,
  Math as CMath,
  Matrix3,
  Matrix4,
  Model,
  type Ray,
  NearFarScalar,
  PerspectiveFrustum,
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
  HorizontalOrigin,
  VerticalOrigin,
  LabelStyle,
  Entity,
  HeightReference,
  DistanceDisplayCondition,
  SplitDirection,
} from "cesium";
import type { BaseMapConfig, ModelSummary, UpdateStatus } from "@viewer/shared";
import { CameraController } from "./camera-controller";
import { nextResolutionScale } from "./adaptive-resolution";
import { MeasureTool } from "./measure-tool";
import { Snapper, type Snap } from "./snapper";
import { FlyByTour, FlyMode, captureViewpoint, type Viewpoint } from "./fly";
import { signal } from "../signal";
import { applyManifest, effectiveVisibility, findLayer, layerForNode, layerNodes, layersFromGltf, layersFromTileset, walk, type Layer, type LayerManifest } from "../layers/layers";
import { editableTree, type EditLayer } from "../layers/manifest-edit";
import { addUserTerrain, applySiteConfig, catalogue, makeBaseLayers, removeUserTerrain } from "./basemaps";
import { ENVIRONMENTS, environmentSh, environmentSpecular, type EnvironmentId } from "./environments";
import { cubeToKtx2 } from "./ktx2";
import { asLayerable, createLayeredTerrain, type DemSource } from "./terrain";
import { captureUnderside, coverage, groundCut, MIN_COVERAGE, mergeUndersides, type Underside } from "./ground-cut";
import { SightlineTool } from "./sightline";
import { Viewshed } from "./viewshed";
import { UserLayers } from "./user-layers";
import { LodInspector } from "./lod-inspector";
import { placementFrame } from "../geo/place";
import { datumShift, geoidHeight } from "../geo/geoid";
import { dataFootprint } from "./footprint";

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

/** Tiles of the open tileset that could not be loaded; the rest of the tileset still shows. */
export interface TileProblems {
  count: number;
  /** The first few, as "path: reason". */
  files: string[];
  reason: string;
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
  /** Snapping of measurement points to corners and edges (WP 2.3, MSR-03). */
  readonly snapper: Snapper;
  readonly fly: FlyMode;
  readonly tour: FlyByTour;
  readonly sight: SightlineTool;
  readonly viewshed: Viewshed;
  readonly userLayers: UserLayers;
  readonly lod: LodInspector;

  readonly cursor = signal<CursorInfo | null>(null);
  readonly cameraInfo = signal<CameraInfo>({ heading: 0, pitch: -0.5, metresPerPixel: 1, height: 0 });
  private lastPose: number[] | null = null;
  private lastScaleAt = 0;
  readonly fps = signal(0);
  /** Numbers for the performance overlay (Shift+P), refreshed twice a second (WP 1.5). */
  readonly perf = signal<PerfStats | null>(null);
  /** Lower the render resolution while frames are slow, and restore it when they are fast (NFR-03). */
  adaptiveResolution = true;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private baseScale = 1;
  /** When adaptive resolution last changed the resolution, and when the camera last moved. */
  private resolutionChangedAt = 0;
  private cameraMovedAt = 0;
  private movePose: number[] | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | undefined;
  readonly layers = signal<Layer[]>([]);
  /** The layer picked by clicking the model, or in the layers panel; Focus selection (Z) fits it (NAV-05). */
  readonly selectedLayer = signal<string | null>(null);
  /** The layer the pointer is over in the Layers panel, outlined in 3D (LYR, WP 2.2). */
  readonly hoveredLayer = signal<string | null>(null);
  private hoverBox: Entity | null = null;
  /** The open tileset's layers are its original parts, shown and hidden by feature. */
  private tilesetParts = false;
  /** The open model's layers as the file has them, before its saved manifest is applied. */
  private derivedLayers: Layer[] = [];
  private manifest: LayerManifest | null = null;
  private gltfNodes: { children?: number[] }[] = [];
  readonly loading = signal(false);
  /** The model shown on the right of a side-by-side comparison (SRS GS-28), or null. */
  readonly comparing = signal<ModelSummary | null>(null);
  /** Where the divider of a side-by-side comparison stands, 0 (left edge) to 1 (right edge). */
  readonly splitAt = signal(0.5);
  private compareSet: Cesium3DTileset | null = null;
  private compareSeq = 0;
  readonly error = signal<OpenError | null>(null);
  readonly tileProblems = signal<TileProblems | null>(null);
  readonly current = signal<ModelSummary | null>(null);
  private openSeq = 0;
  readonly viewMode = signal<ViewMode>("shaded");
  readonly viewpoints = signal<Viewpoint[]>([]);
  readonly baseMapId = signal("bundled");
  readonly terrainId = signal("none");
  /** Lighting environment for models and tilesets (WP 1.4). */
  readonly environment = signal<EnvironmentId>("atmosphere");
  /** GPU memory for 3D Tiles, shared by every open tileset (WP 1.5, NFR-04). */
  private memoryBudget = 10 * 1024 ** 3;
  /** Vertical shift applied to a 3D Tiles dataset to meet the terrain, metres. */
  readonly groundOffset = signal(0);
  /** How the last automatic ground fit went; null when none ran (no fit asked, or a placed model). */
  readonly groundFit = signal<GroundFitReport | null>(null);
  private userDems: DemSource[] = [];
  /** The chosen terrain as its source gives it, before DEMs and the ground cut. */
  private terrainBase: TerrainProvider = new EllipsoidTerrainProvider();
  /** The ground: the chosen terrain with the user's DEMs. Heights are sampled from this. */
  private groundTerrain: TerrainProvider = this.terrainBase;
  /** Terrain lowered under the open model so it never shows through it (WP 1.6). */
  private cut: { source: DemSource; offset: number; u: Underside } | null = null;
  private cutRefineTimer: ReturnType<typeof setTimeout> | null = null;
  private offTilesLoaded: (() => void) | null = null;
  private offTileFailed: (() => void) | null = null;
  private cutTimer: ReturnType<typeof setTimeout> | null = null;
  private cutRun = 0;
  /** The last cut found no drawn tiles to capture: try again when tiles next finish loading. */
  private cutMissing = false;

  private model: Model | null = null;
  private tileset: Cesium3DTileset | null = null;
  /** A splat tileset's bounds without floaters, in the tileset's own frame (z up). */
  private splatFocus: BoundingSphere | null = null;
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
  /** Render on demand: frames keep coming until then, and while something is still loading. */
  private drawUntil = 0;
  /** Inside Cesium's frame: what runs there does not ask for another frame. */
  private inFrame = false;
  /** Callers waiting for frames to be drawn (afterFrames, firstDrawn). */
  private frameWaiters = 0;
  /** The previous frame asked for the next one, so the time between them is a frame time. */
  private drawing = false;
  private requestFrame: () => void = () => undefined;
  private offInput: () => void = () => undefined;
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
      // Drawn on demand (see keepDrawing): a still view costs no GPU time, and a slow GPU never
      // falls behind with frames nobody needs.
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      useBrowserRecommendedResolution: false,
      // Our own message replaces Cesium's error panel (below).
      showRenderLoopErrors: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true, powerPreference: "high-performance" } },
    });
    this.baseLayers = [baseLayer];
    const scene = this.widget.scene;
    // A model that makes drawing fail would stop the whole view: Cesium stops its render loop
    // on the first error. Instead the open model is closed with a message, and the loop goes on.
    const widgetOnError = (this.widget as unknown as { _onRenderError?: (...a: unknown[]) => void })._onRenderError;
    if (widgetOnError) scene.renderError.removeEventListener(widgetOnError);
    scene.renderError.addEventListener((_s: unknown, e: unknown) => {
      const summary = this.current.get();
      if (!summary || this.error.get()) return;
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`HOLO: drawing failed; the model was closed. ${err.stack ?? `${err.name}: ${err.message}`}`);
      // Not inside Cesium's frame: close the model once the frame is over.
      setTimeout(() => {
        if (this.current.get() !== summary) return;
        this.close();
        this.current.set(summary);
        const why = /too many attributes \(a_target/i.test(err.message) ? " It has more morph targets than the graphics card can draw at once." : "";
        this.error.set({ file: summary.source.url.split("/").pop() ?? summary.source.url, reason: `HOLO could not draw this model and closed it.${why} The rest of the view keeps working.`, detail: `${err.name}: ${err.message}` });
      }, 0);
    });
    scene.postProcessStages.fxaa.enabled = true;
    scene.postProcessStages.tonemapper = Tonemapper.PBR_NEUTRAL;
    scene.highDynamicRange = true;
    // Picks read the depth of the frame already drawn. With translucent depth on, every pick
    // position draws the whole scene once more (a second frame for each hover), and in Cesium
    // 1.146 that extra draw can hit a billboard collection mid-rebuild and crash the view. So a
    // pick looks through glass to what is behind it; glass edges and corners still snap.
    scene.pickTranslucentDepth = false;
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
    // An index built in the worker may change what the cursor snaps to: look again.
    this.snapper = new Snapper(scene, () => {
      this.rehover?.();
      scene.requestRender();
    });
    this.fly = new FlyMode(scene, this.widget.canvas);
    this.tour = new FlyByTour(scene);
    this.sight = new SightlineTool(scene, this.widget.entities, (pts) => this.sampleGround(pts));
    this.viewshed = new Viewshed(scene, this.widget.entities, (pts) => this.sampleGround(pts));
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
    this.drawOnDemand();
    scene.postRender.addEventListener(() => this.afterFrame());
    this.flyHome(0);
  }

  destroy(): void {
    clearTimeout(this.restoreTimer);
    this.offInput();
    this.snapper.destroy();
    this.fly.disable();
    this.tour.stop();
    this.camera.destroy();
    this.widget.destroy();
  }

  // ---------- models ----------

  async open(summary: ModelSummary, opts: { fly?: boolean } = {}): Promise<void> {
    this.close();
    // Another open or a close while this one loads makes it stale (two versions of one model share an id).
    const seq = this.openSeq;
    this.current.set(summary);
    // A model without a reliable scale is measured in its own units (MSR-06).
    this.measure.setModelUnit(summary.placement?.modelUnit);
    this.loading.set(true);
    this.error.set(null);
    const scene = this.widget.scene;
    try {
      if (summary.source.kind === "3dtiles") {
        const tileset = await Cesium3DTileset.fromUrl(summary.source.url, {
          maximumScreenSpaceError: SSE[this.quality],
          ...this.budgetSplit(),
          imageBasedLighting: this.makeIbl(),
          shadows: ShadowMode.ENABLED,
        });
        if (seq !== this.openSeq) return tileset.destroy();
        // A missing or damaged tile leaves a hole; say which, and keep showing the rest.
        this.offTileFailed = tileset.tileFailed.addEventListener((f: { url: string; message: string }) => {
          const prev = this.tileProblems.get();
          const name = decodeURIComponent(String(f.url).split("?")[0]!.split("/").slice(-2).join("/"));
          const files = prev ? prev.files : [];
          this.tileProblems.set({
            count: (prev?.count ?? 0) + 1,
            files: files.length < 5 ? [...files, `${name}: ${f.message}`] : files,
            // One reason when they all failed the same way, else a word for both.
            reason: !prev || prev.reason === friendlyReason(new Error(f.message)) ? friendlyReason(new Error(f.message)) : "Some tiles could not be found, and others are damaged or unreadable.",
          });
        });
        scene.primitives.add(tileset);
        this.tileset = tileset;
        // Finer tiles can hold ground the first capture did not see: refine the cut as they load.
        this.offTilesLoaded = tileset.allTilesLoaded.addEventListener(() => this.scheduleGroundCutRefine());
        this.lod.attach(tileset);
        // A tileset from our tiler names the original's parts (tileset extras, and a feature per part in each tile).
        const parts = layersFromTileset(tileset.extras);
        this.tilesetParts = !!parts;
        this.derivedLayers = parts ?? [{ id: "tileset", name: summary.name, children: [], visible: true }];
        this.layers.set(applyManifest(this.derivedLayers, this.manifest));
        if (summary.source.localFrame && summary.placement) {
          // A tileset in local coordinates: placed like a model, from the upload's Place step.
          this.modelBaseHeight = await this.placementHeight(summary.placement);
          this.groundOffset.set(0);
          tileset.modelMatrix = localTilesetMatrix(summary, summary.placement, this.modelBaseHeight);
          this.splatFocus = summary.source.splats ? splatFocus(tileset) : null;
        } else {
          // The fit samples the surface by drawing it many times over: let the first view out first.
          void this.firstDrawn(tileset)
            .then(() => (this.tileset === tileset ? this.fitTilesetToGround(tileset, summary) : undefined))
            .then(() => this.updateGroundCut());
        }
      } else {
        // A GLB with its own Earth position (CESIUM_RTC, an Earth-centred node) is drawn as it is.
        const own = summary.source.georeferenced && !summary.placement;
        const place = summary.placement ?? { ...summary.centre, height: 0 };
        const height = own ? 0 : await this.placementHeight(place);
        this.modelBaseHeight = height;
        this.groundOffset.set(0);
        let gltfJson: unknown = null;
        const model = await Model.fromGltfAsync({
          url: summary.source.url,
          modelMatrix: own ? Matrix4.IDENTITY : placeMatrix(place, height),
          scale: own ? 1 : (place.scale ?? 1),
          upAxis: !own && place.upAxis === "z" ? Axis.Z : Axis.Y,
          forwardAxis: Axis.X,
          shadows: ShadowMode.ENABLED,
          enableDebugWireframe: true,
          imageBasedLighting: this.makeIbl(),
          gltfCallback: (g) => {
            gltfJson = g;
          },
        });
        if (seq !== this.openSeq) return model.destroy();
        scene.primitives.add(model);
        this.model = model;
        await new Promise<void>((resolve, reject) => {
          if (model.ready) return resolve();
          const off1 = model.readyEvent.addEventListener(() => { off1(); off2(); resolve(); });
          const off2 = model.errorEvent.addEventListener((e: unknown) => { off1(); off2(); reject(e); });
        });
        this.gltfNodes = (gltfJson as { nodes?: { children?: number[] }[] } | null)?.nodes ?? [];
        this.derivedLayers = gltfJson ? layersFromGltf(gltfJson as Parameters<typeof layersFromGltf>[0]) : [];
        this.layers.set(applyManifest(this.derivedLayers, this.manifest));
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
      if (seq !== this.openSeq) return;
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
    this.stopCompare();
    this.openSeq++;
    // The last fit's report belongs to the model being closed.
    this.groundFit.set(null);
    this.tour.stop();
    this.measure.cancel();
    this.measure.clear();
    this.measure.setModelUnit(null);
    this.sight.cancel();
    this.sight.clear();
    this.viewshed.clear();
    this.lod.attach(null);
    if (this.model) this.widget.scene.primitives.remove(this.model);
    if (this.tileset) this.widget.scene.primitives.remove(this.tileset);
    this.model = null;
    this.tileset = null;
    this.splatFocus = null;
    this.splatFrames = 0;
    this.layers.set([]);
    this.derivedLayers = [];
    this.manifest = null;
    this.selectedLayer.set(null);
    this.highlightLayer(null);
    this.gltfNodes = [];
    this.current.set(null);
    this.error.set(null);
    this.applyPinVisibility();
    this.cutRun++;
    this.cutMissing = false;
    this.offTilesLoaded?.();
    this.offTilesLoaded = null;
    this.offTileFailed?.();
    this.offTileFailed = null;
    this.tileProblems.set(null);
    if (this.cutRefineTimer) clearTimeout(this.cutRefineTimer);
    if (this.cut) {
      this.cut = null;
      this.applyTerrain();
    }
  }

  /** Frames still to draw so the last splat sort is shown (see splatsBusy). */
  private splatFrames = 0;
  private splatsSettling(): boolean {
    // A sort commits during a frame and is drawn by the frames after it: a few more, counted in frames
    // not milliseconds, because a slow GPU can take longer than any fixed time per frame.
    if ((this.tileset && splatsBusy(this.tileset)) || (this.compareSet && splatsBusy(this.compareSet))) this.splatFrames = 4;
    return this.splatFrames > 0;
  }

  /**
   * Side by side (SRS GS-28): another version of the open model, or another result of the same
   * capture, drawn on the right of a divider while the open model stays on the left, from the same
   * viewpoint. Both must be 3D Tiles in their own frame (splats, or tiled models placed like a GLB).
   * Stopping removes the second tileset and frees its GPU memory.
   */
  async compareWith(other: ModelSummary): Promise<void> {
    this.stopCompare();
    const open = this.current.get();
    if (!this.tileset || !open || other.source.kind !== "3dtiles" || !other.source.localFrame || !other.placement) throw new Error("Only 3D Tiles models in their own frame can be compared side by side.");
    const seq = ++this.compareSeq;
    const scene = this.widget.scene;
    const set = await Cesium3DTileset.fromUrl(other.source.url, { maximumScreenSpaceError: SSE[this.quality], ...this.budgetSplit(), imageBasedLighting: this.makeIbl(), shadows: ShadowMode.ENABLED });
    if (seq !== this.compareSeq || this.current.get() !== open) return void set.destroy();
    set.modelMatrix = localTilesetMatrix(other, other.placement, await this.placementHeight(other.placement));
    if (seq !== this.compareSeq || this.current.get() !== open) return void set.destroy();
    set.splitDirection = SplitDirection.RIGHT;
    this.tileset.splitDirection = SplitDirection.LEFT;
    scene.splitPosition = this.splitAt.get();
    scene.primitives.add(set);
    this.compareSet = set;
    this.comparing.set(other);
    scene.requestRender();
  }

  /** Moves the side-by-side divider; 0 is the left edge of the view, 1 the right. */
  setSplit(at: number): void {
    const v = Math.min(0.98, Math.max(0.02, at));
    this.splitAt.set(v);
    this.widget.scene.splitPosition = v;
    this.widget.scene.requestRender();
  }

  stopCompare(): void {
    this.compareSeq++;
    if (this.compareSet) this.widget.scene.primitives.remove(this.compareSet);
    this.compareSet = null;
    if (this.tileset) this.tileset.splitDirection = SplitDirection.NONE;
    if (this.comparing.get()) this.comparing.set(null);
    this.widget.scene.requestRender();
  }

  /**
   * For splat models (docs/GAUSSIAN_SPLATS.md): the size of the splats without floaters, in file
   * units as width, height, depth along the file's x, y, z (glTF frame), and the matrix that places
   * the tileset on the globe (column-major), for "Set real size" and the 3D Tiles download.
   */
  splatInfo(): { size: [number, number, number] | null; modelMatrix: number[] } | null {
    if (!this.tileset || !this.current.get()?.source.splats) return null;
    const f = (this.tileset.extras as { holo?: { focus?: { min: number[]; max: number[] } } } | undefined)?.holo?.focus;
    const size = f && f.min.length === 3 && f.max.length === 3 ? ([0, 1, 2].map((a) => f.max[a]! - f.min[a]!) as [number, number, number]) : null;
    return { size: size && size.every((v) => Number.isFinite(v) && v >= 0) ? size : null, modelMatrix: Matrix4.toArray(this.tileset.modelMatrix) };
  }

  /** The open tileset's model matrix (column-major) when it is drawn in its own frame, placed here; else null. */
  tilesetMatrix(): number[] | null {
    const m = this.current.get();
    return this.tileset && m?.source.localFrame ? Matrix4.toArray(this.tileset.modelMatrix) : null;
  }

  /**
   * For exporting a placed GLB as 3D Tiles (SRS GS-31): the root transform that draws the GLB
   * where it stands here (3D Tiles always turn glTF content from y-up to z-up, so a z-up file is
   * turned back first), and the model's bounding sphere in that root's frame.
   */
  glbFrame(): { transform: number[]; sphere: [number, number, number, number] } | null {
    const m = this.current.get();
    if (!this.model || !m?.placement || m.source.georeferenced) return null;
    const p = m.placement;
    const out = placeMatrix(p, this.modelBaseHeight + this.groundOffset.get());
    if (p.upAxis === "z") Matrix4.multiply(out, Matrix4.fromRotation(Matrix3.fromRotationX(-CMath.PI_OVER_TWO)), out);
    const k = p.scale ?? 1;
    if (k !== 1 && Number.isFinite(k) && k > 0) Matrix4.multiplyByUniformScale(out, k, out);
    const bs = this.model.boundingSphere;
    const c = Matrix4.multiplyByPoint(Matrix4.inverse(out, new Matrix4()), bs.center, new Cartesian3());
    return { transform: Matrix4.toArray(out), sphere: [c.x, c.y, c.z, bs.radius / (k > 0 ? k : 1)] };
  }

  boundingSphere(): BoundingSphere | null {
    if (this.tileset && this.splatFocus) {
      // Splats: the bounds without the floaters training leaves around a scene (SRS GS-15).
      const f = this.splatFocus;
      const c = Matrix4.multiplyByPoint(this.tileset.modelMatrix, f.center, new Cartesian3());
      return new BoundingSphere(c, f.radius * Matrix4.getMaximumScale(this.tileset.modelMatrix));
    }
    return this.model?.boundingSphere ?? this.tileset?.boundingSphere ?? null;
  }

  // ---------- camera ----------

  /**
   * A presentation orbit (SRS GS-24): where the camera stands now, as heading, pitch and distance
   * around the model's centre. `orbitTo` turns the camera around that centre by a share of a full
   * turn, and `stillFrame` draws until the tiles and the splat sort have settled.
   */
  orbitStart(): { heading: number; pitch: number; range: number } | null {
    const bs = this.boundingSphere();
    if (!bs) return null;
    const cam = this.widget.camera;
    // Far enough that the whole model stays in frame all the way round.
    const fov = (cam.frustum as { fov?: number }).fov ?? Math.PI / 3;
    const range = Math.max(Cartesian3.distance(cam.positionWC, bs.center), (bs.radius / Math.sin(fov / 2)) * 1.1);
    return { heading: cam.heading, pitch: Math.min(-0.15, cam.pitch), range };
  }

  orbitTo(start: { heading: number; pitch: number; range: number }, turn: number): void {
    const bs = this.boundingSphere();
    if (!bs) return;
    const cam = this.widget.camera;
    cam.lookAt(bs.center, new HeadingPitchRange(start.heading + turn * 2 * Math.PI, start.pitch, start.range));
    cam.lookAtTransform(Matrix4.IDENTITY);
  }

  /** Draws until the view is complete (tiles loaded, splats sorted), at most `maxFrames` times; returns the canvas. */
  async stillFrame(maxFrames = 120): Promise<HTMLCanvasElement> {
    const scene = this.widget.scene;
    for (let i = 0; i < maxFrames; i++) {
      this.widget.render();
      const tilesDone = (!this.tileset || this.tileset.tilesLoaded) && (!this.compareSet || this.compareSet.tilesLoaded);
      const busy = (this.tileset && splatsBusy(this.tileset)) || (this.compareSet && splatsBusy(this.compareSet));
      // Returned in the same task as the draw, so the canvas still holds this frame for the caller.
      if (tilesDone && !busy && i >= 1) return scene.canvas;
      await new Promise((r) => setTimeout(r, 8));
    }
    this.widget.render();
    return scene.canvas;
  }

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

  /** Fits a layer in the view (NAV-05 Focus selection). A layer without its own extent fits the whole model. */
  async focusLayer(layerId: string): Promise<void> {
    const bs = this.layerSphere(layerId);
    if (!bs) return this.home(0.8);
    Cartesian3.clone(bs.center, this.camera.pivot);
    const h = this.widget.camera.heading;
    const p = Math.min(this.widget.camera.pitch, CMath.toRadians(-15));
    await this.flySphere(bs, h, p, 0.8);
  }

  /** Focus selection: the selected layer, or the whole model when nothing is selected. */
  async focusSelection(): Promise<void> {
    const id = this.selectedLayer.get();
    return id ? this.focusLayer(id) : this.home(0.8);
  }

  /** A layer's extent on the Earth, from its glTF box placed the way Cesium draws the model. */
  layerSphere(layerId: string): BoundingSphere | null {
    const pts = this.layerCorners(layerId);
    return pts ? BoundingSphere.fromPoints(pts) : null;
  }


  /** Corners of a layer's glTF box on the Earth, in the order Cesium draws the model. */
  layerCorners(layerId: string): Cartesian3[] | null {
    const l = findLayer(this.layers.get(), layerId);
    if (l?.box && this.tileset && this.tilesetParts) {
      // Tile content is Y-up glTF; 3D Tiles stands it up (x, −z, y) before the root transform.
      const t = this.tileset.root.computedTransform;
      const b = l.box;
      return [...Array(8).keys()].map((c) => {
        const x = c & 1 ? b.hi[0]! : b.lo[0]!, y = c & 2 ? b.hi[1]! : b.lo[1]!, z = c & 4 ? b.hi[2]! : b.lo[2]!;
        return Matrix4.multiplyByPoint(t, new Cartesian3(x, -z, y), new Cartesian3());
      });
    }
    if (!l?.box || !this.model) return null;
    const m = (this.model as unknown as { sceneGraph?: { computedModelMatrix?: Matrix4 } }).sceneGraph?.computedModelMatrix;
    if (!m) return null;
    const pts: Cartesian3[] = [];
    for (let c = 0; c < 8; c++) {
      const v = new Cartesian3(c & 1 ? l.box.hi[0] : l.box.lo[0], c & 2 ? l.box.hi[1] : l.box.lo[1], c & 4 ? l.box.hi[2] : l.box.lo[2]);
      pts.push(Matrix4.multiplyByPoint(m, v, new Cartesian3()));
    }
    return pts;
  }

  /**
   * Outlines a layer in 3D with its box, drawn over the model so it shows through walls
   * (pointer over its row in the Layers panel). null clears it.
   */
  highlightLayer(layerId: string | null): void {
    if (this.hoverBox) this.widget.entities.remove(this.hoverBox);
    this.hoverBox = null;
    this.hoveredLayer.set(layerId);
    const pts = layerId ? this.layerCorners(layerId) : null;
    if (pts) {
      // One line through all 12 edges, retracing three of them.
      const path = [0, 1, 3, 2, 0, 4, 5, 1, 5, 7, 3, 7, 6, 2, 6, 4].map((i) => pts[i]!);
      const accent = Color.fromCssColorString("#F05BDC");
      this.hoverBox = this.widget.entities.add({
        polyline: { positions: path, width: 2, arcType: ArcType.NONE, material: accent, depthFailMaterial: accent.withAlpha(0.45) },
      });
    }
    this.widget.scene.requestRender();
  }

  /** Selects the layer under a window position, or clears the selection. Returns the layer id. */
  selectAt(pos: Cartesian2): string | null {
    const picked = this.widget.scene.pick(pos) as { primitive?: unknown; detail?: { node?: { node?: { index?: number } } } } | undefined;
    let id: string | null = null;
    if (picked?.primitive && picked.primitive === this.model) {
      const index = picked.detail?.node?.node?.index;
      if (index !== undefined) id = layerForNode(this.layers.get(), this.gltfNodes, index)?.id ?? null;
    } else if (picked?.primitive && picked.primitive === this.tileset) {
      const node = this.tilesetParts && picked instanceof Cesium3DTileFeature ? Number(picked.getProperty("node")) : NaN;
      id = Number.isFinite(node) ? (layerForNode(this.layers.get(), [], node)?.id ?? null) : this.tilesetParts ? null : "tileset";
    }
    this.selectedLayer.set(id);
    return id;
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
      // Far enough that the sphere spans about 60% of the view's narrower angle, whatever the
      // window's shape; the whole sphere stays beyond the view's near limit (0.1 m).
      const f = this.widget.camera.frustum as PerspectiveFrustum;
      const aspect = this.widget.canvas.clientWidth / Math.max(1, this.widget.canvas.clientHeight);
      const fov = f.fov ?? CMath.toRadians(60);
      // Cesium's fov is across the wider side.
      const narrow = aspect >= 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
      const range = Math.max(bs.radius / Math.sin(0.3 * narrow), bs.radius + 0.12);
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
   * Connects a terrain service of the user's own (quantized-mesh folder or Terrarium tiles),
   * adds it to their Terrain list and switches to it. A service that does not load is not kept.
   */
  async addTerrainService(url: string, label?: string): Promise<string> {
    const before = new Set(catalogue.get().terrains.map((t) => t.id));
    const def = addUserTerrain(url.trim(), label);
    try {
      await this.setTerrain(def.id);
    } catch (e) {
      if (!before.has(def.id)) removeUserTerrain(def.id);
      throw e;
    }
    return def.id;
  }

  /** Takes one of the user's own terrain services off their list. */
  async removeTerrainService(id: string): Promise<void> {
    if (this.terrainId.get() === id) {
      const fallback = catalogue.get().terrains.find((t) => t.id !== id && !t.user && t.id !== "none")?.id ?? "none";
      await this.setTerrain(fallback).catch(() => this.setTerrain("none"));
    }
    removeUserTerrain(id);
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
    // Tiles still loading draw nothing to capture; without a retry the terrain would show
    // through the model for good.
    this.cutMissing = !u && target === this.tileset;
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
      // Not during a camera flight: the capture's orthographic camera makes the flight's next
      // step pick against the last frame's commands, which can hold the previous model's
      // destroyed buffers (seen when one upload replaced another).
      for (let w = 0; w < 50 && (this.widget.scene as unknown as { tweens: { length: number } }).tweens.length > 0 && current(); w++) await this.afterFrames(1);
      if (!current()) break;
      // A capture draws with the tile choice frozen, and Cesium cancels every tile request a
      // frame does not touch. Capturing while tiles load would cancel them, and the next try
      // again, so a model whose tiles take longer than the wait above would never load.
      if (target instanceof Cesium3DTileset && (!target.tilesLoaded || !(target as unknown as { _selectedTiles: unknown[] })._selectedTiles.length)) continue;
      const u = captureUnderside(this.widget.scene, target, () => this.widget.render(), target instanceof Cesium3DTileset ? { sphere: dataFootprint(target) } : {});
      if (coverage(u) > coverage(best)) best = u;
      if (coverage(best) >= MIN_COVERAGE) break;
    }
    return best;
  }

  /** Resolves after `n` frames have been drawn (or after a second, if nothing is drawing). */
  private afterFrames(n: number): Promise<void> {
    return new Promise((resolve) => {
      let left = n;
      this.frameWaiters++;
      const done = () => (off(), clearTimeout(timer), this.frameWaiters--, setTimeout(resolve, 0));
      const off = this.widget.scene.postRender.addEventListener(() => --left <= 0 && done());
      const timer = setTimeout(done, 1000);
      this.widget.scene.requestRender();
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
    if (this.cutMissing && this.tileset && !this.cut) {
      this.cutMissing = false;
      void this.updateGroundCut();
      return;
    }
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
    // Inside the user's DEMs, their own full resolution rather than the terrain tiles' spacing.
    // Later DEMs win, as they do in the terrain.
    const fromDem = new Float64Array(points.length).fill(NaN);
    for (const dem of this.userDems) {
      if (!dem.sampleHeights || (dem.mode ?? "replace") !== "replace") continue;
      const idx: number[] = [];
      points.forEach((p, i) => Rectangle.contains(dem.rectangle, p) && idx.push(i));
      if (!idx.length) continue;
      const h = await dem.sampleHeights(idx.map((i) => points[i]!)).catch(() => null);
      idx.forEach((i, k) => {
        const v = h?.[k];
        if (v !== undefined && Number.isFinite(v)) fromDem[i] = v;
      });
    }
    // The ground itself, not the cut the globe draws under the open model; only where no DEM answered.
    const rest = points.filter((_, i) => !Number.isFinite(fromDem[i]));
    const tp = this.groundTerrain;
    if (rest.length) {
      if (tp instanceof EllipsoidTerrainProvider) for (const p of rest) p.height = 0;
      else await (tp.availability ? sampleTerrainMostDetailed(tp, rest) : sampleTerrain(tp, level, rest));
    }
    points.forEach((p, i) => {
      if (Number.isFinite(fromDem[i])) p.height = fromDem[i]!;
    });
    return points;
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
    this.groundFit.set(null);
    // With no terrain the globe is the bare ellipsoid: the fit still brings the dataset down
    // to it, rather than leave a city hanging its full height (200 m and more) above the map.
    if (summary.source.groundFit === "surface") return this.fitSurfaceToGround(tileset, 0.5, 8, summary.centre);
    if (summary.source.groundFit !== "street") return;
    // Cities: the lowest surfaces the camera can hit are streets and squares. Tile bounding
    // boxes are no help here: they reach far below the streets, which lifted Lyon ~80 m.
    return this.fitSurfaceToGround(tileset, 0.1, 1, summary.centre);
  }

  /**
   * Fit for lidar and photogrammetry, which have ground points everywhere: sample the
   * dataset's own surface (globe hidden) and the terrain on a grid, and move the dataset so
   * its lower surfaces (bare ground, not tree tops or roofs) meet the terrain.
   */
  private async fitSurfaceToGround(tileset: Cesium3DTileset, quantile = 0.5, minOffset = 8, centre?: { lat: number; lon: number }): Promise<void> {
    // First over the tile tree's finest tiles; if too few samples land on the data (holes,
    // or volumes that still mislead), a tighter grid once the view's tiles are in, then a
    // 600 m square on the model's recorded centre. Never silently: a fit that cannot
    // measure says so in Properties.
    const fp = dataFootprint(tileset);
    let diffs = await this.groundGaps(fp.center, fp.radius * 0.5);
    if (this.tileset !== tileset) return;
    let attempts = 1;
    if (diffs.gaps.length < MIN_FIT_SAMPLES) {
      await this.tilesSettled(tileset);
      if (this.tileset !== tileset) return;
      diffs = await this.groundGaps(fp.center, fp.radius * 0.25);
      attempts = 2;
      if (this.tileset !== tileset) return;
    }
    if (diffs.gaps.length < MIN_FIT_SAMPLES && centre) {
      diffs = await this.groundGaps(Cartesian3.fromDegrees(centre.lon, centre.lat), 300);
      attempts = 3;
      if (this.tileset !== tileset) return;
    }
    const { gaps, total, centre: c } = diffs;
    const report: GroundFitReport = { hits: gaps.length, samples: total, attempts, gap: null, geoid: null, offset: 0, ok: gaps.length >= MIN_FIT_SAMPLES };
    if (!report.ok) {
      this.groundFit.set(report);
      return;
    }
    // Lidar heights are usually better than a 30 m terrain model, which smooths valleys and
    // ridges by metres. So only a clear, consistent gap is corrected: that is a height-datum
    // mismatch (ellipsoid vs geoid is 20–50 m in Europe and the Middle East).
    // Cities use a low quantile (streets, not roofs) and any gap over 1 m.
    const gap = gaps[Math.floor(gaps.length * quantile)]!;
    // On terrain, a gap close to the geoid height (or to none) is a datum difference: take
    // the exact value rather than the noisy measurement. The ellipsoid has no datum to match.
    const flat = this.groundTerrain instanceof EllipsoidTerrainProvider && !this.userDems.length;
    const geoid = geoidHeight(CMath.toDegrees(c.latitude), CMath.toDegrees(c.longitude));
    const offset = flat ? -gap : datumShift(gap, geoid);
    Object.assign(report, { gap, geoid: flat ? null : geoid, offset: Math.abs(offset) > minOffset ? offset : 0 });
    if (Math.abs(offset) > minOffset) this.setGroundOffset(offset);
    this.groundFit.set(report);
  }

  /**
   * Dataset surface minus terrain on a 9 × 9 grid of half-width `half` metres around a point,
   * sorted.
   */
  private async groundGaps(at: Cartesian3, half: number): Promise<{ gaps: number[]; total: number; centre: Cartographic }> {
    const scene = this.widget.scene;
    const c = Cartographic.fromCartesian(at);
    const dLat = half / 6371000;
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
    const gaps = surf
      .map((s, k) => (s && Number.isFinite(s.height) ? s.height - (ground[k]?.height ?? NaN) : NaN))
      // A sample that misses the dataset can hit the far side of the globe: drop those.
      .filter((d) => Number.isFinite(d) && Math.abs(d) < 500)
      .sort((a, b) => a - b);
    return { gaps, total: pts.length, centre: c };
  }

  /** Resolves once the tileset has loaded what the view needs, or after 8 s. */
  private tilesSettled(tileset: Cesium3DTileset): Promise<void> {
    if (tileset.tilesLoaded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = tileset.allTilesLoaded.addEventListener(() => (off(), clearTimeout(timer), resolve()));
      const timer = setTimeout(() => (off(), resolve()), 8000);
      this.widget.scene.requestRender();
    });
  }

  /** Resolves after the first frame that draws one of the tileset's tiles (or once it is closed). */
  private firstDrawn(tileset: Cesium3DTileset): Promise<void> {
    const scene = this.widget.scene;
    return new Promise((resolve) => {
      this.frameWaiters++;
      const off = scene.postRender.addEventListener(() => {
        if (this.tileset !== tileset || tileset.isDestroyed() || (tileset as unknown as { statistics: { selected: number } }).statistics.selected > 0) {
          off();
          this.frameWaiters--;
          resolve();
        }
      });
      scene.requestRender();
    });
  }

  /** Shift the open 3D Tiles dataset up or down along the local vertical. */
  setGroundOffset(metres: number): void {
    this.groundOffset.set(metres);
    this.scheduleGroundCutShift();
    const m = this.current.get();
    const placed = this.model ?? (m?.source.localFrame ? this.tileset : null);
    if (placed && m?.placement) {
      placed.modelMatrix = this.model ? placeMatrix(m.placement, this.modelBaseHeight + metres) : localTilesetMatrix(m, m.placement, this.modelBaseHeight + metres);
      this.widget.scene.requestRender();
      return;
    }
    const t = this.tileset ?? this.model;
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

  /**
   * Caps the GPU memory 3D Tiles may hold (NFR-04: 10 GB by default, configurable). Tiles the
   * view no longer needs are unloaded once three quarters of the cap is used; if the view itself
   * needs more than the cap, the tileset draws coarser tiles rather than go over it.
   */
  setMemoryBudget(bytes: number): void {
    const previous = this.memoryBudget;
    this.memoryBudget = Math.max(16 * 1024 ** 2, bytes);
    const ts = this.tileset;
    if (!ts) return;
    Object.assign(ts, this.budgetSplit());
    // Cesium only coarsens while new tiles wait to load, and never drops tiles the view uses.
    // When the cap falls below what is held now, coarsen at once so those tiles can go.
    const over = ts.totalMemoryUsageInBytes / this.memoryBudget;
    // Raised, detail comes straight back (Cesium alone would step it back 2% a frame).
    if (this.memoryBudget > previous) ts.maximumScreenSpaceError = ts.maximumScreenSpaceError;
    else if (over > 1) {
      const t = ts as unknown as { _memoryAdjustedScreenSpaceError: number };
      t._memoryAdjustedScreenSpaceError = Math.max(t._memoryAdjustedScreenSpaceError, ts.maximumScreenSpaceError * over * 2);
    }
    this.widget.scene.requestRender();
  }

  /** Cesium's two limits, which together make the cap: unused tiles go above the first, detail drops above the sum. */
  private budgetSplit(): { cacheBytes: number; maximumCacheOverflowBytes: number } {
    return { cacheBytes: Math.round(this.memoryBudget * 0.75), maximumCacheOverflowBytes: Math.round(this.memoryBudget * 0.25) };
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const scene = this.widget.scene;
    this.baseScale = { low: 0.75, balanced: 1, high: 1, ultra: Math.min(2, window.devicePixelRatio || 1) }[q];
    this.setResolution(this.baseScale);
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

  /**
   * Arranges the open model's layers as a saved manifest says (WP 2.1); null goes back to the
   * file's own tree. Opening a model clears it, so set it once the model is open (or while it
   * loads); every part is shown again.
   */
  setLayerManifest(manifest: LayerManifest | null): void {
    this.manifest = manifest;
    if (this.derivedLayers.length) this.setLayers(applyManifest(this.derivedLayers, manifest));
  }

  /** The open model's layers as the layer editor edits them (WP 4.3): the file's tree as the saved manifest arranges it. */
  editableLayers(): EditLayer[] {
    return editableTree(this.derivedLayers, this.manifest);
  }

  setLayers(next: Layer[]): void {
    this.layers.set(next);
    const vis = effectiveVisibility(next);
    if (this.tileset && this.tilesetParts) {
      const hidden = new Set<number>();
      walk(next, (l) => {
        if (vis.get(l.id) === false) for (const n of layerNodes(l)) hidden.add(n);
      });
      // Evaluated per feature as tiles load; the property is the part's node in the original.
      this.tileset.style = hidden.size ? Object.assign(new Cesium3DTileStyle(), { show: { evaluate: (f: Cesium3DTileFeature) => !hidden.has(Number(f.getProperty("node"))) } }) : undefined;
    } else if (this.tileset) this.tileset.show = vis.get("tileset") ?? true;
    if (this.model) {
      // By glTF node index, so parts that share a name toggle on their own too.
      const runtime = (this.model as unknown as { sceneGraph?: { _runtimeNodes?: ({ show: boolean } | undefined)[] } }).sceneGraph?._runtimeNodes;
      walk(next, (l) => {
        const shown = vis.get(l.id) ?? true;
        const nodes = layerNodes(l).map((n) => runtime?.[n]);
        if (nodes.length && nodes.every((n) => !!n)) for (const n of nodes) n!.show = shown;
        else if (l.nodeName) {
          try {
            const named = this.model!.getNode(l.nodeName);
            if (named) named.show = shown;
          } catch {
            /* node not addressable */
          }
        }
      });
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

  /** Asks the hover to be worked out again at the last cursor position. */
  private rehover: (() => void) | null = null;

  /**
   * Where a measurement point goes for a cursor position: the corner or edge within 10 px, else
   * the surface. free (Alt held) places it on the surface without snapping.
   */
  measurePoint(at: { x: number; y: number }, free = false): Snap | undefined {
    // A real Cartesian2: Cesium caches pickPosition per frame by the position's text.
    const pos = new Cartesian2(at.x, at.y);
    const surface = this.pick(pos);
    if (free || !this.snapper.enabled.get()) return surface ? { position: surface, kind: "surface", pixels: 0 } : undefined;
    return this.snapper.snap(pos, surface);
  }

  /**
   * A point placed on a tileset sits on the level of detail drawn, which away from the camera can
   * be a simplified surface. Ask for the full-detail tiles along the same ray, and move the point
   * onto them when they come (WP 2.4). Corners and edges stay where they were snapped.
   */
  private refineOnTiles(pos: Cartesian2, placed: Cartesian3): void {
    const tileset = this.tileset;
    const scene = this.widget.scene;
    // Public in Cesium's source but left out of its typings: the async form of pickFromRay.
    const mostDetailed = (scene as unknown as {
      pickFromRayMostDetailed?: (ray: Ray, exclude?: unknown[]) => Promise<{ object?: unknown; position?: Cartesian3 } | undefined>;
    }).pickFromRayMostDetailed;
    if (!tileset || !mostDetailed) return;
    const ray = scene.camera.getPickRay(pos);
    if (!ray) return;
    const before = Cartesian3.distance(ray.origin, placed);
    const onTiles = (o: unknown) => {
      // A feature of the tileset, or the model of one of its tiles.
      const x = o as { primitive?: { _content?: { tileset?: unknown } }; tileset?: unknown; content?: { tileset?: unknown } } | undefined;
      return !!x && (x.primitive === tileset || x.tileset === tileset || x.content?.tileset === tileset || x.primitive?._content?.tileset === tileset);
    };
    // Whatever else is first on the ray (a label, the outline of a part) is passed over, a few times at most.
    const exclude: unknown[] = [...this.widget.entities.values];
    const attempt = async (tries: number): Promise<void> => {
      const hit = await mostDetailed.call(scene, ray, exclude);
      if (!hit?.position || this.tileset !== tileset) return;
      if (!onTiles(hit.object)) {
        const other = (hit.object as { primitive?: unknown } | undefined)?.primitive ?? hit.object;
        if (other && tries > 1) {
          exclude.push(other);
          return attempt(tries - 1);
        }
        return;
      }
      // The same surface, finer: a coarse level is off by its geometric error, not by more
      // than a twentieth of the distance. Anything farther is something else on the ray.
      const after = Cartesian3.distance(ray.origin, hit.position);
      if (Math.abs(after - before) > Math.max(1, before * 0.05)) return;
      if (this.measure.replacePoint(placed, hit.position)) scene.requestRender();
    };
    void attempt(3).catch(() => undefined);
  }

  private bindPointer(): void {
    const canvas = this.widget.canvas;
    let pending: Cartesian2 | null = null;
    let last: Cartesian2 | null = null;
    let alt = false;
    let downAt: { x: number; y: number } | null = null;
    canvas.addEventListener("pointermove", (e) => {
      pending = last = new Cartesian2(e.offsetX, e.offsetY);
      alt = e.altKey;
    });
    this.rehover = () => {
      if (last && this.measure.active.get()) pending = last;
    };
    // Alt pressed or let go over a still cursor changes the snap: look again.
    for (const type of ["keydown", "keyup"] as const) {
      window.addEventListener(type, (e) => {
        if (e.key !== "Alt" || alt === e.altKey) return;
        alt = e.altKey;
        this.rehover?.();
        this.widget.scene.requestRender();
      });
    }
    canvas.addEventListener("pointerleave", () => {
      pending = last = null;
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
        const p = this.measurePoint(pos, e.altKey);
        // A surface point from the triangles, not the depth buffer (NFR-07: 1 cm).
        const at = p?.kind === "surface" ? (this.snapper.onMesh(pos, p.position) ?? p.position) : p?.position;
        const kept = at && this.measure.addPoint(at);
        // A tileset draws coarse levels farther off: measure on its full detail (NFR-07).
        if (kept && p?.kind === "surface") this.refineOnTiles(pos, kept);
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
      this.selectAt(pos);
    });
    canvas.addEventListener("dblclick", () => {
      if (this.measure.active.get() === "path") this.measure.finish();
    });
    // After the frame, so the picks read the depth of the frame just drawn.
    this.widget.scene.postRender.addEventListener(() => {
      if (!pending) return;
      const pos = pending;
      pending = null;
      // While measuring, the point shown is where a click would put it: snapped, even just off
      // the model's outline.
      const snap = this.measure.active.get() ? this.measurePoint(pos, alt) : undefined;
      const p = snap ? snap.position : this.pick(pos);
      if (!p) {
        this.cursor.set(null);
        this.measure.setHover(undefined);
        return;
      }
      const c = Cartographic.fromCartesian(p);
      if (!c) return;
      this.cursor.set({ lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude), height: c.height, onModel: true });
      this.measure.setHover(p, snap);
      this.sight.setHover(p);
    });
  }

  /**
   * Keeps the view drawing for a while: for a change that takes several frames to show (a new
   * outline's geometry is built in a worker, a fade). Every engine command and every input on
   * the page does this, so callers rarely need to.
   */
  keepDrawing(ms = 500): void {
    this.drawUntil = Math.max(this.drawUntil, performance.now() + ms);
    this.requestFrame();
  }

  /**
   * Render on demand. Cesium draws a frame when the camera moves, data loads or a frame is
   * asked for; on top of that the view keeps drawing for a moment after each engine command,
   * each input on the page and each asked-for frame, and for as long as the model, its tiles,
   * the ground or the entities are still loading. A still view draws nothing.
   */
  private drawOnDemand(): void {
    const scene = this.widget.scene;
    const request = scene.requestRender.bind(scene);
    this.requestFrame = request;
    scene.requestRender = () => {
      if (!this.inFrame) this.drawUntil = Math.max(this.drawUntil, performance.now() + 300);
      request();
    };
    scene.preUpdate.addEventListener(() => {
      this.inFrame = true;
      queueMicrotask(() => (this.inFrame = false));
    });
    const loading = () =>
      this.frameWaiters > 0 ||
      this.loading.get() ||
      (!!this.model && !this.model.ready) ||
      (!!this.tileset && !this.tileset.tilesLoaded) ||
      this.splatsSettling() ||
      (scene.globe.show && !scene.globe.tilesLoaded) ||
      !(this.widget as unknown as { dataSourceDisplay: { ready: boolean } }).dataSourceDisplay.ready;
    const more = () => performance.now() < this.drawUntil || loading();
    // Looked at on every tick, drawn or not, so a load that starts between frames is drawn.
    scene.postUpdate.addEventListener(() => {
      if (more()) request();
    });
    scene.postRender.addEventListener(() => {
      if (this.splatFrames > 0) this.splatFrames--;
      const next = more();
      if (!next && this.drawing) {
        // Still: no frame rate to show until it draws again.
        this.frames = 0;
        this.lastFpsTime = performance.now();
        this.fps.set(0);
      }
      this.drawing = next;
    });
    // Every command draws: engine methods (and its tools') change the scene in many ways.
    const commands = (o: object, skip: string[]) => {
      const proto = Object.getPrototypeOf(o) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (name === "constructor" || skip.includes(name) || typeof d?.value !== "function") continue;
        const fn = d.value as (...a: unknown[]) => unknown;
        Object.defineProperty(o, name, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            const r = fn.apply(o, args);
            if (!this.inFrame) {
              this.keepDrawing();
              if (r instanceof Promise) void r.then(() => this.keepDrawing(), () => this.keepDrawing());
            }
            return r;
          },
        });
      }
    };
    commands(this, ["afterFrame", "updatePerf", "keepDrawing", "drawOnDemand", "destroy", "splatsSettling"]);
    for (const tool of [this.measure, this.sight, this.viewshed, this.userLayers, this.lod]) commands(tool, ["destroy"]);
    // And every input on the page: the interface changes what is drawn.
    const wake = () => this.keepDrawing();
    const types = ["pointerdown", "pointerup", "wheel", "keydown", "keyup", "input", "change", "click"];
    for (const type of types) window.addEventListener(type, wake, { capture: true, passive: true });
    this.widget.canvas.addEventListener("pointermove", wake, { passive: true });
    this.offInput = () => types.forEach((type) => window.removeEventListener(type, wake, { capture: true }));
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
    // Drawn on demand: only the time between two frames drawn back to back is a frame time.
    if (this.drawing && this.lastFrameAt) this.frameTimes.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    this.trackCameraMove(now);
    if (now - this.lastFpsTime >= 500) {
      this.fps.set(Math.round((this.frames * 1000) / (now - this.lastFpsTime)));
      this.frames = 0;
      this.lastFpsTime = now;
      this.updatePerf();
    }
    const cam = this.widget.camera;
    // Only when the camera has moved, or the ground was not there yet: the scale needs a pick on the globe.
    const pose = [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z, cam.directionWC.x, cam.directionWC.y, cam.directionWC.z];
    const still = this.lastPose && pose.every((v, i) => Math.abs(v - this.lastPose![i]!) < 1e-3);
    // While the camera is still, the ground under it can still sharpen as tiles arrive: look
    // again twice a second, not every frame.
    if (still && now - this.lastScaleAt < 500) return;
    const scale = this.camera.metresPerPixelAtCentre();
    this.lastPose = pose;
    this.lastScaleAt = now;
    const carto = Cartographic.fromCartesian(cam.positionWC);
    const prev = this.cameraInfo.get();
    const next = {
      heading: cam.heading,
      pitch: cam.pitch,
      metresPerPixel: scale.metresPerPixel,
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

  private setResolution(scale: number): void {
    this.widget.resolutionScale = scale;
    this.resolutionChangedAt = performance.now();
    this.widget.scene.requestRender();
  }

  /**
   * Notes when the camera moves. Once it has been still for a moment, a resolution lowered
   * while it moved goes back to the preset, in one step (and one frame is drawn for it).
   */
  private trackCameraMove(now: number): void {
    const cam = this.widget.camera;
    const pose = [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z, cam.directionWC.x, cam.directionWC.y, cam.directionWC.z];
    const moved = !this.movePose || pose.some((v, i) => Math.abs(v - this.movePose![i]!) > 1e-3);
    this.movePose = pose;
    if (!moved) return;
    this.cameraMovedAt = now;
    if (this.widget.resolutionScale >= this.baseScale - 1e-3) return;
    clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      if (performance.now() - this.cameraMovedAt >= 300 && this.widget.resolutionScale < this.baseScale) this.setResolution(this.baseScale);
    }, 350);
  }

  private updatePerf(): void {
    // Pauses over 5 s (a hidden tab) are not frames. Slow frames accumulate until there are three.
    const times = this.frameTimes.filter((t) => t < 5000);
    if (times.length < 3) return;
    this.frameTimes = [];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const now = performance.now();
    const worst = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)] ?? avg;
    // Adaptive resolution: lowered while the view moves and frames are slow, restored once it is still.
    if (this.adaptiveResolution) {
      const s = this.widget.resolutionScale;
      const next = nextResolutionScale({
        scale: s,
        base: this.baseScale,
        avgFrameMs: avg,
        moving: now - this.cameraMovedAt < 300,
        now,
        changedAt: this.resolutionChangedAt,
      });
      if (Math.abs(next - s) > 1e-3) this.setResolution(next);
    } else if (this.widget.resolutionScale !== this.baseScale) this.setResolution(this.baseScale);
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
 * Where a model or local-frame tileset stands: x east, y north, z up, turned by the heading
 * (packages/core/src/geo/place.ts). Models load with Cesium's forward axis X, so a Y-up glTF
 * has east +X and north −Z, and a Z-up file east +X and north +Y, as the tools that wrote them
 * meant; the tiler bakes the same orientation into tiles (apps/server/src/tiler.ts).
 */
/**
 * The placement as a model matrix: the local east-north-up frame, with the heights stretched by
 * verticalFactor (the model's uniform scale and up axis come after it, inside the model).
 */
function placeMatrix(p: NonNullable<ModelSummary["placement"]>, height: number): Matrix4 {
  const m = Matrix4.fromArray(placementFrame(p, height));
  const k = p.verticalFactor;
  return k && k !== 1 && Number.isFinite(k) ? Matrix4.multiplyByScale(m, new Cartesian3(1, 1, k), m) : m;
}

/**
 * A local-frame tileset's model matrix. Our tiler bakes scale and up axis into its tiles; splat
 * tiles keep the trainer's frame, so their scale (from a known real dimension) and up axis are
 * applied here, after the placement.
 */
function localTilesetMatrix(m: ModelSummary, p: NonNullable<ModelSummary["placement"]>, height: number): Matrix4 {
  const out = placeMatrix(p, height);
  if (!m.source.splats) return out;
  // Splat content is glTF y-up, drawn by Cesium as z-up; a file whose own z is up turns once more.
  if (p.upAxis === "z") Matrix4.multiply(out, Matrix4.fromRotation(Matrix3.fromRotationX(-CMath.PI_OVER_TWO)), out);
  const k = p.scale ?? 1;
  if (k !== 1 && Number.isFinite(k) && k > 0) Matrix4.multiplyByUniformScale(out, k, out);
  return out;
}

/**
 * Gaussian splats are decoded and depth-sorted off the main thread, and Cesium shows them only
 * once a sort has been committed in a later frame. Drawn on demand, that frame would never come
 * once the tiles had loaded (SRS GS-15: the scene stays visible after asynchronous decoding and
 * sorting), so the engine keeps drawing while a splat primitive has work in flight.
 */
function splatsBusy(tileset: Cesium3DTileset): boolean {
  const p = (tileset as unknown as { gaussianSplatPrimitive?: { _sorterState?: number; _dirty?: boolean; _gaussianSplatTexturePending?: boolean; _pendingSnapshot?: unknown; _needsSnapshotRebuild?: boolean; _hasGaussianSplatTexture?: boolean; _numSplats?: number } }).gaussianSplatPrimitive;
  if (!p) return false;
  return !!(p._sorterState || p._dirty || p._gaussianSplatTexturePending || p._pendingSnapshot || p._needsSnapshotRebuild || (p._numSplats && !p._hasGaussianSplatTexture));
}

/** The floater-free bounds the splat packager writes in tileset extras, as a sphere in the tileset frame. */
function splatFocus(tileset: Cesium3DTileset): BoundingSphere | null {
  const f = (tileset.extras as { holo?: { focus?: { min: number[]; max: number[] } } } | undefined)?.holo?.focus;
  if (!f || f.min.length !== 3 || f.max.length !== 3 || ![...f.min, ...f.max].every(Number.isFinite)) return null;
  // glTF (x, y, z) is the tileset's (x, −z, y).
  const c = [0, 1, 2].map((a) => (f.min[a]! + f.max[a]!) / 2);
  const r = Math.hypot(f.max[0]! - f.min[0]!, f.max[1]! - f.min[1]!, f.max[2]! - f.min[2]!) / 2;
  return new BoundingSphere(new Cartesian3(c[0], -c[2]!, c[1]), Math.max(r, 0.01));
}

function friendlyReason(err: Error): string {
  const ext = /Unsupported glTF Extension: ([\w-]+)/.exec(err.message);
  if (ext) return `This model needs the glTF extension ${ext[1]}, which HOLO cannot read.`;
  const m = `${err.name} ${err.message}`.toLowerCase();
  if (m.includes("404") || m.includes("not found")) return "The file, or a file it references, could not be found.";
  if (/json\.parse|unexpected token|in json|not valid json/.test(m)) return "The file is not valid glTF or 3D Tiles JSON.";
  if (m.includes("magic") || /invalid glb|glb (header|version)/.test(m)) return "The file is not a valid GLB.";
  if (m.includes("version")) return "This file uses a version HOLO does not support.";
  return "The file is damaged or in a format HOLO cannot read.";
}

/** A fit needs this many of its 81 samples on both the dataset and the terrain. */
const MIN_FIT_SAMPLES = 5;

export interface GroundFitReport {
  /** Samples that hit both the dataset and the terrain, of `samples`. */
  hits: number;
  samples: number;
  /** 1; 2 when a tighter grid was tried; 3 when the model's recorded centre was tried too. */
  attempts: number;
  /** False when too few samples hit the data to measure: the offset was left at 0. */
  ok: boolean;
  /** Measured gap (dataset minus terrain at the fit's quantile), metres. */
  gap: number | null;
  /** Geoid height used to recognise a datum difference; null on the bare ellipsoid. */
  geoid: number | null;
  /** The shift applied, metres. */
  offset: number;
}
