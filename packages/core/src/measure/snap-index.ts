// Snap targets of one mesh (WP 2.3, MSR-03): its corners and its feature edges, in a bounding
// volume hierarchy so the few near the cursor are found without looking at the rest.
//
// A feature edge is where the surface turns: an edge on the outline of a surface, or one whose two
// faces meet at more than the crease angle. The diagonals that split a flat face into triangles
// are not feature edges, so they are never snapped to. A corner is where feature edges meet at an
// angle, or where one ends; a point along a straight outline is not one. Vertices are welded
// first: glTF repeats a vertex for each normal or texture seam, and those copies are one point.
//
// Pure data and arithmetic, so it runs in a worker and in tests.

export interface SnapGeometry {
  /** x, y, z per vertex. */
  positions: ArrayLike<number>;
  /** Three vertex indices per triangle. */
  indices: ArrayLike<number>;
  /** A feature id per vertex (3D Tiles parts), to leave out hidden parts. */
  featureIds?: ArrayLike<number>;
}

export interface SnapIndex {
  /** x, y, z per corner. */
  corners: Float64Array;
  cornerFeature: Int32Array;
  /** ax, ay, az, bx, by, bz per feature edge. */
  edges: Float64Array;
  edgeFeature: Int32Array;
  /** min x, y, z, max x, y, z per node. */
  boxes: Float64Array;
  /** Per node: first child (inner node) or first item (leaf), and the item count (0 for an inner node). */
  nodes: Int32Array;
  /** Items in leaf order: i < corner count is corner i, otherwise edge i - corner count. */
  items: Int32Array;
}

const LEAF = 8;

/** Corners and feature edges of a triangle mesh. Crease angle in degrees. */
export function buildSnapIndex(g: SnapGeometry, creaseDegrees = 30): SnapIndex {
  const pos = g.positions;
  const vertexCount = Math.floor(pos.length / 3);
  // Weld: vertices closer than a millionth of the mesh size are one point.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  const step = size * 1e-6;
  const weld = new Int32Array(vertexCount);
  const keyToId = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
    const key = `${Math.round((x - minX) / step)},${Math.round((y - minY) / step)},${Math.round((z - minZ) / step)}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      keyToId.set(key, id);
      welded.push(x, y, z);
    }
    weld[i] = id;
  }
  const weldedCount = welded.length / 3;

  // Edges by welded end points, with the faces on each side.
  const idx = g.indices;
  const triCount = Math.floor(idx.length / 3);
  const normals = new Float64Array(triCount * 3);
  const edgeOf = new Map<number, number>();
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeFeatureVertex: number[] = [];
  const edgeFace1: number[] = [];
  const edgeThird1: number[] = [];
  /** A flat face lies on the other side of the edge: it is inside a surface, not on its outline. */
  const inner: boolean[] = [];
  const sharp: boolean[] = [];
  const cosCrease = Math.cos((creaseDegrees * Math.PI) / 180);
  // Which side of edge a-b the point c lies on, against point d: positive for the same side.
  const side = (a: number, b: number, c: number, d: number) => {
    const ex = welded[b * 3]! - welded[a * 3]!, ey = welded[b * 3 + 1]! - welded[a * 3 + 1]!, ez = welded[b * 3 + 2]! - welded[a * 3 + 2]!;
    const ee = ex * ex + ey * ey + ez * ez || 1;
    const perp = (v: number) => {
      const px = welded[v * 3]! - welded[a * 3]!, py = welded[v * 3 + 1]! - welded[a * 3 + 1]!, pz = welded[v * 3 + 2]! - welded[a * 3 + 2]!;
      const t = (px * ex + py * ey + pz * ez) / ee;
      return [px - t * ex, py - t * ey, pz - t * ez] as const;
    };
    const u = perp(c), v = perp(d);
    return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3]!, i1 = idx[t * 3 + 1]!, i2 = idx[t * 3 + 2]!;
    const w = [weld[i0]!, weld[i1]!, weld[i2]!];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    const ax = welded[w[0]! * 3]!, ay = welded[w[0]! * 3 + 1]!, az = welded[w[0]! * 3 + 2]!;
    const ux = welded[w[1]! * 3]! - ax, uy = welded[w[1]! * 3 + 1]! - ay, uz = welded[w[1]! * 3 + 2]! - az;
    const vx = welded[w[2]! * 3]! - ax, vy = welded[w[2]! * 3 + 1]! - ay, vz = welded[w[2]! * 3 + 2]! - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len <= 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;
    for (let k = 0; k < 3; k++) {
      const a = w[k]!, b = w[(k + 1) % 3]!, c = w[(k + 2) % 3]!;
      const key = a < b ? a * weldedCount + b : b * weldedCount + a;
      const e = edgeOf.get(key);
      if (e === undefined) {
        edgeOf.set(key, edgeA.length);
        edgeA.push(Math.min(a, b));
        edgeB.push(Math.max(a, b));
        edgeFeatureVertex.push(g.featureIds ? g.featureIds[[i0, i1, i2][k]!]! : -1);
        edgeFace1.push(t);
        edgeThird1.push(c);
        inner.push(false);
        sharp.push(false);
        continue;
      }
      if (sharp[e]) continue;
      const f = edgeFace1[e]!;
      // Faces drawn twice back to back are flat, not a fold: compare without the sign.
      const dot = Math.abs(normals[f * 3]! * nx + normals[f * 3 + 1]! * ny + normals[f * 3 + 2]! * nz);
      if (dot < cosCrease) sharp[e] = true;
      else if (side(a, b, c, edgeThird1[e]!) < 0) inner[e] = true;
    }
  }

  const edgeList: number[] = [];
  const edgeFeat: number[] = [];
  // Per vertex: how many feature edges end there, and whether they all lie on one straight line
  // through it. A vertex in the middle of a straight outline (where an exporter split a long
  // edge) is not a corner.
  const ends = new Int32Array(weldedCount);
  const firstDir = new Float64Array(weldedCount * 3);
  const bends = new Uint8Array(weldedCount);
  const cornerFeatureOf = new Int32Array(weldedCount).fill(-1);
  const sinStraight = Math.sin((1 * Math.PI) / 180);
  const meet = (v: number, other: number, feature: number) => {
    let dx = welded[other * 3]! - welded[v * 3]!, dy = welded[other * 3 + 1]! - welded[v * 3 + 1]!, dz = welded[other * 3 + 2]! - welded[v * 3 + 2]!;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    if (ends[v] === 0) {
      firstDir[v * 3] = dx;
      firstDir[v * 3 + 1] = dy;
      firstDir[v * 3 + 2] = dz;
    } else {
      const fx = firstDir[v * 3]!, fy = firstDir[v * 3 + 1]!, fz = firstDir[v * 3 + 2]!;
      const cross = Math.hypot(fy * dz - fz * dy, fz * dx - fx * dz, fx * dy - fy * dx);
      // Going on in the opposite direction is straight; anything else bends.
      if (cross > sinStraight || fx * dx + fy * dy + fz * dz > 0) bends[v] = 1;
    }
    ends[v]!++;
    cornerFeatureOf[v] = feature;
  };
  for (let e = 0; e < edgeA.length; e++) {
    if (!sharp[e] && inner[e]) continue;
    const a = edgeA[e]!, b = edgeB[e]!;
    edgeList.push(welded[a * 3]!, welded[a * 3 + 1]!, welded[a * 3 + 2]!, welded[b * 3]!, welded[b * 3 + 1]!, welded[b * 3 + 2]!);
    edgeFeat.push(edgeFeatureVertex[e]!);
    meet(a, b, edgeFeatureVertex[e]!);
    meet(b, a, edgeFeatureVertex[e]!);
  }
  const cornerList: number[] = [];
  const cornerFeat: number[] = [];
  for (let v = 0; v < weldedCount; v++) {
    // An end of a single edge, three or more edges meeting, or two meeting at an angle.
    const corner = ends[v] === 1 || ends[v]! > 2 || (ends[v] === 2 && bends[v]);
    if (!corner) continue;
    cornerList.push(welded[v * 3]!, welded[v * 3 + 1]!, welded[v * 3 + 2]!);
    cornerFeat.push(cornerFeatureOf[v]!);
  }
  const corners = Float64Array.from(cornerList);
  const edges = Float64Array.from(edgeList);
  return { corners, cornerFeature: Int32Array.from(cornerFeat), edges, edgeFeature: Int32Array.from(edgeFeat), ...buildBvh(corners, edges) };
}

function buildBvh(corners: Float64Array, edges: Float64Array): Pick<SnapIndex, "boxes" | "nodes" | "items"> {
  const nc = corners.length / 3;
  const ne = edges.length / 6;
  const n = nc + ne;
  const items = new Int32Array(n);
  const lo = new Float64Array(n * 3);
  const hi = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    items[i] = i;
    for (let k = 0; k < 3; k++) {
      if (i < nc) {
        lo[i * 3 + k] = hi[i * 3 + k] = corners[i * 3 + k]!;
      } else {
        const a = edges[(i - nc) * 6 + k]!, b = edges[(i - nc) * 6 + 3 + k]!;
        lo[i * 3 + k] = Math.min(a, b);
        hi[i * 3 + k] = Math.max(a, b);
      }
    }
  }
  const boxes: number[] = [];
  const nodes: number[] = [];
  // Each entry: node index, first item, item count.
  const stack: [number, number, number][] = [];
  const addNode = () => {
    boxes.push(0, 0, 0, 0, 0, 0);
    nodes.push(0, 0);
    return nodes.length / 2 - 1;
  };
  if (n > 0) stack.push([addNode(), 0, n]);
  const centre = (i: number, k: number) => lo[i * 3 + k]! + hi[i * 3 + k]!;
  while (stack.length) {
    const [node, start, count] = stack.pop()!;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = start; j < start + count; j++) {
      const i = items[j]!;
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, lo[i * 3 + k]!);
        b[k + 3] = Math.max(b[k + 3]!, hi[i * 3 + k]!);
      }
    }
    for (let k = 0; k < 6; k++) boxes[node * 6 + k] = b[k]!;
    if (count <= LEAF) {
      nodes[node * 2] = start;
      nodes[node * 2 + 1] = count;
      continue;
    }
    // Split at the median along the longest side.
    const ext = [b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!];
    const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
    const part = Array.from(items.subarray(start, start + count)).sort((p, q) => centre(p, axis) - centre(q, axis));
    items.set(part, start);
    const half = count >> 1;
    const left = addNode();
    const right = addNode();
    nodes[node * 2] = left;
    nodes[node * 2 + 1] = 0;
    stack.push([left, start, half], [right, start + half, count - half]);
  }
  return { boxes: Float64Array.from(boxes), nodes: Int32Array.from(nodes), items };
}

/**
 * Visits the corners and edges in the boxes the test accepts. The test gets a node's box
 * (min x, y, z, max x, y, z) and says whether anything inside could be wanted.
 */
export function querySnapIndex(
  index: SnapIndex,
  wantBox: (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean,
  visit: (kind: "corner" | "edge", i: number) => void,
): void {
  const { boxes, nodes, items } = index;
  if (!nodes.length) return;
  const nc = index.corners.length / 3;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const o = node * 6;
    if (!wantBox(boxes[o]!, boxes[o + 1]!, boxes[o + 2]!, boxes[o + 3]!, boxes[o + 4]!, boxes[o + 5]!)) continue;
    const first = nodes[node * 2]!, count = nodes[node * 2 + 1]!;
    if (count === 0) {
      stack.push(first, first + 1);
      continue;
    }
    for (let j = first; j < first + count; j++) {
      const i = items[j]!;
      if (i < nc) visit("corner", i);
      else visit("edge", i - nc);
    }
  }
}

/** The arrays of an index, to hand it from a worker without copying. */
export function snapIndexBuffers(index: SnapIndex): ArrayBuffer[] {
  return [index.corners, index.cornerFeature, index.edges, index.edgeFeature, index.boxes, index.nodes, index.items].map((a) => a.buffer as ArrayBuffer);
}
