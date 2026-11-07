import { describe, expect, it } from "vitest";
import { buildSnapIndex, querySnapIndex, type SnapIndex } from "./snap-index";

/** A box as glTF writes it: 24 vertices (4 per face, for the normals), 12 triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, offset = 0) {
  const c = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const faces = [
    [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    const base = offset + positions.length / 3;
    for (const v of f) positions.push(...c(v)!);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** A flat n × n grid of quads, each split into two triangles. */
function grid(n: number, size: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push((i / n) * size, (j / n) * size, 0);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return { positions, indices };
}

function near(index: SnapIndex, p: [number, number, number], r: number) {
  const found: { kind: string; i: number }[] = [];
  querySnapIndex(
    index,
    (x0, y0, z0, x1, y1, z1) => p[0] >= x0 - r && p[0] <= x1 + r && p[1] >= y0 - r && p[1] <= y1 + r && p[2] >= z0 - r && p[2] <= z1 + r,
    (kind, i) => found.push({ kind, i }),
  );
  return found;
}

describe("snap index", () => {
  it("finds the 8 corners and 12 edges of a box, not the face diagonals", () => {
    const idx = buildSnapIndex(box(0, 0, 0, 2, 3, 4));
    expect(idx.corners.length / 3).toBe(8);
    expect(idx.edges.length / 6).toBe(12);
    for (let e = 0; e < 12; e++) {
      const a = idx.edges.subarray(e * 6, e * 6 + 3);
      const b = idx.edges.subarray(e * 6 + 3, e * 6 + 6);
      // Box edges run along one axis: the end points differ in one coordinate only.
      const differ = [0, 1, 2].filter((k) => a[k] !== b[k]).length;
      expect(differ).toBe(1);
    }
  });

  it("keeps only the outline of a flat tessellated surface", () => {
    const idx = buildSnapIndex(grid(10, 10));
    expect(idx.edges.length / 6).toBe(40);
    // The outline's corners only, not the points along its straight sides.
    expect(idx.corners.length / 3).toBe(4);
  });

  it("does not see faces drawn twice back to back as a fold", () => {
    const g = grid(2, 1);
    const n = g.positions.length / 3;
    const back = { positions: [...g.positions, ...g.positions], indices: [...g.indices, ...g.indices.map((i, k) => (k % 3 === 1 ? g.indices[k + 1]! : k % 3 === 2 ? g.indices[k - 1]! : i) + n)] };
    const idx = buildSnapIndex(back);
    // The outline edges each have four faces now; the inner edges are flat.
    for (let e = 0; e < idx.edges.length / 6; e++) {
      const ys = [idx.edges[e * 6 + 1]!, idx.edges[e * 6 + 4]!];
      const xs = [idx.edges[e * 6]!, idx.edges[e * 6 + 3]!];
      const onOutline = xs.every((x) => x === 0) || xs.every((x) => x === 1) || ys.every((y) => y === 0) || ys.every((y) => y === 1);
      expect(onOutline).toBe(true);
    }
  });

  it("finds a corner of a big mesh by its neighbourhood, with only a few items looked at", () => {
    const parts = [];
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 10, y = Math.floor(i / 20) * 10;
      const b = box(x, y, 0, x + 4, y + 4, 3 + (i % 5), positions.length / 3);
      positions.push(...b.positions);
      indices.push(...b.indices);
      parts.push(b);
    }
    const idx = buildSnapIndex({ positions, indices });
    expect(idx.corners.length / 3).toBe(400 * 8);
    const found = near(idx, [104, 54, 3 + (105 % 5)], 0.5);
    const corners = found.filter((f) => f.kind === "corner").map((f) => Array.from(idx.corners.subarray(f.i * 3, f.i * 3 + 3)));
    expect(corners).toContainEqual([104, 54, 3 + (105 % 5)]);
    expect(found.length).toBeLessThan(40);
  });

  it("keeps the feature id of each corner and edge", () => {
    const a = box(0, 0, 0, 1, 1, 1);
    const b = box(5, 0, 0, 6, 1, 1, 24);
    const featureIds = [...Array(24).fill(0), ...Array(24).fill(7)];
    const idx = buildSnapIndex({ positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices], featureIds });
    for (let c = 0; c < idx.corners.length / 3; c++) expect(idx.cornerFeature[c]).toBe(idx.corners[c * 3]! < 3 ? 0 : 7);
    for (let e = 0; e < idx.edges.length / 6; e++) expect(idx.edgeFeature[e]).toBe(idx.edges[e * 6]! < 3 ? 0 : 7);
  });

  it("handles an empty mesh", () => {
    const idx = buildSnapIndex({ positions: [], indices: [] });
    expect(near(idx, [0, 0, 0], 1)).toEqual([]);
  });
});
