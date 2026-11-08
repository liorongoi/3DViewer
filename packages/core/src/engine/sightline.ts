import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  Ellipsoid,
  EllipsoidGeodesic,
  HorizontalOrigin,
  LabelStyle,
  Model,
  PrimitiveCollection,
  PolylineDashMaterialProperty,
  Ray,
  VerticalOrigin,
  type BoundingSphere,
  type Entity,
  type EntityCollection,
  type Scene,
} from "cesium";
import { signal } from "../signal";

/**
 * Line of sight between point pairs, with a height profile per pair
 * (VWR-ANL-01, VWR-ANL-02, plan WP 2.8).
 *
 * Each pair has an observer A and a target B picked on any surface (terrain, models,
 * 3D Tiles). The eye is `aHeight` above A and the target point `bHeight` above B.
 * We sample the scene surface along the line and compare it with the straight 3D
 * sight line between the two points. Heights are ellipsoidal, so the straight line
 * already accounts for earth curvature; optional refraction lifts it by k·d(D−d)/2R.
 */

export interface ProfileSample {
  /** Distance from A along the ground, metres. */
  d: number;
  lon: number;
  lat: number;
  /** Bare terrain height. */
  ground: number;
  /** Highest surface: terrain, buildings, models. */
  surface: number;
  /** Height of the sight line at this distance. */
  sight: number;
}

export interface SightPair {
  id: string;
  /** Number shown on the map as A1 and B1, kept when the pair is renamed. */
  seq: number;
  name: string;
  a: { lon: number; lat: number; h: number };
  b: { lon: number; lat: number; h: number };
  aHeight: number;
  bHeight: number;
  visible: boolean | null;
  /** First point where the surface rises above the sight line. */
  block: ProfileSample | null;
  /** Highest clearance deficit along the line, metres (positive = blocked by that much). */
  worstDeficit: number;
  distance: number;
  profile: ProfileSample[];
  shown: boolean;
  computing: boolean;
}

const VISIBLE = Color.fromCssColorString("#3DD68C");
const BLOCKED = Color.fromCssColorString("#FF5A5F");
const R_EARTH = 6371000;
/** Rays for the objects along the line start this high, above any terrain or building. */
const RAY_TOP = 12000;

export class SightlineTool {
  readonly pairs = signal<SightPair[]>([]);
  readonly active = signal(false);
  readonly selected = signal<string | null>(null);
  /** Default heights for new pairs, metres above the picked surface. */
  readonly defaults = signal({ aHeight: 1.8, bHeight: 1.8, refraction: true });
  private draftA: { lon: number; lat: number; h: number } | null = null;
  private hover: Cartesian3 | null = null;
  private draftEntity: Entity | null = null;
  private drawn = new Map<string, Entity[]>();
  private seq = 0;
  /** Name for a new pair; the app sets it to the translated wording. */
  nameFor = (n: number): string => `Line of sight ${n}`;

  constructor(
    private readonly scene: Scene,
    private readonly entities: EntityCollection,
    private readonly sampleGround: (pts: Cartographic[]) => Promise<Cartographic[]>,
  ) {}

  start(): void {
    this.active.set(true);
    this.draftA = null;
  }

  cancel(): void {
    this.active.set(false);
    this.draftA = null;
    if (this.draftEntity) this.entities.remove(this.draftEntity);
    this.draftEntity = null;
  }

  setHover(p: Cartesian3 | null): void {
    this.hover = p;
  }

  /** Click handler while active: first click sets A, second sets B and computes. */
  addPoint(p: Cartesian3): void {
    const c = Cartographic.fromCartesian(p);
    const pt = { lon: (c.longitude * 180) / Math.PI, lat: (c.latitude * 180) / Math.PI, h: c.height };
    if (!this.draftA) {
      this.draftA = pt;
      const aPos = Cartesian3.fromDegrees(pt.lon, pt.lat, pt.h + this.defaults.get().aHeight);
      this.draftEntity = this.entities.add({
        polyline: {
          positions: new CallbackProperty(() => (this.hover ? [aPos, this.hover] : [aPos, aPos]), false),
          width: 2,
          material: new PolylineDashMaterialProperty({ color: Color.WHITE.withAlpha(0.8), dashLength: 12 }),
          depthFailMaterial: new PolylineDashMaterialProperty({ color: Color.WHITE.withAlpha(0.35), dashLength: 12 }),
        },
        position: aPos,
        point: { pixelSize: 9, color: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      return;
    }
    const d = this.defaults.get();
    const pair: SightPair = {
      id: `los-${++this.seq}`,
      seq: this.seq,
      name: this.nameFor(this.seq),
      a: this.draftA,
      b: pt,
      aHeight: d.aHeight,
      bHeight: d.bHeight,
      visible: null,
      block: null,
      worstDeficit: 0,
      distance: 0,
      profile: [],
      shown: true,
      computing: true,
    };
    if (this.draftEntity) this.entities.remove(this.draftEntity);
    this.draftEntity = null;
    this.draftA = null;
    this.pairs.set([...this.pairs.get(), pair]);
    this.selected.set(pair.id);
    void this.compute(pair.id);
  }

  update(id: string, patch: Partial<Pick<SightPair, "name" | "aHeight" | "bHeight" | "shown">>): void {
    this.pairs.set(this.pairs.get().map((p) => (p.id === id ? { ...p, ...patch } : p)));
    if ("aHeight" in patch || "bHeight" in patch) void this.compute(id);
    else this.draw(this.pairs.get().find((p) => p.id === id)!);
  }

  /** Deletes a pair. Returns it and where it was, so it can be put back. */
  remove(id: string): { pair: SightPair; index: number } | null {
    const list = this.pairs.get();
    const index = list.findIndex((p) => p.id === id);
    if (index < 0) return null;
    this.undraw(id);
    this.pairs.set(list.filter((p) => p.id !== id));
    if (this.selected.get() === id) this.selected.set(this.pairs.get().at(-1)?.id ?? null);
    return { pair: list[index]!, index };
  }

  /** Puts a deleted pair back where it was (undo). */
  restore(pair: SightPair, index: number): void {
    if (this.pairs.get().some((p) => p.id === pair.id)) return;
    const list = [...this.pairs.get()];
    list.splice(Math.min(index, list.length), 0, pair);
    this.pairs.set(list);
    this.selected.set(pair.id);
    this.draw(pair);
  }

  clear(): void {
    for (const id of this.drawn.keys()) this.undraw(id);
    this.pairs.set([]);
    this.selected.set(null);
  }

  /** Recompute every pair, e.g. after the terrain or the model changed. */
  recomputeAll(): void {
    for (const p of this.pairs.get()) void this.compute(p.id);
  }

  async compute(id: string): Promise<void> {
    const pair = this.pairs.get().find((p) => p.id === id);
    if (!pair) return;
    this.patch(id, { computing: true });
    const A = Cartographic.fromDegrees(pair.a.lon, pair.a.lat);
    const B = Cartographic.fromDegrees(pair.b.lon, pair.b.lat);
    const geo = new EllipsoidGeodesic(A, B);
    const D = geo.surfaceDistance;
    // About one sample per metre up to 300 samples. Surface sampling renders the scene once
    // per sample, so the terrain profile is shown first and the buildings fill in after.
    const n = Math.max(32, Math.min(300, Math.round(D)));
    const pts: Cartographic[] = [];
    for (let i = 0; i <= n; i++) pts.push(geo.interpolateUsingFraction(i / n, new Cartographic()));
    const ground = await this.sampleGround(pts.map((p) => Cartographic.clone(p))).catch(() => pts.map((p) => ((p.height = 0), p)));
    const hA = pair.a.h + pair.aHeight;
    const hB = pair.b.h + pair.bHeight;
    const k = this.defaults.get().refraction ? 0.13 : 0;
    const build = (surf: (Cartographic | undefined)[] | null): ProfileSample[] =>
      pts.map((p, i) => {
        const d = (D * i) / n;
        const g = ground[i]?.height ?? 0;
        const s = surf?.[i]?.height;
        const surface = s !== undefined && Number.isFinite(s) ? Math.max(s, g) : g;
        // Straight 3D chord expressed as ellipsoidal height: linear minus the earth bulge, plus refraction.
        const sight = hA + ((hB - hA) * d) / (D || 1) - ((1 - k) * d * (D - d)) / (2 * R_EARTH);
        return { d, lon: (p.longitude * 180) / Math.PI, lat: (p.latitude * 180) / Math.PI, ground: g, surface, sight };
      });
    const finish = (profile: ProfileSample[], computing: boolean) => {
      // Ignore the first and last metre: that is the ground the observer and target stand on.
      let block: ProfileSample | null = null;
      let worst = -Infinity;
      for (const s of profile) {
        if (s.d < 1 || s.d > D - 1) continue;
        const deficit = s.surface - s.sight;
        worst = Math.max(worst, deficit);
        if (!block && deficit > 0.05) block = s;
      }
      if (!this.pairs.get().some((p) => p.id === id)) return;
      this.patch(id, { profile, block, visible: computing ? null : !block, distance: D, worstDeficit: Number.isFinite(worst) ? worst : 0, computing });
      if (!computing) this.draw(this.pairs.get().find((p) => p.id === id)!);
    };
    finish(build(null), true);
    finish(build(await this.sampleObjects(pts)), false);
  }

  /**
   * Height of the models, 3D Tiles and other objects over each point, or undefined where there
   * are none. A ray down onto the globe is ignored: the ground comes from sampleGround at the
   * terrain's full resolution, while the globe is drawn from whatever tiles are loaded, and a
   * coarse tile over a valley would block a line of sight that is clear.
   */
  private async sampleObjects(pts: Cartographic[]): Promise<(Cartographic | undefined)[] | null> {
    // Each ray renders the scene once, so skip them all when no model or 3D Tiles is near the line.
    const ends = [pts[0]!, pts[pts.length - 1]!].map((p) => Cartographic.toCartesian(p));
    if (!objectsNear(this.scene.primitives, ends[0]!, ends[1]!)) return null;
    const exclude = this.entities.values;
    // Public in all but name: sampleHeightMostDetailed is built on it, and it also says what was hit.
    const scene = this.scene as unknown as { pickFromRayMostDetailed(ray: Ray, exclude?: unknown[]): Promise<{ object?: unknown; position?: Cartesian3 } | undefined> };
    try {
      return await Promise.all(
        pts.map(async (p) => {
          const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(p, new Cartesian3());
          const ray = new Ray(Cartesian3.fromRadians(p.longitude, p.latitude, RAY_TOP), Cartesian3.negate(up, new Cartesian3()));
          const hit = await scene.pickFromRayMostDetailed(ray, exclude);
          if (!hit?.object || !hit.position) return undefined;
          return Cartographic.fromCartesian(hit.position);
        }),
      );
    } catch {
      return null;
    }
  }

  private patch(id: string, p: Partial<SightPair>): void {
    this.pairs.set(this.pairs.get().map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  private undraw(id: string): void {
    for (const e of this.drawn.get(id) ?? []) this.entities.remove(e);
    this.drawn.delete(id);
  }

  private draw(pair: SightPair): void {
    this.undraw(pair.id);
    if (!pair.shown) return;
    const A = Cartesian3.fromDegrees(pair.a.lon, pair.a.lat, pair.a.h + pair.aHeight);
    const B = Cartesian3.fromDegrees(pair.b.lon, pair.b.lat, pair.b.h + pair.bHeight);
    const list: Entity[] = [];
    const seg = (p: Cartesian3[], color: Color, width = 3) =>
      list.push(
        this.entities.add({
          polyline: {
            positions: p,
            width,
            material: new ColorMaterialProperty(color),
            depthFailMaterial: new PolylineDashMaterialProperty({ color: color.withAlpha(0.55), dashLength: 10 }),
          },
        }),
      );
    if (pair.block && pair.distance > 0) {
      const t = pair.block.d / pair.distance;
      const X = Cartesian3.lerp(A, B, t, new Cartesian3());
      seg([A, X], VISIBLE);
      seg([X, B], BLOCKED);
      list.push(
        this.entities.add({
          position: Cartesian3.fromDegrees(pair.block.lon, pair.block.lat, pair.block.surface),
          point: { pixelSize: 10, color: BLOCKED, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        }),
      );
    } else {
      seg([A, B], VISIBLE);
    }
    const end = (pos: Cartesian3, ground: Cartesian3, label: string) => {
      list.push(
        this.entities.add({
          position: pos,
          point: { pixelSize: 9, color: Color.WHITE, outlineColor: Color.fromCssColorString("#0E0F12"), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: {
            text: label,
            font: "600 12px 'IBM Plex Sans', sans-serif",
            fillColor: Color.WHITE,
            showBackground: true,
            backgroundColor: Color.fromCssColorString("#15171B").withAlpha(0.85),
            backgroundPadding: new Cartesian2(6, 3),
            style: LabelStyle.FILL,
            pixelOffset: new Cartesian2(0, -16),
            horizontalOrigin: HorizontalOrigin.CENTER,
            verticalOrigin: VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
        this.entities.add({ polyline: { positions: [ground, pos], width: 1.5, material: new ColorMaterialProperty(Color.WHITE.withAlpha(0.7)) } }),
      );
    };
    const n = pair.seq;
    end(A, Cartesian3.fromDegrees(pair.a.lon, pair.a.lat, pair.a.h), `A${n}`);
    end(B, Cartesian3.fromDegrees(pair.b.lon, pair.b.lat, pair.b.h), `B${n}`);
    for (const e of list) if (e.polyline) e.polyline.clampToGround = new ConstantProperty(false);
    this.drawn.set(pair.id, list);
    this.scene.requestRender();
  }
}

/** Is any shown model or 3D Tiles set within reach of the segment between a and b? */
function objectsNear(collection: PrimitiveCollection, a: Cartesian3, b: Cartesian3): boolean {
  const ab = Cartesian3.subtract(b, a, new Cartesian3());
  const len2 = Cartesian3.magnitudeSquared(ab) || 1;
  const near = (sphere: BoundingSphere | undefined) => {
    if (!sphere) return false;
    const ac = Cartesian3.subtract(sphere.center, a, new Cartesian3());
    const t = Math.min(1, Math.max(0, Cartesian3.dot(ac, ab) / len2));
    const closest = Cartesian3.add(a, Cartesian3.multiplyByScalar(ab, t, new Cartesian3()), new Cartesian3());
    // The segment runs on the ground; the sight line can be a few hundred metres above it.
    return Cartesian3.distance(closest, sphere.center) <= sphere.radius + 1000;
  };
  for (let i = 0; i < collection.length; i++) {
    const p = collection.get(i) as unknown;
    if (p instanceof PrimitiveCollection) {
      if (p.show && objectsNear(p, a, b)) return true;
    } else if (p instanceof Cesium3DTileset || p instanceof Model) {
      // A model that is still loading has no bounding sphere yet.
      let sphere: BoundingSphere | undefined;
      try {
        sphere = p.boundingSphere;
      } catch {
        sphere = undefined;
      }
      if (p.show && near(sphere)) return true;
    }
  }
  return false;
}
