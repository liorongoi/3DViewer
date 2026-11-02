import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  CesiumWidget,
  Color,
  CustomShader,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  JulianDate,
  LightingModel,
  Math as CMath,
  Model,
  NearFarScalar,
  PostProcessStageLibrary,
  type PostProcessStage,
  type PostProcessStageComposite,
  ScreenSpaceEventType,
  ShadowMode,
  TileMapServiceImageryProvider,
  Tonemapper,
  Transforms,
  buildModuleUrl,
  HorizontalOrigin,
  VerticalOrigin,
  LabelStyle,
  type Entity,
  HeightReference,
  DistanceDisplayCondition,
} from "cesium";
import type { ModelSummary, UpdateStatus } from "@viewer/shared";
import { CameraController } from "./camera-controller";
import { MeasureTool } from "./measure-tool";
import { FlyByTour, FlyMode, captureViewpoint, type Viewpoint } from "./fly";
import { signal } from "../signal";
import { effectiveVisibility, layersFromGltf, type Layer } from "../layers/layers";

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
export class ViewerEngine {
  readonly widget: CesiumWidget;
  readonly camera: CameraController;
  readonly measure: MeasureTool;
  readonly fly: FlyMode;
  readonly tour: FlyByTour;

  readonly cursor = signal<CursorInfo | null>(null);
  readonly cameraInfo = signal<CameraInfo>({ heading: 0, pitch: -0.5, metresPerPixel: 1, height: 0 });
  readonly fps = signal(0);
  readonly layers = signal<Layer[]>([]);
  readonly loading = signal(false);
  readonly error = signal<OpenError | null>(null);
  readonly current = signal<ModelSummary | null>(null);
  readonly viewMode = signal<ViewMode>("shaded");
  readonly viewpoints = signal<Viewpoint[]>([]);

  private model: Model | null = null;
  private tileset: Cesium3DTileset | null = null;
  private edges: PostProcessStageComposite | PostProcessStage | null = null;
  private pins: Entity[] = [];
  private pivotMarker: Entity | null = null;
  private onPinClick: ((id: string) => void) | null = null;
  private baseLayer: ImageryLayer | null = null;
  private frames = 0;
  private lastFpsTime = performance.now();
  private quality: Quality = "high";
  private shadowsWanted = true;

  static async create(container: HTMLElement): Promise<ViewerEngine> {
    // No Cesium ion, no Bing, no external requests: everything is bundled (NFR-12).
    Ion.defaultAccessToken = "";
    const imagery = await TileMapServiceImageryProvider.fromUrl(buildModuleUrl("Assets/Textures/NaturalEarthII"));
    return new ViewerEngine(container, new ImageryLayer(imagery));
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
    this.baseLayer = baseLayer;
    const scene = this.widget.scene;
    scene.postProcessStages.fxaa.enabled = true;
    scene.postProcessStages.tonemapper = Tonemapper.PBR_NEUTRAL;
    scene.highDynamicRange = true;
    scene.pickTranslucentDepth = true;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.baseColor = Color.fromCssColorString("#1B1D21");
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
      isToolActive: () => this.measure.active.get() !== null,
      onPivotSet: (p) => this.showPivot(p),
    });
    this.camera.onMoveStart = () => this.setMovingQuality(true);
    this.camera.onMoveEnd = () => this.setMovingQuality(false);
    this.measure = new MeasureTool(this.widget.entities, () => scene.requestRender());
    this.fly = new FlyMode(scene, this.widget.canvas);
    this.tour = new FlyByTour(scene);

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
          maximumScreenSpaceError: 8,
          cacheBytes: 2 * 1024 ** 3,
          maximumCacheOverflowBytes: 1024 ** 3,
          shadows: ShadowMode.ENABLED,
        });
        if (this.current.get()?.id !== summary.id) return tileset.destroy();
        scene.primitives.add(tileset);
        this.tileset = tileset;
        this.layers.set([{ id: "tileset", name: summary.name, children: [], visible: true }]);
      } else {
        const place = summary.placement ?? { ...summary.centre, height: 0 };
        let gltfJson: unknown = null;
        const model = await Model.fromGltfAsync({
          url: summary.source.url,
          modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(place.lon, place.lat, place.height)),
          scale: place.scale ?? 1,
          shadows: ShadowMode.ENABLED,
          enableDebugWireframe: true,
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
    if (this.model) this.widget.scene.primitives.remove(this.model);
    if (this.tileset) this.widget.scene.primitives.remove(this.tileset);
    this.model = null;
    this.tileset = null;
    this.layers.set([]);
    this.current.set(null);
    this.error.set(null);
    this.applyPinVisibility();
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
    if (this.baseLayer) this.baseLayer.show = on;
  }

  setGlobe(on: boolean): void {
    this.widget.scene.globe.show = on;
    this.camera.maxPolarDeg = on ? 100 : 179;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const scene = this.widget.scene;
    this.widget.resolutionScale = { low: 0.75, balanced: 1, high: 1, ultra: Math.min(2, window.devicePixelRatio || 1) }[q];
    scene.msaaSamples = { low: 1, balanced: 2, high: 4, ultra: 8 }[q];
    scene.shadowMap.size = { low: 1024, balanced: 2048, high: 4096, ultra: 4096 }[q];
    scene.postProcessStages.ambientOcclusion.enabled = q === "ultra";
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
    if (this.baseLayer) {
      this.baseLayer.brightness = open ? 0.42 : 1;
      this.baseLayer.saturation = open ? 0.3 : 1;
      this.baseLayer.contrast = open ? 0.9 : 1;
    }
  }

  // ---------- picking & pointer ----------

  pick(pos: Cartesian2): Cartesian3 | undefined {
    const scene = this.widget.scene;
    if (scene.pickPositionSupported) {
      const p = scene.pickPosition(pos);
      if (p && Number.isFinite(p.x) && Cartesian3.magnitude(p) > 1000) return p;
    }
    return this.widget.camera.pickEllipsoid(pos) ?? undefined;
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
    });
    canvas.addEventListener("pointerdown", (e) => {
      downAt = { x: e.offsetX, y: e.offsetY };
    });
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
      const picked = this.widget.scene.pick(pos);
      const id = picked?.id?.id as string | undefined;
      if (id?.startsWith("pin:") && this.onPinClick) this.onPinClick(id.slice(4));
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
    if (now - this.lastFpsTime >= 500) {
      this.fps.set(Math.round((this.frames * 1000) / (now - this.lastFpsTime)));
      this.frames = 0;
      this.lastFpsTime = now;
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

  /** PNG of the current view; the UI burns the classification banner on top (UPL-10). */
  snapshot(): string {
    this.widget.render();
    return this.widget.canvas.toDataURL("image/png");
  }
}

function friendlyReason(err: Error): string {
  const m = `${err.name} ${err.message}`.toLowerCase();
  if (m.includes("404") || m.includes("not found")) return "The file, or a file it references, could not be found.";
  if (m.includes("json") || m.includes("unexpected token")) return "The file is not valid glTF or 3D Tiles JSON.";
  if (m.includes("magic") || m.includes("glb")) return "The file is not a valid GLB.";
  if (m.includes("version")) return "This file uses a version VIEWER does not support.";
  return "The file is damaged or in a format VIEWER cannot read.";
}
