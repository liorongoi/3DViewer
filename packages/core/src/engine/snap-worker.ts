// Builds snap indexes off the main thread, so a large mesh does not stall the view (WP 2.3).
import { buildSnapIndex, snapIndexBuffers, type SnapGeometry } from "../measure/snap-index";

self.onmessage = (e: MessageEvent<{ id: number; geometry: SnapGeometry }>) => {
  const { id, geometry } = e.data;
  try {
    const index = buildSnapIndex(geometry);
    (self as unknown as Worker).postMessage({ id, index }, snapIndexBuffers(index));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
