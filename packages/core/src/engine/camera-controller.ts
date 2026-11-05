import {
  Cartesian2,
  Cartesian3,
  Matrix3,
  Quaternion,
  type Scene,
  type Camera,
  Math as CMath,
  PerspectiveFrustum,
} from "cesium";

export type DragMode = "orbit" | "pan";

export interface CameraControllerOptions {
  scene: Scene;
  canvas: HTMLCanvasElement;
  /** Returns the surface point under a window position, if any. */
  pick: (pos: Cartesian2) => Cartesian3 | undefined;
  onPivotSet?: (pivot: Cartesian3) => void;
  /** Return true to consume a click (e.g. the measure tool). */
  isToolActive?: () => boolean;
}

/**
 * Navigation from SRS NAV-01..03: left-drag orbits around a pivot (set by double-click),
 * right/middle-drag pans, wheel and pinch zoom toward the cursor, arrow keys pan.
 */
export class CameraController {
  pivot: Cartesian3 = new Cartesian3();
  /** Left-drag behaviour: W = orbit, E = pan (SRS 5.1). */
  leftDrag: DragMode = "orbit";
  /** Lowest allowed angle between the view and the local vertical, degrees (prevents flipping). */
  maxPolarDeg = 100;

  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: CameraControllerOptions;
  private drag: { mode: DragMode; x: number; y: number; id: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private disposers: (() => void)[] = [];
  private moving = false;
  onMoveStart?: () => void;
  onMoveEnd?: () => void;
  private moveEndTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: CameraControllerOptions) {
    this.opts = opts;
    this.scene = opts.scene;
    this.camera = opts.scene.camera;
    this.canvas = opts.canvas;
    const ssc = this.scene.screenSpaceCameraController;
    ssc.enableRotate = false;
    ssc.enableTranslate = false;
    ssc.enableZoom = false;
    ssc.enableTilt = false;
    ssc.enableLook = false;
    // Touch gestures belong to the view: without this the browser scrolls or zooms the page
    // and cancels the pointers part-way through a pinch.
    this.canvas.style.touchAction = "none";

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      this.canvas.addEventListener(type, fn as EventListener, o);
      this.disposers.push(() => this.canvas.removeEventListener(type, fn as EventListener, o));
    };
    on("pointerdown", (e) => this.onPointerDown(e));
    on("pointermove", (e) => this.onPointerMove(e));
    on("pointerup", (e) => this.onPointerUp(e));
    on("pointercancel", (e) => this.onPointerUp(e));
    on("wheel", (e) => this.onWheel(e), { passive: false });
    on("dblclick", (e) => this.onDoubleClick(e));
    on("contextmenu", (e) => e.preventDefault());
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  // ---------- public moves ----------

  /** Rotates the camera around the pivot. dx/dy in pixels. */
  orbit(dx: number, dy: number): void {
    const cam = this.camera;
    const up = this.scene.globe?.ellipsoid.geodeticSurfaceNormal(this.pivot, new Cartesian3()) ??
      Cartesian3.normalize(this.pivot, new Cartesian3());
    const k = Math.PI / Math.max(400, this.canvas.clientHeight);

    // Heading: around the local vertical through the pivot.
    let q = Quaternion.fromAxisAngle(up, -dx * k);

    // Pitch: around the camera's right axis, clamped so we never flip over the top.
    const offset = Cartesian3.subtract(cam.positionWC, this.pivot, new Cartesian3());
    const polar = Cartesian3.angleBetween(offset, up);
    const minPolar = CMath.toRadians(0.5);
    const maxPolar = CMath.toRadians(this.maxPolarDeg);
    let pitch = -dy * k;
    pitch = CMath.clamp(polar + pitch, minPolar, maxPolar) - polar;
    const right = Cartesian3.normalize(cam.rightWC, new Cartesian3());
    q = Quaternion.multiply(q, Quaternion.fromAxisAngle(right, pitch), new Quaternion());
    const m = Matrix3.fromQuaternion(q);

    const newOffset = Matrix3.multiplyByVector(m, offset, new Cartesian3());
    const dir = Matrix3.multiplyByVector(m, cam.directionWC, new Cartesian3());
    const camUp = Matrix3.multiplyByVector(m, cam.upWC, new Cartesian3());
    this.setCamera(Cartesian3.add(this.pivot, newOffset, new Cartesian3()), dir, camUp);
  }

  /** Moves the camera parallel to the screen. dx/dy in pixels. */
  pan(dx: number, dy: number): void {
    const cam = this.camera;
    const mpp = this.metresPerPixelAtPivot();
    const right = Cartesian3.multiplyByScalar(cam.rightWC, -dx * mpp, new Cartesian3());
    const up = Cartesian3.multiplyByScalar(cam.upWC, dy * mpp, new Cartesian3());
    const move = Cartesian3.add(right, up, new Cartesian3());
    Cartesian3.add(this.pivot, move, this.pivot);
    this.setCamera(Cartesian3.add(cam.positionWC, move, new Cartesian3()), cam.directionWC, cam.upWC);
  }

  /** Zooms toward a window position. steps > 0 zooms in. */
  zoomAt(steps: number, x: number, y: number): void {
    const cam = this.camera;
    const target =
      this.opts.pick(new Cartesian2(x, y)) ??
      cam.pickEllipsoid(new Cartesian2(x, y)) ??
      this.pivot;
    const toCam = Cartesian3.subtract(cam.positionWC, target, new Cartesian3());
    const dist = Cartesian3.magnitude(toCam);
    const factor = Math.pow(0.85, steps);
    const next = Math.max(0.25, Math.min(dist * factor, 2.5e7));
    if (Math.abs(next - dist) < 1e-6) return;
    const pos = Cartesian3.add(target, Cartesian3.multiplyByScalar(Cartesian3.normalize(toCam, toCam), next, new Cartesian3()), new Cartesian3());
    // Keep orbiting around what the user is zooming into.
    if (steps > 0) Cartesian3.clone(target, this.pivot);
    this.setCamera(pos, cam.directionWC, cam.upWC);
  }

  zoomCentre(steps: number): void {
    this.zoomAt(steps, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  metresPerPixelAtPivot(): number {
    const d = Cartesian3.distance(this.camera.positionWC, this.pivot) || 1;
    const fr = this.camera.frustum;
    const fovy = fr instanceof PerspectiveFrustum ? (fr.fovy ?? CMath.toRadians(60)) : CMath.toRadians(60);
    return (2 * d * Math.tan(fovy / 2)) / Math.max(1, this.canvas.clientHeight);
  }

  handleKey(e: KeyboardEvent): boolean {
    const step = 40;
    switch (e.key) {
      // An arrow moves the camera that way, as on a map: the view's content slides the other way.
      case "ArrowLeft": this.pan(step, 0); return true;
      case "ArrowRight": this.pan(-step, 0); return true;
      case "ArrowUp": this.pan(0, step); return true;
      case "ArrowDown": this.pan(0, -step); return true;
      case "+": case "=": this.zoomCentre(1); return true;
      case "-": case "_": this.zoomCentre(-1); return true;
    }
    return false;
  }

  // ---------- internals ----------

  private setCamera(position: Cartesian3, direction: Cartesian3, up: Cartesian3): void {
    this.camera.cancelFlight();
    this.camera.setView({
      destination: position,
      orientation: { direction: Cartesian3.normalize(direction, new Cartesian3()), up: Cartesian3.normalize(up, new Cartesian3()) },
    });
    this.markMoving();
  }

  private markMoving(): void {
    if (!this.moving) {
      this.moving = true;
      this.onMoveStart?.();
    }
    clearTimeout(this.moveEndTimer);
    this.moveEndTimer = setTimeout(() => {
      this.moving = false;
      this.onMoveEnd?.();
    }, 150);
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      this.drag = null;
      this.pinch = this.pinchState();
      return;
    }
    const mode: DragMode | null = e.button === 0 ? this.leftDrag : e.button === 1 || e.button === 2 ? "pan" : null;
    if (!mode) return;
    if (e.button === 0 && this.opts.isToolActive?.()) return; // clicks belong to the tool
    if (mode === "orbit" && e.pointerType !== "mouse") {
      // Touch orbit uses the current pivot.
    }
    this.drag = { mode, x: e.offsetX, y: e.offsetY, id: e.pointerId };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size === 2) {
      const next = this.pinchState();
      if (next.dist > 0 && this.pinch.dist > 0) {
        const steps = Math.log(next.dist / this.pinch.dist) / -Math.log(0.85);
        this.zoomAt(steps, next.mx, next.my);
        this.pan(next.mx - this.pinch.mx, next.my - this.pinch.my);
      }
      this.pinch = next;
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.offsetX - this.drag.x;
    const dy = e.offsetY - this.drag.y;
    this.drag.x = e.offsetX;
    this.drag.y = e.offsetY;
    if (dx === 0 && dy === 0) return;
    if (this.drag.mode === "orbit") this.orbit(dx, dy);
    else this.pan(dx, dy);
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag?.id === e.pointerId) {
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const scale = e.ctrlKey ? 0.04 : e.deltaMode === 1 ? 0.33 : 0.01;
    const steps = Math.max(-6, Math.min(6, -e.deltaY * scale));
    this.zoomAt(steps, e.offsetX, e.offsetY);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.opts.isToolActive?.()) return;
    const p = this.opts.pick(new Cartesian2(e.offsetX, e.offsetY));
    if (!p) return;
    Cartesian3.clone(p, this.pivot);
    this.opts.onPivotSet?.(p);
  }

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { dist: 0, mx: 0, my: 0 };
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
}
