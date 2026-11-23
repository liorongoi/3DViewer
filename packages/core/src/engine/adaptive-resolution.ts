/** Frames slower than this, on average over half a second, lower the resolution. */
export const SLOW_FRAME_MS = 20;
/** The lowest resolution, as a share of the quality preset's. */
export const MIN_SHARE = 0.6;
/** How much one step lowers the resolution, as a share of the preset's. */
export const STEP_SHARE = 0.1;
/** After a change, frames are not judged for this long: the first frames at a new size are slow anyway. */
export const SETTLE_MS = 1000;

/**
 * Adaptive resolution (NFR-03), decided once per half second of frames.
 *
 * It only ever lowers the resolution while the view moves, and goes back to the preset in one
 * step once the view is still. Raising and lowering it while the view moved made the picture
 * turn soft and sharp again and again during a zoom, as tiles loading slowed some frames.
 */
export function nextResolutionScale(o: {
  scale: number;
  base: number;
  avgFrameMs: number;
  moving: boolean;
  now: number;
  changedAt: number;
}): number {
  const { scale, base } = o;
  if (!o.moving) return base;
  if (o.now - o.changedAt < SETTLE_MS) return scale;
  const floor = base * MIN_SHARE;
  if (o.avgFrameMs > SLOW_FRAME_MS && scale > floor + 1e-3) return Math.max(floor, scale - base * STEP_SHARE);
  return scale;
}
