// Snapping for measurement (WP 2.3, MSR-03): a point placed within 10 px of a corner or an edge
// of the model lands exactly on it.
//
// Cesium's own Scene.snap (experimental, risk R-08) finds edges only, and only in models that
// carry edge data (EXT_mesh_primitive_edge_visibility); ours rarely do. So snapping is our own:
// each mesh near the cursor gets an index of its corners and feature edges (snap-index.ts),
// built once in a worker from the geometry Cesium already holds. Each hover then:
//   1. takes the models drawn this frame, and of those the meshes whose bounds meet the cone;
//   2. walks their indexes for corners and edges inside the cone of rays within 10 px of the
//      cursor, and no deeper than the surface under it (what is behind the surface is hidden);
//   3. takes the nearest corner on screen, else the nearest point on an edge, else the surface,
//      after checking against the depth buffer that nothing is drawn in front of it.
import * as Cesium from "cesium";
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Matrix4,
  Model,
  OrthographicFrustum,
  OrthographicOffCenterFrustum,
  PrimitiveCollection,
  PrimitiveType,
  type Scene,
} from "cesium";
import { rayMeshHit } from "../measure/ray-mesh";
import { buildSnapIndex, querySnapIndex, type SnapGeometry, type SnapIndex } from "../measure/snap-index";
import { signal } from "../signal";

export type SnapKind = "vertex" | "edge" | "surface";

export interface Snap {
  position: Cartesian3;
  kind: SnapKind;
  /** Distance on screen from the cursor to the snapped point, in CSS pixels. */
  pixels: number;
}

// Cesium internals used here (exported from the package, without typings).
interface Attribute {
  quantization?: unknown;
}
interface MeshPrimitive {
  primitiveType?: number;
  indices?: { count: number };
  attributes: Attribute[];
  featureIds?: { setIndex?: number }[];
}
interface RuntimePrimitive {
  primitive: MeshPrimitive;
  boundingSphere?: BoundingSphere;
}
interface RuntimeNode {
  show: boolean;
  runtimePrimitives: RuntimePrimitive[];
}
interface Internals {
  ModelReader: {
    forEachPrimitive(
      model: Model,
      options: object,
      cb: (rp: RuntimePrimitive, p: MeshPrimitive, instances: { transform: Matrix4 }[], computed: Matrix4) => void,
    ): void;
    readAttributeAsTypedArray(a: Attribute): ArrayLike<number>;
    readIndicesAsTypedArray(i: unknown): ArrayLike<number>;
  };
  ModelUtility: { getAttributeBySemantic(p: MeshPrimitive, semantic: string, setIndex?: number): Attribute | undefined };
}
const internals = Cesium as unknown as Internals;

/** A part of a 3D Tiles tile: its features can be hidden by the tileset style. */
interface TileContent {
  featuresLength?: number;
  getFeature(id: number): { show: boolean } | undefined;
}

type Entry = { index: SnapIndex | null } | { pending: true };

/** Meshes up to this many triangles are indexed at once, on the main thread; larger ones in the worker. */
const SYNC_TRIANGLES = 20000;

export class Snapper {
  /** Snapping on or off (MSR-03). Holding Alt while placing a point turns it off for that point. */
  readonly enabled = signal(true);
  /** How close the cursor must be, in CSS pixels. */
  radius = 10;
  /** What the last snap looked at, for checks and diagnosis. */
  lastStats = { models: 0, meshes: 0, indexed: 0, corners: 0, edges: 0 };

  private readonly cache = new WeakMap<object, Entry>();
  private worker: Worker | null | undefined;
  /** Pending worker builds: called with the index, null when it failed, or undefined when the worker died. */
  private jobs = new Map<number, (index: SnapIndex | null | undefined) => void>();
  private nextJob = 1;
  private waiters: (() => void)[] = [];

  /** The tiles each tileset drew in the last frame (picks and height samples select others). */
  private drawnTiles = new WeakMap<object, unknown[]>();
  /** Tiles drawn so far in the frame being drawn, from each tileset's tileVisible event. */
  private drawing = new Map<Cesium3DTileset, Set<unknown>>();

  /** onIndexed is called when an index built in the worker is ready, so the hover can be redone. */
  constructor(private readonly scene: Scene, private readonly onIndexed: () => void) {
    scene.preRender.addEventListener(() => {
      const primitives = scene.primitives;
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (!(p instanceof Cesium3DTileset) || this.drawing.has(p)) continue;
        const tiles = new Set<unknown>();
        this.drawing.set(p, tiles);
        // Raised for each tile the render pass draws, and not for picks or height samples.
        p.tileVisible.addEventListener((tile: unknown) => void tiles.add(tile));
      }
      for (const tiles of this.drawing.values()) tiles.clear();
    });
    scene.postRender.addEventListener(() => {
      for (const [tileset, list] of this.drawing) {
        if (tileset.isDestroyed()) this.drawing.delete(tileset);
        else this.drawnTiles.set(tileset, [...list]);
      }
    });
  }

  /**
   * The snap target near a window position (CSS px). surface is the picked point under the
   * cursor, if any: corners and edges behind it are hidden by it.
   */
  snap(pos: Cartesian2, surface: Cartesian3 | undefined): Snap | undefined {
    const scene = this.scene;
    const camera = scene.camera;
    const ray = camera.getPickRay(pos);
    if (!ray) return surface ? { position: surface, kind: "surface", pixels: 0 } : undefined;
    const O = ray.origin;
    const D = Cartesian3.normalize(ray.direction, new Cartesian3());
    const frustum = camera.frustum;
    const ortho = frustum instanceof OrthographicFrustum || frustum instanceof OrthographicOffCenterFrustum;
    const pd = frustum.getPixelDimensions(scene.drawingBufferWidth, scene.drawingBufferHeight, 1, scene.drawingBufferWidth / Math.max(scene.canvas.clientWidth, 1), new Cartesian2()).y;
    // World size of one CSS pixel at distance t along the ray.
    const pixelAt = (t: number) => (ortho ? pd : pd * Math.max(t, 0));
    const tSurface = surface ? Cartesian3.dot(Cartesian3.subtract(surface, O, new Cartesian3()), D) : Number.POSITIVE_INFINITY;
    // Far behind the surface under the cursor is hidden by it. Not just behind: a corner at the
    // foot of a wall is further away than the ground in front of it that the cursor is on. The
    // depth check of each candidate decides the rest.
    const tMax = tSurface * 1.25 + pixelAt(tSurface) * this.radius;
    // Cone around the ray, wider than the aperture so corners just inside it are not culled.
    const reach = (t: number) => pixelAt(t) * this.radius * 2;

    const vertices: { p: Cartesian3; d: number }[] = [];
    const edges: { p: Cartesian3; d: number }[] = [];
    const scratch = new Cartesian2();
    const consider = (p: Cartesian3, list: { p: Cartesian3; d: number }[]) => {
      const t = Cartesian3.dot(Cartesian3.subtract(p, O, new Cartesian3()), D);
      if (t <= 0 || t > tMax) return;
      const s = scene.cartesianToCanvasCoordinates(p, scratch);
      if (!s) return;
      const d = Math.hypot(s.x - pos.x, s.y - pos.y);
      if (d <= this.radius) list.push({ p, d });
    };

    const stats = { models: 0, meshes: 0, indexed: 0, corners: 0, edges: 0 };
    this.lastStats = stats;
    for (const { model, content } of this.drawnModels()) {
      stats.models++;
      const bs = model.boundingSphere;
      if (bs && !this.coneMeets(O, D, bs.center, bs.radius, tMax, reach)) continue;
      const hidden = new Set<RuntimePrimitive>();
      for (const node of (model as unknown as { sceneGraph?: { _runtimeNodes: RuntimeNode[] } }).sceneGraph?._runtimeNodes ?? []) {
        if (node.show === false) for (const rp of node.runtimePrimitives) hidden.add(rp);
      }
      internals.ModelReader.forEachPrimitive(model, {}, (rp, primitive, instances, computed) => {
        if (hidden.has(rp)) return;
        if (rp.boundingSphere && instances.length === 1) {
          const bs = BoundingSphere.transform(rp.boundingSphere, computed, new BoundingSphere());
          if (!this.coneMeets(O, D, bs.center, bs.radius, tMax, reach)) return;
        }
        stats.meshes++;
        const index = this.indexOf(rp, primitive, content);
        if (!index) return;
        stats.indexed++;
        const featureShown = (f: number) => !content || f < 0 || content.getFeature(f)?.show !== false;
        for (const { transform } of instances) {
          const scale = Matrix4.getMaximumScale(transform);
          const c = new Cartesian3();
          querySnapIndex(
            index,
            (x0, y0, z0, x1, y1, z1) => {
              c.x = (x0 + x1) / 2;
              c.y = (y0 + y1) / 2;
              c.z = (z0 + z1) / 2;
              Matrix4.multiplyByPoint(transform, c, c);
              const h = Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.5 * scale;
              return this.coneMeets(O, D, c, h, tMax, reach);
            },
            (kind, i) => {
              stats[kind === "corner" ? "corners" : "edges"]++;
              if (kind === "corner") {
                if (!featureShown(index.cornerFeature[i]!)) return;
                const p = new Cartesian3(index.corners[i * 3]!, index.corners[i * 3 + 1]!, index.corners[i * 3 + 2]!);
                consider(Matrix4.multiplyByPoint(transform, p, p), vertices);
              } else {
                if (!featureShown(index.edgeFeature[i]!)) return;
                const e = index.edges;
                const a = Matrix4.multiplyByPoint(transform, new Cartesian3(e[i * 6]!, e[i * 6 + 1]!, e[i * 6 + 2]!), new Cartesian3());
                const b = Matrix4.multiplyByPoint(transform, new Cartesian3(e[i * 6 + 3]!, e[i * 6 + 4]!, e[i * 6 + 5]!), new Cartesian3());
                const p = closestOnSegmentToRay(a, b, O, D);
                if (p) consider(p, edges);
              }
            },
          );
        }
      });
    }

    for (const [list, kind] of [[vertices, "vertex"], [edges, "edge"]] as const) {
      list.sort((p, q) => p.d - q.d);
      // Nearest first; the first that nothing is drawn in front of wins.
      for (const c of list.slice(0, 4)) {
        if (this.inView(c.p, pixelAt)) return { position: c.p, kind, pixels: c.d };
      }
    }
    return surface ? { position: surface, kind: "surface", pixels: 0 } : undefined;
  }

  /**
   * The surface under a window position, from the triangles themselves rather than the depth
   * buffer, which is good to a few centimetres at a hundred metres (NFR-07 asks for 1 cm).
   * surface is the depth-buffer point; the triangle met nearest it along the ray is taken.
   * Undefined when no drawn triangle is near it (the globe, a point cloud).
   */
  onMesh(pos: Cartesian2, surface: Cartesian3): Cartesian3 | undefined {
    const scene = this.scene;
    const ray = scene.camera.getPickRay(pos);
    if (!ray) return undefined;
    const O = ray.origin;
    const D = Cartesian3.normalize(ray.direction, new Cartesian3());
    const tS = Cartesian3.dot(Cartesian3.subtract(surface, O, new Cartesian3()), D);
    if (!(tS > 0)) return undefined;
    const pd = scene.camera.frustum.getPixelDimensions(scene.drawingBufferWidth, scene.drawingBufferHeight, Math.max(tS, 1), scene.drawingBufferWidth / Math.max(scene.canvas.clientWidth, 1), new Cartesian2()).y;
    // How far the depth buffer can be off: its precision, and a few pixels across a slope.
    const tol = Math.max(0.05, tS * 0.003, pd * 4);
    let bestT = Number.POSITIVE_INFINITY;
    const inv = new Matrix4();
    const o = new Cartesian3();
    const d = new Cartesian3();
    for (const { model, content } of this.drawnModels()) {
      const bs = model.boundingSphere;
      if (bs && Cartesian3.distance(bs.center, surface) > bs.radius + tol) continue;
      const hidden = new Set<RuntimePrimitive>();
      for (const node of (model as unknown as { sceneGraph?: { _runtimeNodes: RuntimeNode[] } }).sceneGraph?._runtimeNodes ?? []) {
        if (node.show === false) for (const rp of node.runtimePrimitives) hidden.add(rp);
      }
      internals.ModelReader.forEachPrimitive(model, {}, (rp, primitive, instances, computed) => {
        if (hidden.has(rp)) return;
        if (rp.boundingSphere && instances.length === 1) {
          const b = BoundingSphere.transform(rp.boundingSphere, computed, new BoundingSphere());
          if (Cartesian3.distance(b.center, surface) > b.radius + tol) return;
        }
        const g = this.geometryOf(primitive, content);
        if (!g) return;
        const ids = g.featureIds;
        const skip = content && ids ? (tri: number) => content.getFeature(ids[g.indices[tri * 3]!]!)?.show === false : undefined;
        for (const { transform } of instances) {
          // In the mesh's own frame; with the direction carried through unnormalised, t stays in metres.
          Matrix4.inverse(transform, inv);
          Matrix4.multiplyByPoint(inv, O, o);
          Matrix4.multiplyByPointAsVector(inv, D, d);
          const hit = rayMeshHit(g.positions, g.indices, o, d, tS - tol, Math.min(tS + tol, bestT), skip);
          if (hit) bestT = hit.t;
        }
      });
    }
    return Number.isFinite(bestT) ? Cartesian3.add(O, Cartesian3.multiplyByScalar(D, bestT, new Cartesian3()), new Cartesian3()) : undefined;
  }

  /** Resolves when no index is being built. */
  whenIdle(): Promise<void> {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.jobs.clear();
  }

  // ---------- internals ----------

  /**
   * The models drawn this frame: loose models, and the tiles each tileset drew. No pick pass is
   * used to find them: a pick pass redraws the depth buffer for its small square, and the depth
   * tests that follow (the surface under the cursor, what hides a corner) would read that.
   */
  private drawnModels(): { model: Model; content?: TileContent }[] {
    const out: { model: Model; content?: TileContent }[] = [];
    type Content = TileContent & { _model?: Model; innerContents?: Content[] };
    const addContent = (c: Content | undefined) => {
      if (!c) return;
      if (c._model) out.push({ model: c._model, content: c });
      for (const inner of c.innerContents ?? []) addContent(inner);
    };
    const primitives = this.scene.primitives;
    const visit = (p: unknown) => {
      if (!p || (p as { show?: boolean }).show === false) return;
      if (p instanceof Model) {
        if (!p.isDestroyed()) out.push({ model: p });
      } else if (p instanceof Cesium3DTileset) {
        for (const tile of (this.drawnTiles.get(p) ?? []) as { content?: Content }[]) addContent(tile.content);
      } else if (p instanceof PrimitiveCollection) {
        for (let i = 0; i < p.length; i++) visit(p.get(i));
      }
    };
    for (let i = 0; i < primitives.length; i++) visit(primitives.get(i));
    return out.filter(({ model }) => model.ready && model.show && !model.isDestroyed());
  }

  /** Whether a sphere meets the cone of rays within the aperture, in front of the surface. */
  private coneMeets(O: Cartesian3, D: Cartesian3, c: Cartesian3, r: number, tMax: number, reach: (t: number) => number): boolean {
    const v = Cartesian3.subtract(c, O, new Cartesian3());
    const t = Cartesian3.dot(v, D);
    if (t + r <= 0 || t - r > tMax) return false;
    const perp = Math.sqrt(Math.max(Cartesian3.magnitudeSquared(v) - t * t, 0));
    return perp - r <= reach(t + r);
  }

  /** Nothing in the depth buffer is in front of the point (it is not hidden by other geometry). */
  private inView(p: Cartesian3, pixelAt: (t: number) => number): boolean {
    const scene = this.scene;
    if (!scene.pickPositionSupported) return true;
    const s = scene.cartesianToCanvasCoordinates(p, new Cartesian2());
    if (!s) return false;
    const q = scene.pickPosition(s);
    if (!q || !Number.isFinite(q.x)) return true;
    const eye = scene.camera.positionWC;
    const dp = Cartesian3.distance(eye, p);
    const dq = Cartesian3.distance(eye, q);
    return dq >= dp - Math.max(dp * 0.003, pixelAt(dp) * 3);
  }

  private indexOf(rp: RuntimePrimitive, primitive: MeshPrimitive, content: TileContent | undefined): SnapIndex | null {
    const known = this.cache.get(rp);
    if (known) return "index" in known ? known.index : null;
    const geometry = this.geometryOf(primitive, content);
    if (!geometry) {
      this.cache.set(rp, { index: null });
      return null;
    }
    if (geometry.indices.length / 3 <= SYNC_TRIANGLES || !this.workerReady()) {
      const index = buildSnapIndex(geometry);
      this.cache.set(rp, { index });
      return index;
    }
    this.cache.set(rp, { pending: true });
    const id = this.nextJob++;
    this.jobs.set(id, (index) => {
      // The worker died: forget the job, so the next hover builds it on the main thread.
      if (index === undefined) this.cache.delete(rp);
      else this.cache.set(rp, { index });
      this.onIndexed();
    });
    this.worker!.postMessage({ id, geometry });
    return null;
  }

  /** Triangles of a mesh as Cesium holds them (read back from the GPU when not kept). */
  private geometryOf(primitive: MeshPrimitive, content: TileContent | undefined): SnapGeometry | null {
    if (primitive.primitiveType !== undefined && primitive.primitiveType !== PrimitiveType.TRIANGLES) return null;
    try {
      const { ModelReader, ModelUtility } = internals;
      const position = ModelUtility.getAttributeBySemantic(primitive, "POSITION");
      if (!position) return null;
      const positions = ModelReader.readAttributeAsTypedArray(position);
      const count = positions.length / 3;
      const indices = primitive.indices ? ModelReader.readIndicesAsTypedArray(primitive.indices) : Uint32Array.from({ length: count - (count % 3) }, (_, i) => i);
      let featureIds: ArrayLike<number> | undefined;
      if (content && (content.featuresLength ?? 0) > 0) {
        const set = primitive.featureIds?.find((f) => f.setIndex !== undefined);
        const attr = set ? ModelUtility.getAttributeBySemantic(primitive, "_FEATURE_ID", set.setIndex) : undefined;
        if (attr) featureIds = ModelReader.readAttributeAsTypedArray(attr);
      }
      // Copies, so the worker gets its own and Cesium's arrays are left alone.
      return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), featureIds: featureIds ? Float64Array.from(featureIds) : undefined };
    } catch {
      return null;
    }
  }

  private workerReady(): boolean {
    if (this.worker !== undefined) return this.worker !== null;
    try {
      this.worker = new Worker(new URL("./snap-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; index?: SnapIndex; error?: string }>) => {
        const done = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        done?.(e.data.index ?? null);
        if (this.jobs.size === 0) for (const w of this.waiters.splice(0)) w();
      };
      this.worker.onerror = () => {
        // The worker failed to start: build on the main thread from now on.
        const jobs = [...this.jobs.values()];
        this.jobs.clear();
        this.worker?.terminate();
        this.worker = null;
        for (const done of jobs) done(undefined);
        for (const w of this.waiters.splice(0)) w();
      };
    } catch {
      this.worker = null;
    }
    return this.worker !== null;
  }
}

/** The point of segment a-b nearest the ray (origin O, unit direction D). */
export function closestOnSegmentToRay(a: Cartesian3, b: Cartesian3, O: Cartesian3, D: Cartesian3): Cartesian3 | undefined {
  const u = Cartesian3.subtract(b, a, new Cartesian3());
  const w = Cartesian3.subtract(a, O, new Cartesian3());
  const uu = Cartesian3.dot(u, u);
  if (uu === 0) return Cartesian3.clone(a);
  const ud = Cartesian3.dot(u, D);
  const uw = Cartesian3.dot(u, w);
  const dw = Cartesian3.dot(D, w);
  const den = uu - ud * ud;
  // Parallel to the ray: any point projects to the same place; take the nearer end.
  let s = den > 1e-12 * uu ? (ud * dw - uw) / den : 0;
  s = Math.min(Math.max(s, 0), 1);
  return Cartesian3.add(a, Cartesian3.multiplyByScalar(u, s, new Cartesian3()), new Cartesian3());
}
