import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { computeViewshedGrid, viewshedCellFor, viewshedGridFrame } from "./viewshed-grid";

// gdal_viewshed on the line-of-sight test DEM (scripts/viewshed-reference.py).
// Core has no Node types: the tests run in Node, so fs is loaded by name.
const { readFileSync } = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc?: string): Uint8Array & string };
const fixtures = new URL("../../../../scripts/fixtures/", import.meta.url);
const REF = JSON.parse(readFileSync(new URL("viewshed-reference.json", fixtures), "utf8")) as {
  cell: number;
  k: number;
  radius: number;
  observers: { name: string; x: number; y: number; lon: number; lat: number; eye: number; size: number; visibleCells: number; cells: number; mask: string }[];
};
const X0 = 708000;
const Y0 = 3518000;

async function dem() {
  const buf = readFileSync(new URL("sight-dem.tif", fixtures));
  const tiff = await fromArrayBuffer(Uint8Array.from(buf).buffer);
  const image = await tiff.getImage();
  const [band] = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];
  return { band: band!, width: image.getWidth() };
}

describe("viewshed on a grid", () => {
  it("matches gdal_viewshed on the test DEM: visible area within 2 % and nearly every cell the same", async () => {
    const { band, width } = await dem();
    for (const o of REF.observers) {
      const m = (o.size - 1) / 2;
      const col = Math.round((o.x - X0) / REF.cell - 0.5);
      const row = Math.round((Y0 - o.y) / REF.cell - 0.5);
      const heights = new Float64Array(o.size * o.size);
      for (let j = 0; j < o.size; j++) for (let i = 0; i < o.size; i++) heights[j * o.size + i] = band[(row - m + j) * width + (col - m + i)]!;
      const eye = heights[m * o.size + m]! + o.eye;
      const r = computeViewshedGrid({ size: o.size, cell: REF.cell, heights }, eye, REF.radius, { k: REF.k });
      expect(r.cells).toBe(o.cells);
      const areaError = Math.abs(r.visibleCells - o.visibleCells) / o.cells;
      expect(areaError, `${o.name}: ${r.visibleCells} cells seen, gdal_viewshed ${o.visibleCells}`).toBeLessThanOrEqual(0.02);
      const mask = Uint8Array.from(atob(o.mask), (ch) => ch.charCodeAt(0));
      let differ = 0;
      for (let c = 0; c < o.size * o.size; c++) {
        if (r.visible[c] === 255) continue;
        const gdal = (mask[c >> 3]! >> (7 - (c & 7))) & 1;
        if (gdal !== r.visible[c]) differ++;
      }
      expect(differ / o.cells, `${o.name}: ${differ} cells differ`).toBeLessThanOrEqual(0.02);
    }
  });

  it("lays the grid out in the observer's UTM zone with the observer in the middle cell", () => {
    const f = viewshedGridFrame(35.2, 31.77, 100, 10);
    expect(f.epsg).toBe(32636);
    expect(f.size).toBe(21);
    const c = f.centres();
    expect(c[10 * 21 + 10]!.lon).toBeCloseTo(35.2, 9);
    expect(c[10 * 21 + 10]!.lat).toBeCloseTo(31.77, 9);
    // North-west corner first: west of and north of the observer.
    expect(c[0]!.lon).toBeLessThan(35.2);
    expect(c[0]!.lat).toBeGreaterThan(31.77);
  });

  it("picks a cell near 1/400 of the diameter", () => {
    expect(viewshedCellFor(1000)).toBe(5);
    expect(viewshedCellFor(800)).toBe(5);
    expect(viewshedCellFor(2000)).toBe(10);
    expect(viewshedCellFor(5000)).toBe(25);
    expect(viewshedCellFor(50)).toBe(0.5);
  });
});
