import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  type Camera,
  type Scene,
  HeadingPitchRange,
  Math as CMath,
  Matrix4,
  Transforms,
  EasingFunction,
} from "cesium";
import { signal } from "../signal";

export interface Viewpoint {
  destination: Cartesian3;
  heading: number;
  pitch: number;
  roll: number;
}

export function captureViewpoint(camera: Camera): Viewpoint {
  return {
    destination: Cartesian3.clone(camera.positionWC),
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  };
}

/**
 * Drone-style free flight (requested by the product owner, Nov 2026).
 * W/S forward/back, A/D strafe, Q/E down/up, mouse drag to look, Shift = 4× speed.
 * Speed scales with height above the ellipsoid so it feels right at street and city level.
 */
export class FlyMode {
  readonly enabled = signal(false);
  readonly speed = signal(0); // metres per second, for the HUD

  private keys = new Set<string>();
  private raf = 0;
  private last = 0;
  private looking: { x: number; y: number; id: number } | null = null;
  private disposers: (() => void)[] = [];

  constructor(private readonly scene: Scene, private readonly canvas: HTMLCanvasElement) {}

  enable(): void {
    if (this.enabled.get()) return;
    this.enabled.set(true);
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "q", "e", "shift"].includes(k)) {
        if (down) this.keys.add(k);
        else this.keys.delete(k);
        e.preventDefault();
      }
    };
    const kd = onKey(true);
    const ku = onKey(false);
    const pd = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.looking = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.canvas.setPointerCapture(e.pointerId);
      e.stopImmediatePropagation();
    };
    const pm = (e: PointerEvent) => {
      if (!this.looking || e.pointerId !== this.looking.id) return;
      const dx = e.clientX - this.looking.x;
      const dy = e.clientY - this.looking.y;
      this.looking.x = e.clientX;
      this.looking.y = e.clientY;
      const k = 0.0035;
      const cam = this.scene.camera;
      const up = Cartesian3.normalize(cam.positionWC, new Cartesian3());
      cam.look(up, dx * k);
      cam.lookUp(-dy * k);
      e.stopImmediatePropagation();
    };
    const pu = (e: PointerEvent) => {
      if (this.looking?.id === e.pointerId) this.looking = null;
    };
    const blur = () => this.keys.clear();
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    this.canvas.addEventListener("pointerdown", pd, { capture: true });
    this.canvas.addEventListener("pointermove", pm, { capture: true });
    this.canvas.addEventListener("pointerup", pu, { capture: true });
    this.disposers = [
      () => window.removeEventListener("keydown", kd),
      () => window.removeEventListener("keyup", ku),
      () => window.removeEventListener("blur", blur),
      () => this.canvas.removeEventListener("pointerdown", pd, { capture: true }),
      () => this.canvas.removeEventListener("pointermove", pm, { capture: true }),
      () => this.canvas.removeEventListener("pointerup", pu, { capture: true }),
    ];
    this.last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      this.step(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  disable(): void {
    if (!this.enabled.get()) return;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.disposers = [];
    this.keys.clear();
    this.looking = null;
    this.speed.set(0);
    this.enabled.set(false);
  }

  private step(dt: number): void {
    const cam = this.scene.camera;
    const carto = Cartographic.fromCartesian(cam.positionWC);
    const height = Math.max(2, carto?.height ?? 100);
    let v = Math.min(5000, Math.max(3, height * 0.6));
    if (this.keys.has("shift")) v *= 4;
    const d = v * dt;
    let moved = false;
    if (this.keys.has("w")) { cam.moveForward(d); moved = true; }
    if (this.keys.has("s")) { cam.moveBackward(d); moved = true; }
    if (this.keys.has("a")) { cam.moveLeft(d); moved = true; }
    if (this.keys.has("d")) { cam.moveRight(d); moved = true; }
    const up = Cartesian3.normalize(cam.positionWC, new Cartesian3());
    if (this.keys.has("e")) { cam.move(up, d); moved = true; }
    if (this.keys.has("q")) { cam.move(up, -d); moved = true; }
    this.speed.set(moved ? Math.round(v) : 0);
    if (moved) this.scene.requestRender();
  }
}

/** Automatic fly-by tours: a cinematic orbit, or a flight through saved viewpoints. */
export class FlyByTour {
  readonly running = signal<"orbit" | "viewpoints" | null>(null);
  private raf = 0;
  private stopFlag = false;

  constructor(private readonly scene: Scene) {}

  /** One slow orbit around a bounding sphere, with a gentle rise and fall. */
  orbit(sphere: BoundingSphere, seconds = 40): void {
    this.stop();
    this.running.set("orbit");
    const cam = this.scene.camera;
    const range = Math.max(sphere.radius * 2.6, 5);
    const start = performance.now();
    const startHeading = cam.heading;
    const enu = Transforms.eastNorthUpToFixedFrame(sphere.center);
    const tick = (t: number) => {
      if (this.stopFlag) return;
      const u = ((t - start) / 1000 / seconds) % 1;
      const heading = startHeading + u * CMath.TWO_PI;
      const pitch = CMath.toRadians(-22 - 10 * Math.sin(u * CMath.TWO_PI * 2));
      cam.lookAtTransform(enu, new HeadingPitchRange(heading, pitch, range));
      this.scene.requestRender();
      this.raf = requestAnimationFrame(tick);
    };
    this.stopFlag = false;
    this.raf = requestAnimationFrame(tick);
  }

  /** Flies through viewpoints in order, holding briefly at each, then loops. */
  async viewpoints(points: Viewpoint[], secondsPerLeg = 6, holdSeconds = 1.5): Promise<void> {
    this.stop();
    if (points.length < 2) return;
    this.running.set("viewpoints");
    this.stopFlag = false;
    const cam = this.scene.camera;
    for (let i = 0; !this.stopFlag; i = (i + 1) % points.length) {
      const p = points[i]!;
      await new Promise<void>((resolve) => {
        cam.flyTo({
          destination: p.destination,
          orientation: { heading: p.heading, pitch: p.pitch, roll: p.roll },
          duration: secondsPerLeg,
          easingFunction: EasingFunction.QUADRATIC_IN_OUT,
          complete: () => resolve(),
          cancel: () => resolve(),
        });
      });
      if (this.stopFlag) break;
      await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    }
  }

  stop(): void {
    this.stopFlag = true;
    cancelAnimationFrame(this.raf);
    const cam = this.scene.camera;
    cam.cancelFlight();
    cam.lookAtTransform(Matrix4.IDENTITY);
    this.running.set(null);
  }
}
