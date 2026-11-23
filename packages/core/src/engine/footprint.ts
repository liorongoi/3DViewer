import { BoundingSphere, type Cesium3DTileset } from "cesium";

/**
 * Where a tileset's data actually is. Publishers often give the root and the first levels a
 * volume for their whole territory (Strasbourg's covers the Eurométropole, 21 km across, for
 * a 600 m sample), and those first levels are all that is loaded when the view is far out,
 * which is how a fit run right after opening sees it. So this reads the tile tree itself,
 * which is known before any content loads: the finest tiles (leaves) are where the data is,
 * with volumes the size of the data. Oversized leaves (an external tileset not read yet,
 * say) are left out.
 */
export function dataFootprint(tileset: Cesium3DTileset): BoundingSphere {
  const spheres: BoundingSphere[] = [];
  const stack = [tileset.root];
  // Tens of thousands of headers at most in practice; the cap only guards a runaway tree.
  for (let seen = 0; stack.length && seen < 200000; seen++) {
    const t = stack.pop()!;
    if (t.children.length) stack.push(...t.children);
    else spheres.push(t.boundingSphere);
  }
  if (!spheres.length) return tileset.boundingSphere;
  const radii = spheres.map((s) => s.radius).sort((x, y) => x - y);
  const median = radii[Math.floor(radii.length / 2)]!;
  const fp = BoundingSphere.fromBoundingSpheres(spheres.filter((s) => s.radius <= median * 10));
  // Tile volumes already include the tileset's model matrix. The tileset's own sphere wins
  // when it is the tighter one.
  return fp.radius < tileset.boundingSphere.radius ? fp : tileset.boundingSphere;
}
