import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  type Entity,
  type EntityCollection,
  HorizontalOrigin,
  LabelStyle,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  ArcType,
  NearFarScalar,
} from "cesium";
import { measurePath, formatLength, type LengthUnit, type PathResult } from "../measure/distance";
import { signal } from "../signal";

export type MeasureKind = "distance" | "path";

export interface Measurement {
  id: string;
  kind: MeasureKind;
  label: string;
  points: Cartesian3[];
  visible: boolean;
  result: PathResult;
}

const ACCENT = Color.fromCssColorString("#F05BDC");
const LEG = Color.fromCssColorString("#E8EAED").withAlpha(0.7);
const LABEL_BG = Color.fromCssColorString("#15171B").withAlpha(0.88);
const FONT = "500 13px 'IBM Plex Mono', ui-monospace, monospace";

let seq = 0;

/** Distance and path measurement (MSR-01, MSR-02) drawn with the measurement triangle. */
export class MeasureTool {
  readonly measurements = signal<Measurement[]>([]);
  readonly active = signal<MeasureKind | null>(null);
  /** Points placed so far in the measurement being drawn. */
  readonly draft = signal<Cartesian3[]>([]);
  unit: LengthUnit = "m";

  private hover: Cartesian3 | undefined;
  private draftEntities: Entity[] = [];
  private shapes = new Map<string, Entity[]>();
  private counters: Record<MeasureKind, number> = { distance: 0, path: 0 };

  constructor(private readonly entities: EntityCollection, private readonly requestRender: () => void) {}

  start(kind: MeasureKind): void {
    this.cancel();
    this.active.set(kind);
    this.buildDraft();
  }

  cancel(): void {
    this.active.set(null);
    this.draft.set([]);
    for (const e of this.draftEntities) this.entities.remove(e);
    this.draftEntities = [];
    this.requestRender();
  }

  setHover(p: Cartesian3 | undefined): void {
    this.hover = p;
    if (this.active.get()) this.requestRender();
  }

  /** Called on click with the picked surface point. */
  addPoint(p: Cartesian3): void {
    const kind = this.active.get();
    if (!kind) return;
    const pts = [...this.draft.get(), Cartesian3.clone(p)];
    this.draft.set(pts);
    if (kind === "distance" && pts.length === 2) this.commit();
    this.requestRender();
  }

  removeLastPoint(): void {
    const pts = this.draft.get();
    if (pts.length) this.draft.set(pts.slice(0, -1));
    this.requestRender();
  }

  /** Finish a path (double-click or Enter). */
  finish(): void {
    if (this.active.get() === "path" && this.draft.get().length >= 2) this.commit();
  }

  setUnit(unit: LengthUnit): void {
    this.unit = unit;
    for (const m of this.measurements.get()) this.drawMeasurement(m);
    this.requestRender();
  }

  rename(id: string, label: string): void {
    this.update(id, (m) => ({ ...m, label }));
  }

  setVisible(id: string, visible: boolean): void {
    this.update(id, (m) => ({ ...m, visible }));
  }

  remove(id: string): void {
    for (const e of this.shapes.get(id) ?? []) this.entities.remove(e);
    this.shapes.delete(id);
    this.measurements.set(this.measurements.get().filter((m) => m.id !== id));
    this.requestRender();
  }

  clear(): void {
    for (const m of this.measurements.get()) this.remove(m.id);
  }

  private update(id: string, fn: (m: Measurement) => Measurement): void {
    const list = this.measurements.get().map((m) => (m.id === id ? fn(m) : m));
    this.measurements.set(list);
    const m = list.find((x) => x.id === id);
    if (m) this.drawMeasurement(m);
    this.requestRender();
  }

  private commit(): void {
    const kind = this.active.get();
    const pts = this.draft.get();
    if (!kind || pts.length < 2) return;
    this.counters[kind] += 1;
    const m: Measurement = {
      id: `m${++seq}`,
      kind,
      label: kind === "distance" ? `Distance ${this.counters[kind]}` : `Path ${this.counters[kind]}`,
      points: pts,
      visible: true,
      result: measurePath(pts),
    };
    this.measurements.set([...this.measurements.get(), m]);
    this.drawMeasurement(m);
    // Stay in the tool for the next measurement (one active tool until Esc).
    this.draft.set([]);
  }

  // ---------- drawing ----------

  private buildDraft(): void {
    const livePoints = () => {
      const pts = this.draft.get();
      return this.hover && pts.length ? [...pts, this.hover] : pts;
    };
    const line = this.entities.add({
      polyline: {
        positions: new CallbackProperty(livePoints, false),
        width: 3,
        material: new ColorMaterialProperty(ACCENT),
        depthFailMaterial: new PolylineDashMaterialProperty({ color: ACCENT.withAlpha(0.55), dashLength: 10 }),
        arcType: ArcType.NONE,
      },
    });
    const liveLabel = this.entities.add({
      position: new CallbackPositionProperty(() => {
        const pts = livePoints();
        return pts.length >= 2 ? midpoint(pts[pts.length - 2]!, pts[pts.length - 1]!) : undefined;
      }, false),
      label: {
        text: new CallbackProperty(() => {
          const pts = livePoints();
          if (pts.length < 2) return "";
          const r = measurePath(pts);
          return formatLength(r.total3d, this.unit);
        }, false),
        ...labelStyle(),
      },
    });
    const points = this.entities.add({
      position: new CallbackPositionProperty(() => this.hover, false),
      point: { pixelSize: 9, color: Color.WHITE, outlineColor: ACCENT, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    this.draftEntities = [line, liveLabel, points];
  }

  private drawMeasurement(m: Measurement): void {
    for (const e of this.shapes.get(m.id) ?? []) this.entities.remove(e);
    const list: Entity[] = [];
    if (m.visible) {
      list.push(
        this.entities.add({
          polyline: {
            positions: m.points,
            width: 3,
            material: new ColorMaterialProperty(ACCENT),
            depthFailMaterial: new PolylineDashMaterialProperty({ color: ACCENT.withAlpha(0.55), dashLength: 10 }),
            arcType: ArcType.NONE,
          },
        }),
      );
      for (const p of m.points) {
        list.push(
          this.entities.add({
            position: p,
            point: { pixelSize: 8, color: ACCENT, outlineColor: Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          }),
        );
      }
      // Measurement triangle for two-point distances: horizontal and vertical legs.
      if (m.points.length === 2) {
        const [a, b] = m.points as [Cartesian3, Cartesian3];
        const corner = triangleCorner(a, b);
        if (corner) {
          const legStyle = {
            width: 1.5,
            material: new PolylineDashMaterialProperty({ color: LEG, dashLength: 8 }),
            depthFailMaterial: new PolylineDashMaterialProperty({ color: LEG.withAlpha(0.35), dashLength: 8 }),
            arcType: ArcType.NONE,
          };
          const [low, high] = Cartographic.fromCartesian(a).height <= Cartographic.fromCartesian(b).height ? [a, b] : [b, a];
          list.push(this.entities.add({ polyline: { positions: [low, corner], ...legStyle } }));
          list.push(this.entities.add({ polyline: { positions: [corner, high], ...legStyle } }));
          const r = m.result.segments[0]!;
          if (r.horizontal > 0.01) list.push(this.label(midpoint(low, corner), `↔ ${formatLength(r.horizontal, this.unit)}`, true));
          if (Math.abs(r.heightDelta) > 0.01) list.push(this.label(midpoint(corner, high), `↕ ${formatLength(Math.abs(r.heightDelta), this.unit)}`, true));
        }
      }
      const last = m.points[m.points.length - 1]!;
      const anchor = m.points.length === 2 ? midpoint(m.points[0]!, last) : last;
      list.push(this.label(anchor, `${m.label} · ${formatLength(m.result.total3d, this.unit)}`, false));
    }
    this.shapes.set(m.id, list);
  }

  private label(position: Cartesian3, text: string, secondary: boolean): Entity {
    return this.entities.add({
      position,
      label: { text, ...labelStyle(secondary) },
    });
  }
}

function labelStyle(secondary = false) {
  return {
    font: secondary ? "500 12px 'IBM Plex Mono', ui-monospace, monospace" : FONT,
    fillColor: secondary ? Color.fromCssColorString("#C9CDD4") : Color.WHITE,
    showBackground: true,
    backgroundColor: LABEL_BG,
    backgroundPadding: new Cartesian2(8, 5),
    style: LabelStyle.FILL,
    pixelOffset: new Cartesian2(0, -14),
    horizontalOrigin: HorizontalOrigin.CENTER,
    verticalOrigin: VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    scaleByDistance: new NearFarScalar(1, 1, 1e7, 1),
  };
}

function midpoint(a: Cartesian3, b: Cartesian3): Cartesian3 {
  return Cartesian3.midpoint(a, b, new Cartesian3());
}

/** Corner of the right-angle triangle: the higher point's position at the lower point's height. */
function triangleCorner(a: Cartesian3, b: Cartesian3): Cartesian3 | undefined {
  const ca = Cartographic.fromCartesian(a);
  const cb = Cartographic.fromCartesian(b);
  if (!ca || !cb) return undefined;
  const [low, high] = ca.height <= cb.height ? [ca, cb] : [cb, ca];
  return Cartesian3.fromRadians(high.longitude, high.latitude, low.height);
}
