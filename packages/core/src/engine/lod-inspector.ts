import { Cesium3DTileColorBlendMode, Color, ColorBlendMode, type Cesium3DTile, type Cesium3DTileset, type Scene } from "cesium";
import { signal } from "../signal";

/**
 * Level-of-detail inspector for 3D Tiles (VWR-LOD-01, plan WP 2.10).
 * Shows which tiles are drawn and how deep in the hierarchy they are, lets the user
 * trade detail for speed (screen-space error), and freeze the selection to fly around it.
 */

export interface LodStats {
  /** Tiles drawn this frame. */
  drawn: number;
  /** Deepest level drawn, root = 0. */
  maxDepth: number;
  /** Number of drawn tiles per depth. */
  perDepth: number[];
  /** Points drawn (point clouds) and triangles (meshes). */
  points: number;
  triangles: number;
  /** GPU memory for geometry and textures, bytes. */
  memory: number;
  /** Tiles still being requested. */
  loading: number;
}

export interface LodSettings {
  sse: number;
  colorByDepth: boolean;
  bounds: boolean;
  freeze: boolean;
}

/** Depth ramp, shallow (coarse) to deep (fine): one hue from light to dark, then a second. */
const RAMP = ["#FFE8A3", "#FFC66B", "#FF9F4A", "#F2703F", "#D9463E", "#B02A4D", "#7E1F5C", "#52205F", "#2E1F57", "#1B2A57"].map((c) => Color.fromCssColorString(c));

export class LodInspector {
  readonly stats = signal<LodStats | null>(null);
  readonly settings = signal<LodSettings>({ sse: 8, colorByDepth: false, bounds: false, freeze: false });
  private tileset: Cesium3DTileset | null = null;
  private frame: { perDepth: number[]; drawn: number } = { perDepth: [], drawn: 0 };
  private offVisible: (() => void) | null = null;
  private offFrame: (() => void) | null = null;
  private lastPush = 0;

  constructor(private readonly scene: Scene) {}

  attach(tileset: Cesium3DTileset | null): void {
    this.offVisible?.();
    this.offFrame?.();
    this.offVisible = this.offFrame = null;
    this.tileset = tileset;
    this.stats.set(null);
    if (!tileset) return;
    this.apply();
    this.offVisible = tileset.tileVisible.addEventListener((tile: Cesium3DTile) => {
      const d = depthOf(tile);
      this.frame.perDepth[d] = (this.frame.perDepth[d] ?? 0) + 1;
      this.frame.drawn++;
      if (this.settings.get().colorByDepth) tint(tile, RAMP[Math.min(d, RAMP.length - 1)]!);
    });
    this.offFrame = this.scene.postRender.addEventListener(() => this.collect());
  }

  set(patch: Partial<LodSettings>): void {
    const was = this.settings.get();
    this.settings.set({ ...was, ...patch });
    this.apply();
    // Turning the colouring off restores the tiles' own colours.
    if (was.colorByDepth && patch.colorByDepth === false) this.forEachLoaded((t) => tint(t, Color.WHITE));
  }

  private apply(): void {
    const t = this.tileset;
    if (!t) return;
    const s = this.settings.get();
    t.maximumScreenSpaceError = s.sse;
    t.debugShowBoundingVolume = s.bounds;
    t.debugFreezeFrame = s.freeze;
    t.colorBlendMode = s.colorByDepth ? Cesium3DTileColorBlendMode.REPLACE : Cesium3DTileColorBlendMode.HIGHLIGHT;
    this.scene.requestRender();
  }

  private collect(): void {
    const t = this.tileset;
    if (!t) return;
    const f = this.frame;
    this.frame = { perDepth: [], drawn: 0 };
    const now = performance.now();
    if (now - this.lastPush < 400) return;
    this.lastPush = now;
    const st = (t as unknown as { statistics: Record<string, number> }).statistics;
    const perDepth = Array.from(f.perDepth, (x) => x ?? 0);
    this.stats.set({
      drawn: f.drawn,
      maxDepth: Math.max(0, perDepth.length - 1),
      perDepth,
      points: st.numberOfPointsSelected ?? 0,
      triangles: st.numberOfTrianglesSelected ?? 0,
      memory: (st.geometryByteLength ?? 0) + (st.texturesByteLength ?? 0),
      loading: (st.numberOfPendingRequests ?? 0) + (st.numberOfTilesProcessing ?? 0),
    });
  }

  private forEachLoaded(fn: (t: Cesium3DTile) => void): void {
    const walk = (tile: Cesium3DTile) => {
      fn(tile);
      for (const c of tile.children) walk(c);
    };
    if (this.tileset) walk(this.tileset.root);
    this.scene.requestRender();
  }
}

function depthOf(tile: Cesium3DTile): number {
  let d = 0;
  for (let p = tile.parent; p; p = p.parent) d++;
  return d;
}

/** Colour a tile: every feature of a batched mesh, or the whole point cloud / model. */
function tint(tile: Cesium3DTile, c: Color): void {
  const content = tile.content as unknown as {
    featuresLength?: number;
    getFeature?: (i: number) => { color: Color };
    pointCloudShading?: unknown;
    _model?: { color?: Color; colorBlendMode?: ColorBlendMode };
  } | undefined;
  if (!content) return;
  const n = content.featuresLength ?? 0;
  if (n > 0 && content.getFeature) {
    for (let i = 0; i < n; i++) content.getFeature(i).color = c;
  } else if (content._model) {
    const off = Color.WHITE.equals(c);
    content._model.color = off ? undefined : c;
    content._model.colorBlendMode = off ? ColorBlendMode.HIGHLIGHT : ColorBlendMode.REPLACE;
  }
}
