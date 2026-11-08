/**
 * Where a ray meets a triangle mesh, in double precision (WP 2.4, NFR-07). A point read from the
 * depth buffer is only as good as the buffer, a few centimetres at a hundred metres; the
 * triangles themselves give the surface to well under a millimetre.
 */

export interface RayHit {
  /** Ray parameter: origin + t × direction. With an unnormalised direction, t is in its units. */
  t: number;
  /** Which triangle (index into the index list ÷ 3). */
  triangle: number;
}

/**
 * The nearest triangle the ray crosses with t in [tMin, tMax], or null. Both faces count.
 * skip(triangle) leaves a triangle out (a hidden part).
 */
export function rayMeshHit(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  tMin: number,
  tMax: number,
  skip?: (triangle: number) => boolean,
): RayHit | null {
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  let best: RayHit | null = null;
  let bestT = tMax;
  const n = indices.length - (indices.length % 3);
  for (let k = 0; k < n; k += 3) {
    const a = indices[k]! * 3, b = indices[k + 1]! * 3, c = indices[k + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const e1x = positions[b]! - ax, e1y = positions[b + 1]! - ay, e1z = positions[b + 2]! - az;
    const e2x = positions[c]! - ax, e2y = positions[c + 1]! - ay, e2z = positions[c + 2]! - az;
    // Möller–Trumbore.
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det === 0) continue;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < tMin || t > bestT) continue;
    if (skip?.(k / 3)) continue;
    bestT = t;
    best = { t, triangle: k / 3 };
  }
  return best;
}
