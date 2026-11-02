import type { ViewerEngine } from "@viewer/core";
import type { ClassificationLevel, ModelSummary } from "@viewer/shared";

/**
 * Library thumbnail (WP 3.5, UPL-08): a sprite of 24 turntable frames, 320 × 180 each, side by side.
 * The card shows frame 0 and scrubs through the others under the pointer. Every frame carries
 * the classification band at the top, burned into the pixels (UPL-10), so a frame copied out of
 * the sprite still shows its level.
 * The server's thumbnail worker opens "?render-only" in headless Chromium and calls this.
 */
export async function renderTurntable(engine: ViewerEngine, model: ModelSummary, level: ClassificationLevel | null): Promise<string | null> {
  const C = await import("cesium");
  const e = engine;
  e.setGlobe(false);
  e.setShadows(true);
  const scene = e.widget.scene;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  scene.backgroundColor = C.Color.fromCssColorString("#2A2E35");
  await e.open(model, { fly: false });
  if (e.error.get()) throw new Error(e.error.get()!.reason);
  // 3D Tiles refine over a few frames, and the bounding sphere is final only after they render.
  for (let i = 0; i < 40; i++) {
    e.widget.render();
    await new Promise((r) => setTimeout(r, 50));
  }
  const bs = e.boundingSphere();
  if (!bs) return null;
  e.widget.camera.frustum.near = Math.max(0.01, bs.radius * 0.02);
  const range = bs.radius * (model.sourceFormat === "3dtiles" ? 2.2 : 2.9);
  const W = 320;
  const H = 180;
  const N = 24;
  const band = 14;
  const sprite = document.createElement("canvas");
  sprite.width = W * N;
  sprite.height = H;
  const g = sprite.getContext("2d")!;
  for (let i = 0; i < N; i++) {
    const heading = C.Math.toRadians(30 + (360 / N) * i);
    e.widget.camera.lookAt(bs.center, new C.HeadingPitchRange(heading, C.Math.toRadians(-22), range));
    for (let k = 0; k < 3; k++) e.widget.render();
    g.drawImage(e.widget.canvas, i * W, 0, W, H);
    if (level) {
      g.fillStyle = level.color;
      g.fillRect(i * W, 0, W, band);
      g.fillStyle = level.textColor;
      g.font = '600 9px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(level.label.toUpperCase(), i * W + W / 2, band / 2 + 0.5);
    }
  }
  e.widget.camera.lookAtTransform(C.Matrix4.IDENTITY);
  return sprite.toDataURL("image/webp", 0.82);
}
