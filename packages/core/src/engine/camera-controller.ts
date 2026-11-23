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

/** Above this height a left-drag in orbit mode spins the globe instead: orbiting one spot from space only swings the Earth around. */
const GLOBE_SPIN_HEIGHT = 1_500_000;
/** Zoom factor for one wheel step. */
const ZOOM_STEP = 0.85;
/** How fast a wheel zoom catches up, ms (time constant of the easing). */
const ZOOM_EASE_MS = 90;
/** How fast a fling slows down, ms (time constant of the decay). */
const INERTIA_DECAY_MS = 260;
/** A drag released after the pointer has rested this long does not fling. */
const FLING_REST_MS = 70;

type Fling =
  | { kind: "orbit"; vx: number; vy: number }
  | { kind: "spin"; axis: Cartesian3; rate: number };

interface Sample {
  t: number;
  dx: number;
  dy: number;
  /** Rotation of the globe for a grab, as axis × angle. */
  rot?: Cartesian3;
}

/**
 * Navigation that behaves like mainstream globe and map apps (SRS NAV-01..03):
 * - left-drag orbits around the point under the cursor where the drag starts,
 * - right/middle-drag grabs the ground: the point under the cursor stays under the cursor,
 * - wheel and pinch zoom toward the cursor, eased over a few frames,
 * - a drag released while moving carries on and slows down (inertia),
 * - double-click zooms in on the point clicked, arrow keys pan.
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
  private drag: {
    mode: DragMode | "spin";
    x: number;
    y: number;
    id: number;
    /** The point grabbed (pan) or orbited around. */
    anchor?: Cartesian3;
    started: boolean;
  } | null = null;
  private samples: Sample[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; angle: number; mx: number; my: number; anchor?: Cartesian3 } | null = null;
  private disposers: (() => void)[] = [];
  private moving = false;
  onMoveStart?: () => void;
  onMoveEnd?: () => void;
  private moveEndTimer: ReturnType<typeof setTimeout> | undefined;

  // Animation: an eased zoom and a fling share one frame loop.
  private zoomLeft = 0;
  private zoomTarget: Cartesian3 | null = null;
  private zoomPos = { x: 0, y: 0 };
  private fling: Fling | null = null;
  private frame = 0;
  private lastTick = 0;

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
    this.stopMotion();
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  /** Stops an eased zoom or a fling that is still running. */
  stopMotion(): void {
    this.zoomLeft = 0;
    this.zoomTarget = null;
    this.fling = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // ---------- public moves ----------

  /** Rotates the camera around the pivot. dx/dy in pixels. */
  orbit(dx: number, dy: number): void {
    const cam = this.camera;
    const up = this.surfaceNormal(this.pivot);
    const k = Math.PI / Math.max(400, this.canvas.clientHeight);

    // Pitch: around the horizontal axis at the pivot that is square to the view, clamped so
    // we never flip over the top. Using the level axis keeps the horizon level.
    const offset = Cartesian3.subtract(cam.positionWC, this.pivot, new Cartesian3());
    const polar = Cartesian3.angleBetween(offset, up);
    const minPolar = CMath.toRadians(0.5);
    const maxPolar = CMath.toRadians(this.maxPolarDeg);
    let pitch = -dy * k;
    pitch = CMath.clamp(polar + pitch, minPolar, maxPolar) - polar;
    let right = Cartesian3.cross(cam.directionWC, up, new Cartesian3());
    if (Cartesian3.magnitudeSquared(right) < 1e-10) right = Cartesian3.clone(cam.rightWC);
    Cartesian3.normalize(right, right);

    // Heading: around the local vertical through the pivot.
    const q = Quaternion.multiply(
      Quaternion.fromAxisAngle(up, -dx * k),
      Quaternion.fromAxisAngle(right, pitch),
      new Quaternion(),
    );
    this.rotateAbout(this.pivot, Matrix3.fromQuaternion(q));
  }

  /**
   * Pans by dx/dy pixels: the ground at the centre of the view slides with the pointer, over
   * the curve of the globe. Falls back to a move parallel to the screen with no ground there.
   */
  pan(dx: number, dy: number): void {
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    const anchor = this.opts.pick(new Cartesian2(cx, cy));
    if (anchor && this.grab(anchor, cx + dx, cy + dy)) return;
    const cam = this.camera;
    const mpp = this.metresPerPixelAtPivot();
    const right = Cartesian3.multiplyByScalar(cam.rightWC, -dx * mpp, new Cartesian3());
    const up = Cartesian3.multiplyByScalar(cam.upWC, dy * mpp, new Cartesian3());
    const move = Cartesian3.add(right, up, new Cartesian3());
    Cartesian3.add(this.pivot, move, this.pivot);
    this.setCamera(Cartesian3.add(cam.positionWC, move, new Cartesian3()), cam.directionWC, cam.upWC);
  }

  /** Zooms toward a window position at once. steps > 0 zooms in. */
  zoomAt(steps: number, x: number, y: number): void {
    const target = this.zoomTargetAt(x, y);
    this.zoomToward(target, steps);
    if (steps > 0) Cartesian3.clone(target, this.pivot);
  }

  /** Zooms toward a window position over a few frames; further calls add to the zoom. */
  smoothZoomAt(steps: number, x: number, y: number): void {
    // A zoom started at another spot, or turned around, starts afresh at the new spot.
    const moved = Math.hypot(x - this.zoomPos.x, y - this.zoomPos.y) > 4;
    if (!this.zoomTarget || moved || Math.sign(steps) !== Math.sign(this.zoomLeft)) {
      this.zoomTarget = this.zoomTargetAt(x, y);
      this.zoomPos = { x, y };
      this.zoomLeft = 0;
    }
    this.zoomLeft = CMath.clamp(this.zoomLeft + steps, -12, 12);
    if (steps > 0) Cartesian3.clone(this.zoomTarget, this.pivot);
    this.animate();
  }

  zoomCentre(steps: number): void {
    this.smoothZoomAt(steps, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  metresPerPixelAtPivot(): number {
    return this.metresPerPixelAt(Cartesian3.distance(this.camera.positionWC, this.pivot) || 1);
  }

  /**
   * Metres per pixel at what the view is looking at, for the scale bar: the ground at the
   * centre of the view, or the pivot when it is on screen and nearer (a model in front of the
   * ground). The pivot alone goes stale when the camera is moved by a fly-to or a viewpoint.
   */
  metresPerPixelAtCentre(): { metresPerPixel: number } {
    const cam = this.camera;
    const canvas = this.canvas;
    const ray = cam.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    let hit: Cartesian3 | undefined;
    try {
      // Runs after every frame that moved the camera: it must never throw, or Cesium stops drawing.
      hit = ray && this.scene.globe ? this.scene.globe.pick(ray, this.scene) : undefined;
    } catch {
      hit = undefined;
    }
    const toPivot = Cartesian3.subtract(this.pivot, cam.positionWC, new Cartesian3());
    const pivotD = Cartesian3.magnitude(toPivot);
    const onScreen = pivotD > 0 && Cartesian3.dot(toPivot, cam.directionWC) / pivotD > Math.cos(0.5);
    if (!hit) return { metresPerPixel: this.metresPerPixelAt(pivotD || 1) };
    const groundD = Cartesian3.distance(cam.positionWC, hit);
    return { metresPerPixel: this.metresPerPixelAt(onScreen && pivotD < groundD ? pivotD : groundD) };
  }

  private metresPerPixelAt(d: number): number {
    const fr = this.camera.frustum;
    const fovy = fr instanceof PerspectiveFrustum ? (fr.fovy ?? CMath.toRadians(60)) : CMath.toRadians(60);
    return (2 * d * Math.tan(fovy / 2)) / Math.max(1, this.canvas.clientHeight);
  }

  handleKey(e: KeyboardEvent): boolean {
    const step = 40;
    switch (e.key) {
      // An arrow moves the camera that way, as on a map: the view's content slides the other way.
      case "ArrowLeft": this.stopMotion(); this.pan(step, 0); return true;
      case "ArrowRight": this.stopMotion(); this.pan(-step, 0); return true;
      case "ArrowUp": this.stopMotion(); this.pan(0, step); return true;
      case "ArrowDown": this.stopMotion(); this.pan(0, -step); return true;
      case "+": case "=": this.zoomCentre(1); return true;
      case "-": case "_": this.zoomCentre(-1); return true;
    }
    return false;
  }

  // ---------- internals: geometry ----------

  private surfaceNormal(p: Cartesian3): Cartesian3 {
    return this.scene.globe?.ellipsoid.geodeticSurfaceNormal(p, new Cartesian3()) ??
      Cartesian3.normalize(p, new Cartesian3());
  }

  /** Height of the camera above the ellipsoid, metres. */
  private cameraHeight(): number {
    const carto = this.scene.globe?.ellipsoid.cartesianToCartographic(this.camera.positionWC);
    return carto?.height ?? Cartesian3.magnitude(this.camera.positionWC) - 6_371_000;
  }

  /** Turns the camera rigidly around a world point: that point keeps its place on screen. */
  private rotateAbout(point: Cartesian3, m: Matrix3): void {
    const cam = this.camera;
    const offset = Cartesian3.subtract(cam.positionWC, point, new Cartesian3());
    const pos = Cartesian3.add(point, Matrix3.multiplyByVector(m, offset, offset), new Cartesian3());
    const dir = Matrix3.multiplyByVector(m, cam.directionWC, new Cartesian3());
    const up = Matrix3.multiplyByVector(m, cam.upWC, new Cartesian3());
    this.setCamera(pos, dir, up);
  }

  /** Where the ray through a window position meets the sphere through the centre of the Earth with this radius. */
  private raySphere(x: number, y: number, radius: number): Cartesian3 | undefined {
    const ray = this.camera.getPickRay(new Cartesian2(x, y));
    if (!ray) return undefined;
    const o = ray.origin;
    const d = Cartesian3.normalize(ray.direction, new Cartesian3());
    const b = Cartesian3.dot(o, d);
    const c = Cartesian3.dot(o, o) - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return undefined;
    const s = Math.sqrt(disc);
    // From outside the near side; from inside (a grabbed roof above the camera) the far side.
    let t = -b - s;
    if (t < 0) t = -b + s;
    if (t < 0) return undefined;
    return Cartesian3.add(o, Cartesian3.multiplyByScalar(d, t, new Cartesian3()), new Cartesian3());
  }

  /**
   * Turns the globe so the grabbed world point comes under the window position (x, y), keeping
   * the camera's height and its tilt to the ground. Returns the rotation (axis × angle), or
   * undefined when the pointer is off the globe (the sky).
   */
  private grab(anchor: Cartesian3, x: number, y: number): Cartesian3 | undefined {
    const r = Cartesian3.magnitude(anchor);
    const hit = this.raySphere(x, y, r);
    if (!hit) return undefined;
    let angle = Cartesian3.angleBetween(hit, anchor);
    if (!(angle > 1e-12)) return new Cartesian3();
    const axis = Cartesian3.cross(hit, anchor, new Cartesian3());
    if (Cartesian3.magnitudeSquared(axis) < 1e-20) return new Cartesian3();
    Cartesian3.normalize(axis, axis);
    // Near the horizon one pixel spans kilometres: keep a single step from running away.
    const reach = Math.max(1, Cartesian3.distance(this.camera.positionWC, anchor));
    angle = Math.min(angle, 0.6, (8 * reach) / r);
    this.spin(axis, angle);
    return Cartesian3.multiplyByScalar(axis, angle, new Cartesian3());
  }

  /** Turns the camera around the centre of the Earth. */
  private spin(axis: Cartesian3, angle: number): void {
    this.rotateAbout(Cartesian3.ZERO, Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle)));
  }

  private zoomTargetAt(x: number, y: number): Cartesian3 {
    const cam = this.camera;
    const hit = this.opts.pick(new Cartesian2(x, y)) ?? cam.pickEllipsoid(new Cartesian2(x, y));
    if (hit) return hit;
    // Over the sky: move along the ray, by about the camera's height.
    const ray = cam.getPickRay(new Cartesian2(x, y));
    const d = Math.max(100, this.cameraHeight());
    if (!ray) return Cartesian3.add(cam.positionWC, Cartesian3.multiplyByScalar(cam.directionWC, d, new Cartesian3()), new Cartesian3());
    return Cartesian3.add(ray.origin, Cartesian3.multiplyByScalar(Cartesian3.normalize(ray.direction, new Cartesian3()), d, new Cartesian3()), new Cartesian3());
  }

  /** Moves the camera along the line to a target: the target keeps its place on screen. */
  private zoomToward(target: Cartesian3, steps: number): boolean {
    const cam = this.camera;
    const toCam = Cartesian3.subtract(cam.positionWC, target, new Cartesian3());
    const dist = Cartesian3.magnitude(toCam);
    if (!(dist > 0)) return false;
    const next = Math.max(0.25, Math.min(dist * Math.pow(ZOOM_STEP, steps), 2.5e7));
    if (Math.abs(next - dist) < 1e-6) return false;
    const pos = Cartesian3.add(target, Cartesian3.multiplyByScalar(toCam, next / dist, new Cartesian3()), new Cartesian3());
    this.setCamera(pos, cam.directionWC, cam.upWC);
    return true;
  }

  private setCamera(position: Cartesian3, direction: Cartesian3, up: Cartesian3): void {
    this.camera.cancelFlight();
    this.camera.setView({
      destination: position,
      orientation: { direction: Cartesian3.normalize(direction, new Cartesian3()), up: Cartesian3.normalize(up, new Cartesian3()) },
    });
    this.scene.requestRender();
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

  // ---------- internals: animation ----------

  private animate(): void {
    if (this.frame) return;
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    this.frame = 0;
    // A fly-to started elsewhere wins over what is left of a fling or a zoom.
    if ((this.camera as unknown as { _currentFlight?: unknown })._currentFlight) {
      this.stopMotion();
      return;
    }
    const dt = Math.min(50, Math.max(1, now - this.lastTick));
    this.lastTick = now;

    if (this.zoomTarget && Math.abs(this.zoomLeft) > 0.002) {
      const part = this.zoomLeft * (1 - Math.exp(-dt / ZOOM_EASE_MS));
      this.zoomLeft -= part;
      if (!this.zoomToward(this.zoomTarget, part)) this.zoomLeft = 0;
    } else {
      this.zoomLeft = 0;
      this.zoomTarget = null;
    }

    const f = this.fling;
    if (f) {
      const decay = Math.exp(-dt / INERTIA_DECAY_MS);
      if (f.kind === "orbit") {
        this.orbit(f.vx * dt, f.vy * dt);
        f.vx *= decay;
        f.vy *= decay;
        if (Math.hypot(f.vx, f.vy) < 0.01) this.fling = null;
      } else {
        this.spin(f.axis, f.rate * dt);
        f.rate *= decay;
        // Stop once the ground under the view moves less than about a pixel a second.
        const dist = Math.max(1, Cartesian3.distance(this.camera.positionWC, this.pivot));
        if (f.rate * Cartesian3.magnitude(this.pivot) < this.metresPerPixelAt(dist) / 1000) this.fling = null;
      }
    }

    if (this.zoomTarget || this.fling) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private record(s: Sample): void {
    this.samples.push(s);
    if (this.samples.length > 8) this.samples.shift();
  }

  /**
   * Starts a fling from how the pointer was moving just before it was let go. Times are the
   * events' own, and the limits follow the pace the moves came in at, so a slow frame rate
   * (a heavy city model) still flings.
   */
  private startFling(mode: DragMode | "spin", now: number): void {
    const all = this.samples;
    this.samples = [];
    const last = all[all.length - 1];
    if (!last || all.length < 2) return;
    const pace = last.t - all[all.length - 2]!.t;
    if (now - last.t > Math.max(FLING_REST_MS, 1.5 * pace)) return;
    // The moves in the last ~120 ms, measured from the move before them.
    let first = all.length - 1;
    while (first > 1 && last.t - all[first - 1]!.t < 120) first--;
    const used = all.slice(first);
    const span = Math.max(8, last.t - all[first - 1]!.t);
    if (mode === "orbit") {
      let dx = 0, dy = 0;
      for (const s of used) { dx += s.dx; dy += s.dy; }
      const vx = dx / span, vy = dy / span;
      if (Math.hypot(vx, vy) < 0.15) return;
      this.fling = { kind: "orbit", vx, vy };
    } else {
      const rot = new Cartesian3();
      let px = 0;
      for (const s of used) {
        if (s.rot) Cartesian3.add(rot, s.rot, rot);
        px += Math.hypot(s.dx, s.dy);
      }
      const angle = Cartesian3.magnitude(rot);
      if (!(angle > 0) || px / span < 0.15) return;
      this.fling = { kind: "spin", axis: Cartesian3.normalize(rot, rot), rate: angle / span };
    }
    this.animate();
  }

  // ---------- internals: input ----------

  private onPointerDown(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    // Touching the view stops whatever is still moving, as on a map.
    this.stopMotion();
    if (this.pointers.size === 2) {
      this.drag = null;
      this.pinch = this.pinchState();
      this.pinch.anchor = this.opts.pick(new Cartesian2(this.pinch.mx, this.pinch.my));
      return;
    }
    let mode: DragMode | "spin" | null = e.button === 0 ? this.leftDrag : e.button === 1 || e.button === 2 ? "pan" : null;
    if (!mode) return;
    if (e.button === 0 && this.opts.isToolActive?.()) return; // clicks belong to the tool
    const pos = new Cartesian2(e.offsetX, e.offsetY);
    let anchor: Cartesian3 | undefined;
    if (mode === "orbit" && this.cameraHeight() > GLOBE_SPIN_HEIGHT) mode = "spin";
    if (mode === "orbit") {
      // Orbit around what is under the cursor; over the sky, around the centre of the view.
      anchor =
        this.opts.pick(pos) ??
        this.opts.pick(new Cartesian2(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2)) ??
        Cartesian3.clone(this.pivot);
    } else {
      anchor = this.opts.pick(pos);
    }
    this.samples = [{ t: e.timeStamp, dx: 0, dy: 0 }];
    this.drag = { mode, x: e.offsetX, y: e.offsetY, id: e.pointerId, anchor, started: false };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer already gone (a very short tap) cannot be captured: the drag still works.
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size === 2) {
      this.onPinchMove();
      return;
    }
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (dx === 0 && dy === 0) return;
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    // Event times, not handling times: a slow frame must not turn a fling into a stop.
    const t = e.timeStamp;

    if (drag.mode === "orbit") {
      if (!drag.started && drag.anchor) {
        Cartesian3.clone(drag.anchor, this.pivot);
        this.opts.onPivotSet?.(drag.anchor);
      }
      drag.started = true;
      this.orbit(dx, dy);
      this.record({ t, dx, dy });
      return;
    }

    drag.started = true;
    // Grab the ground: the point under the cursor stays under the cursor.
    const rot = drag.anchor ? this.grab(drag.anchor, e.offsetX, e.offsetY) : undefined;
    if (rot) {
      if (drag.anchor) Cartesian3.clone(drag.anchor, this.pivot);
      this.record({ t, dx, dy, rot });
    } else if (!drag.anchor) {
      // Nothing grabbed (the drag started over the sky): slide parallel to the screen.
      this.pan(dx, dy);
    }
  }

  private onPinchMove(): void {
    const prev = this.pinch!;
    const next = this.pinchState();
    next.anchor = prev.anchor;
    if (next.dist > 0 && prev.dist > 0) {
      const anchor = prev.anchor;
      if (anchor) {
        // The point between the fingers follows them, the distance zooms, the twist turns.
        this.grab(anchor, next.mx, next.my);
        this.zoomToward(anchor, Math.log(next.dist / prev.dist) / -Math.log(ZOOM_STEP));
        let twist = next.angle - prev.angle;
        if (twist > Math.PI) twist -= 2 * Math.PI;
        if (twist < -Math.PI) twist += 2 * Math.PI;
        if (Math.abs(twist) > 1e-4) {
          this.rotateAbout(anchor, Matrix3.fromQuaternion(Quaternion.fromAxisAngle(this.surfaceNormal(anchor), twist)));
        }
        Cartesian3.clone(anchor, this.pivot);
      } else {
        this.zoomAt(Math.log(next.dist / prev.dist) / -Math.log(ZOOM_STEP), next.mx, next.my);
        this.pan(next.mx - prev.mx, next.my - prev.my);
      }
    }
    this.pinch = next;
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag?.id === e.pointerId) {
      const mode = this.drag.mode;
      const started = this.drag.started;
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (started && e.type === "pointerup") this.startFling(mode, e.timeStamp);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // A wheel turn stops a fling but adds to a zoom still easing in.
    this.fling = null;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a trackpad scroll as many small
    // pixel deltas, which are applied straight away (they are already smooth).
    const scale = e.ctrlKey ? 0.04 : e.deltaMode === 1 ? 0.33 : 0.01;
    const steps = Math.max(-6, Math.min(6, -e.deltaY * scale));
    if (Math.abs(e.deltaY) < 40 && e.deltaMode === 0) this.zoomAt(steps, e.offsetX, e.offsetY);
    else this.smoothZoomAt(steps, e.offsetX, e.offsetY);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.opts.isToolActive?.()) return;
    const p = this.opts.pick(new Cartesian2(e.offsetX, e.offsetY));
    if (!p) return;
    // Zoom in on the spot, as on a map, and orbit around it from now on.
    Cartesian3.clone(p, this.pivot);
    this.opts.onPivotSet?.(p);
    this.stopMotion();
    this.zoomTarget = p;
    this.zoomPos = { x: e.offsetX, y: e.offsetY };
    this.zoomLeft = 4;
    this.animate();
  }

  private pinchState(): { dist: number; angle: number; mx: number; my: number; anchor?: Cartesian3 } {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { dist: 0, angle: 0, mx: 0, my: 0 };
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }
}
