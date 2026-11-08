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
import { measurePath, formatLength, formatModelLength, type LengthUnit, type PathResult } from "../measure/distance";
import { signal } from "../signal";
import type { Snap, SnapKind } from "./snapper";

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
  /**
   * Metres per model unit when the open model has no reliable scale (MSR-06), else null. Lengths
   * are then shown in model units, whatever the unit setting.
   */
  readonly modelUnit = signal<number | null>(null);
  /** The words for "model units"; the app sets them to the interface language. */
  modelUnitName = "model units";

  private hover: Cartesian3 | undefined;
  private hoverSnap: Snap | undefined;
  private draftEntities: Entity[] = [];
  private shapes = new Map<string, Entity[]>();
  private counters: Record<MeasureKind, number> = { distance: 0, path: 0 };
  /** The name a new measurement gets; the app sets it to the interface language. */
  labelFor = (kind: MeasureKind, n: number): string => `${kind === "distance" ? "Distance" : "Path"} ${n}`;
  /** The words beside the snap glyph ("Vertex · 2.4 px"); the app sets it to the interface language. */
  snapLabel = (kind: SnapKind, pixels: number): string =>
    kind === "surface" ? "" : `${kind === "vertex" ? "Vertex" : "Edge"} · ${pixels.toFixed(1)} px`;

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

  /** The point under the cursor, and what it snapped to (UI spec: square vertex, diamond edge, circle surface). */
  setHover(p: Cartesian3 | undefined, snap?: Snap): void {
    this.hover = p;
    this.hoverSnap = p ? snap : undefined;
    if (this.active.get()) this.requestRender();
  }

  /**
   * Called on click with the picked surface point. Returns the point as kept, which
   * replacePoint can later move (to the same surface at full detail).
   */
  addPoint(p: Cartesian3): Cartesian3 | undefined {
    const kind = this.active.get();
    if (!kind) return undefined;
    const kept = Cartesian3.clone(p);
    const pts = [...this.draft.get(), kept];
    this.draft.set(pts);
    if (kind === "distance" && pts.length === 2) this.commit();
    this.requestRender();
    return kept;
  }

  /**
   * Moves a point placed earlier, in the measurement being drawn or a finished one, and works the
   * results out again. False when the point is gone (undone, deleted or cleared).
   */
  replacePoint(old: Cartesian3, next: Cartesian3): boolean {
    const draft = this.draft.get();
    const i = draft.indexOf(old);
    if (i >= 0) {
      const pts = [...draft];
      pts[i] = Cartesian3.clone(next);
      this.draft.set(pts);
      this.requestRender();
      return true;
    }
    const m = this.measurements.get().find((x) => x.points.includes(old));
    if (!m) return false;
    this.update(m.id, (x) => {
      const points = x.points.map((p) => (p === old ? Cartesian3.clone(next) : p));
      return { ...x, points, result: measurePath(points) };
    });
    return true;
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
    this.redraw();
  }

  /** The open model's scale: metres per model unit when it has no reliable scale, else null. */
  setModelUnit(metresPerUnit: number | null | undefined): void {
    const v = metresPerUnit && metresPerUnit > 0 && Number.isFinite(metresPerUnit) ? metresPerUnit : null;
    if (v === this.modelUnit.get()) return;
    this.modelUnit.set(v);
    this.redraw();
  }

  /** A length in metres as the measurement labels show it: m or ft, or model units (MSR-06). */
  format(metres: number, locale?: string): string {
    const mu = this.modelUnit.get();
    return mu ? formatModelLength(metres / mu, this.modelUnitName, locale) : formatLength(metres, this.unit, locale);
  }

  /** Draws the measurements again, after a change in how lengths read. */
  redraw(): void {
    for (const m of this.measurements.get()) this.drawMeasurement(m);
    this.requestRender();
  }

  rename(id: string, label: string): void {
    this.update(id, (m) => ({ ...m, label }));
  }

  setVisible(id: string, visible: boolean): void {
    this.update(id, (m) => ({ ...m, visible }));
  }

  /** Deletes a measurement. Returns it and where it stood, so restore can put it back (Ctrl+Z). */
  remove(id: string): { measurement: Measurement; index: number } | undefined {
    const list = this.measurements.get();
    const index = list.findIndex((m) => m.id === id);
    if (index < 0) return undefined;
    for (const e of this.shapes.get(id) ?? []) this.entities.remove(e);
    this.shapes.delete(id);
    this.measurements.set(list.filter((m) => m.id !== id));
    this.requestRender();
    return { measurement: list[index]!, index };
  }

  /** Puts a deleted measurement back where it stood. False when it is already there. */
  restore(m: Measurement, index: number): boolean {
    const list = this.measurements.get();
    if (list.some((x) => x.id === m.id)) return false;
    const next = [...list];
    next.splice(Math.min(Math.max(0, index), next.length), 0, m);
    this.measurements.set(next);
    this.drawMeasurement(m);
    this.requestRender();
    return true;
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
      label: this.labelFor(kind, this.counters[kind]),
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
          return this.format(r.total3d);
        }, false),
        ...labelStyle(),
      },
    });
    const glyph = this.entities.add({
      position: new CallbackPositionProperty(() => this.hover, false),
      billboard: {
        image: new CallbackProperty(() => snapGlyph(this.hoverSnap?.kind ?? "surface"), false),
        width: 28,
        height: 28,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: new CallbackProperty(() => (this.hoverSnap ? this.snapLabel(this.hoverSnap.kind, this.hoverSnap.pixels) : ""), false),
        font: "500 11px 'IBM Plex Mono', ui-monospace, monospace",
        fillColor: Color.WHITE,
        showBackground: true,
        backgroundColor: LABEL_BG,
        backgroundPadding: new Cartesian2(6, 3),
        style: LabelStyle.FILL,
        pixelOffset: new Cartesian2(16, 14),
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.TOP,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    // The measurement triangle while the second point is being chosen: horizontal and vertical
    // legs, each with its length, so the three numbers are seen before the click.
    const liveLegs = () => {
      const pts = livePoints();
      if (this.active.get() !== "distance" || pts.length !== 2) return undefined;
      return triangle(pts[0]!, pts[1]!);
    };
    const legStyle = legPolyline();
    const legLow = this.entities.add({
      polyline: { positions: new CallbackProperty(() => { const t = liveLegs(); return t ? [t.low, t.corner] : []; }, false), ...legStyle },
    });
    const legHigh = this.entities.add({
      polyline: { positions: new CallbackProperty(() => { const t = liveLegs(); return t ? [t.corner, t.high] : []; }, false), ...legStyle },
    });
    const legLabel = (which: "horizontal" | "vertical") =>
      this.entities.add({
        position: new CallbackPositionProperty(() => {
          const t = liveLegs();
          return t ? midpoint(which === "horizontal" ? t.low : t.corner, which === "horizontal" ? t.corner : t.high) : undefined;
        }, false),
        label: {
          text: new CallbackProperty(() => {
            const t = liveLegs();
            if (!t) return "";
            const r = measurePath([t.low, t.high]).segments[0]!;
            if (which === "horizontal") return r.horizontal > 0.01 ? `↔ ${this.format(r.horizontal)}` : "";
            return Math.abs(r.heightDelta) > 0.01 ? `↕ ${this.format(Math.abs(r.heightDelta))}` : "";
          }, false),
          ...labelStyle(true),
        },
      });
    this.draftEntities = [line, liveLabel, glyph, legLow, legHigh, legLabel("horizontal"), legLabel("vertical")];
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
        const tri = triangle(a, b);
        if (tri) {
          const { low, high, corner } = tri;
          const legStyle = legPolyline();
          list.push(this.entities.add({ polyline: { positions: [low, corner], ...legStyle } }));
          list.push(this.entities.add({ polyline: { positions: [corner, high], ...legStyle } }));
          const r = m.result.segments[0]!;
          if (r.horizontal > 0.01) list.push(this.label(midpoint(low, corner), `↔ ${this.format(r.horizontal)}`, true));
          if (Math.abs(r.heightDelta) > 0.01) list.push(this.label(midpoint(corner, high), `↕ ${this.format(Math.abs(r.heightDelta))}`, true));
        }
      }
      const last = m.points[m.points.length - 1]!;
      const anchor = m.points.length === 2 ? midpoint(m.points[0]!, last) : last;
      list.push(this.label(anchor, `${m.label} · ${this.format(m.result.total3d)}`, false));
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

/**
 * The right-angle triangle between two points: the lower and higher point, and the corner, which
 * is the higher point's position at the lower point's height.
 */
function triangle(a: Cartesian3, b: Cartesian3): { low: Cartesian3; high: Cartesian3; corner: Cartesian3 } | undefined {
  const ca = Cartographic.fromCartesian(a);
  const cb = Cartographic.fromCartesian(b);
  if (!ca || !cb) return undefined;
  const [low, high, cl, ch] = ca.height <= cb.height ? [a, b, ca, cb] : [b, a, cb, ca];
  return { low, high, corner: Cartesian3.fromRadians(ch.longitude, ch.latitude, cl.height) };
}

/** The dashed style of the triangle's horizontal and vertical legs. */
function legPolyline() {
  return {
    width: 1.5,
    material: new PolylineDashMaterialProperty({ color: LEG, dashLength: 8 }),
    depthFailMaterial: new PolylineDashMaterialProperty({ color: LEG.withAlpha(0.35), dashLength: 8 }),
    arcType: ArcType.NONE,
  };
}

const glyphs = new Map<SnapKind, string>();

/**
 * The snap glyph: a square on a vertex, a diamond on an edge, a circle on a surface, each with a
 * crosshair. As a data URL: the billboard keeps one texture per URL, where a canvas given again
 * each frame would be added to its atlas again each frame.
 */
function snapGlyph(kind: SnapKind): string {
  const known = glyphs.get(kind);
  if (known) return known;
  const size = 28;
  const ratio = 2;
  const c = document.createElement("canvas");
  c.width = c.height = size * ratio;
  const g = c.getContext("2d")!;
  g.scale(ratio, ratio);
  const m = size / 2;
  const shape = () => {
    g.beginPath();
    if (kind === "vertex") g.rect(m - 6, m - 6, 12, 12);
    else if (kind === "edge") {
      g.moveTo(m, m - 8);
      g.lineTo(m + 8, m);
      g.lineTo(m, m + 8);
      g.lineTo(m - 8, m);
      g.closePath();
    } else g.arc(m, m, 5, 0, Math.PI * 2);
  };
  const cross = () => {
    g.beginPath();
    for (const [x0, y0, x1, y1] of [[m, 1, m, m - 9], [m, m + 9, m, size - 1], [1, m, m - 9, m], [m + 9, m, size - 1, m]] as const) {
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
    }
  };
  // A dark halo first, so the glyph reads on light and dark surfaces alike.
  g.strokeStyle = "rgba(0,0,0,0.75)";
  g.lineWidth = 4;
  shape();
  g.stroke();
  cross();
  g.stroke();
  g.strokeStyle = kind === "surface" ? "#FFFFFF" : ACCENT.toCssColorString();
  g.lineWidth = 2;
  shape();
  g.stroke();
  g.strokeStyle = "#FFFFFF";
  g.lineWidth = 1;
  cross();
  g.stroke();
  const url = c.toDataURL("image/png");
  glyphs.set(kind, url);
  return url;
}
