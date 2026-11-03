import {
  CustomHeightmapTerrainProvider,
  GeographicTilingScheme,
  Math as CMath,
  Rectangle,
  type TerrainData,
  type TerrainProvider,
} from "cesium";

/**
 * Terrain from "Terrarium" PNG elevation tiles (Web Mercator XYZ; height = R·256 + G + B/256 − 32768).
 * Works with the public AWS Terrain Tiles and with any internal mirror of the same layout,
 * so the same code runs online and on the air-gapped network (plan WP 1.6, VWR-GEO-01).
 *
 * Cesium asks for geographic tiles; each one is resampled from the matching Mercator tiles.
 * A missing tile falls back to its parent, so a partial mirror (a few areas at high zoom,
 * the world at low zoom) still gives continuous terrain.
 */
export interface TerrariumOptions {
  /** URL template with {z}, {x}, {y}. */
  url: string;
  /** Deepest zoom the source has. AWS has 15; local demo mirrors less. */
  maxZoom?: number;
  /** Size of the geographic heightmap Cesium builds per tile. */
  samples?: number;
}

type Pixels = { data: Uint8ClampedArray; size: number } | null;

/** Heights for one geographic tile, n × n, north row first. */
export type TileHeights = (
  x: number,
  y: number,
  level: number,
) => Promise<Float32Array>;

/** A terrain provider that also exposes its tile heights, so other terrain can be layered on it. */
export type LayerableTerrain = CustomHeightmapTerrainProvider & {
  tileHeights: TileHeights;
  samples: number;
};

/** An elevation source that covers part of the world, such as a user's GeoTIFF DEM. */
export interface DemSource {
  /** Footprint, radians. */
  rectangle: Rectangle;
  /** Heights on an n × n lon/lat grid over rect (north row first); NaN where there is no data. */
  heightGrid(rect: Rectangle, n: number): Promise<Float32Array | null>;
  /** "replace" (default): its heights win. "lower": it can only lower the terrain (the ground cut under a model). */
  mode?: "replace" | "lower";
}

export function createTerrariumTerrain(
  opts: TerrariumOptions,
): LayerableTerrain {
  const maxZoom = opts.maxZoom ?? 15;
  const n = opts.samples ?? 65;
  const cache = new Map<string, Promise<Pixels>>();
  const order: string[] = [];

  const load = (z: number, x: number, y: number): Promise<Pixels> => {
    const key = `${z}/${x}/${y}`;
    let p = cache.get(key);
    if (p) return p;
    const url = opts.url
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    p = fetch(url)
      .then((r) =>
        r.ok ? r.blob() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        return {
          data: ctx.getImageData(0, 0, bmp.width, bmp.height).data,
          size: bmp.width,
        };
      })
      .catch(() => null);
    cache.set(key, p);
    order.push(key);
    if (order.length > 512) cache.delete(order.shift()!);
    return p;
  };

  /** Tile at zoom z, or the nearest parent that exists. Returns the pixels and the zoom found. */
  const loadWithFallback = async (
    z: number,
    x: number,
    y: number,
  ): Promise<{
    px: NonNullable<Pixels>;
    z: number;
    x: number;
    y: number;
  } | null> => {
    for (let zz = z, xx = x, yy = y; zz >= 0; zz--, xx >>= 1, yy >>= 1) {
      const px = await load(zz, xx, yy);
      if (px) return { px, z: zz, x: xx, y: yy };
    }
    return null;
  };

  const heightAt = (
    px: NonNullable<Pixels>,
    fx: number,
    fy: number,
  ): number => {
    // Bilinear sample inside one tile (fx, fy in pixels).
    const s = px.size;
    const x0 = Math.max(0, Math.min(s - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(s - 1, Math.floor(fy)));
    const x1 = Math.min(s - 1, x0 + 1);
    const y1 = Math.min(s - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h = (x: number, y: number) => {
      const i = (y * s + x) * 4;
      return (
        px.data[i]! * 256 + px.data[i + 1]! + px.data[i + 2]! / 256 - 32768
      );
    };
    return (
      (h(x0, y0) * (1 - tx) + h(x1, y0) * tx) * (1 - ty) +
      (h(x0, y1) * (1 - tx) + h(x1, y1) * tx) * ty
    );
  };

  const tilingScheme = new GeographicTilingScheme();
  const tileHeights: TileHeights = async (x, y, level) => {
    const rect = tilingScheme.tileXYToRectangle(x, y, level);
    const z = Math.max(0, Math.min(maxZoom, level + 1));
    const world = 2 ** z;
    const toMerc = (lon: number, lat: number) => {
      const la = Math.max(-85.0511, Math.min(85.0511, lat));
      const mx = ((lon + 180) / 360) * world;
      const s = Math.sin(CMath.toRadians(la));
      const my = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
      return [mx, my] as const;
    };
    const heights = new Float32Array(n * n);
    const tiles = new Map<
      string,
      Awaited<ReturnType<typeof loadWithFallback>>
    >();
    // Gather the tiles this geographic tile touches first, then sample.
    const nw = toMerc(CMath.toDegrees(rect.west), CMath.toDegrees(rect.north));
    const se = toMerc(CMath.toDegrees(rect.east), CMath.toDegrees(rect.south));
    const tx0 = Math.floor(nw[0]);
    const ty0 = Math.floor(nw[1]);
    const tx1 = Math.min(world - 1, Math.floor(se[0] - 1e-9));
    const ty1 = Math.min(world - 1, Math.floor(se[1] - 1e-9));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 16) return heights; // only at very coarse levels near the poles
    await Promise.all(
      Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, (_, i) => {
        const tx = tx0 + (i % (tx1 - tx0 + 1));
        const ty = ty0 + Math.floor(i / (tx1 - tx0 + 1));
        return loadWithFallback(z, tx, ty).then((t) =>
          tiles.set(`${tx}/${ty}`, t),
        );
      }),
    );
    for (let r = 0; r < n; r++) {
      const lat = CMath.toDegrees(
        rect.north - ((rect.north - rect.south) * r) / (n - 1),
      );
      for (let c = 0; c < n; c++) {
        const lon = CMath.toDegrees(
          rect.west + ((rect.east - rect.west) * c) / (n - 1),
        );
        const [mx, my] = toMerc(lon, lat);
        // Clamp to the tiles gathered above: on the east and south edges mx/my can land
        // exactly on the next tile's boundary, which left a 0 m trench (a thin white seam).
        const tx = Math.max(tx0, Math.min(tx1, Math.floor(mx)));
        const ty = Math.max(ty0, Math.min(ty1, Math.floor(my)));
        const t = tiles.get(`${tx}/${ty}`);
        if (!t) continue;
        const scale = 2 ** (t.z - z); // < 1 when we fell back to a parent
        const fx = (mx * scale - t.x) * t.px.size;
        const fy = (my * scale - t.y) * t.px.size;
        heights[r * n + c] = heightAt(t.px, fx, fy);
      }
    }
    return heights;
  };
  const provider = new CustomHeightmapTerrainProvider({
    width: n,
    height: n,
    tilingScheme,
    callback: tileHeights,
  });
  return Object.assign(provider, { tileHeights, samples: n });
}

/**
 * The user's DEMs over a base terrain (VWR-GEO-03): inside a DEM's footprint its heights
 * win; elsewhere the base terrain shows, so the DEM joins the surrounding ground.
 */
export function createLayeredTerrain(
  base: LayerableTerrain | null,
  dems: DemSource[],
  samples = 65,
): LayerableTerrain {
  const n = base?.samples ?? samples;
  const tilingScheme = new GeographicTilingScheme();
  const tileHeights: TileHeights = async (x, y, level) => {
    const rect = tilingScheme.tileXYToRectangle(x, y, level);
    const out = base
      ? await base.tileHeights(x, y, level)
      : new Float32Array(n * n);
    for (const d of dems) {
      if (!Rectangle.intersection(rect, d.rectangle)) continue;
      const g = await d.heightGrid(rect, n);
      if (!g) continue;
      const lower = d.mode === "lower";
      for (let i = 0; i < out.length; i++) {
        const v = g[i]!;
        if (Number.isFinite(v) && (!lower || v < out[i]!)) out[i] = v;
      }
    }
    return out;
  };
  const provider = new CustomHeightmapTerrainProvider({
    width: n,
    height: n,
    tilingScheme,
    callback: tileHeights,
  });
  return Object.assign(provider, { tileHeights, samples: n });
}

/**
 * Any geographic-tiled terrain (such as an internal quantized-mesh server) as layerable
 * terrain, so DEMs and the ground cut can go over it. Each tile's heights are read from the
 * provider's own tile, or from its deepest available ancestor.
 */
export function asLayerable(provider: TerrainProvider, samples = 65): LayerableTerrain | null {
  if ("tileHeights" in provider) return provider as LayerableTerrain;
  if (!(provider.tilingScheme instanceof GeographicTilingScheme)) return null;
  const n = samples;
  const tilingScheme = new GeographicTilingScheme();
  const cache = new Map<string, Promise<TerrainData | undefined>>();
  const tile = (x: number, y: number, level: number) => {
    const key = `${level}/${x}/${y}`;
    let p = cache.get(key);
    if (!p) {
      p = Promise.resolve(provider.requestTileGeometry(x, y, level)).catch(() => undefined);
      cache.set(key, p);
      if (cache.size > 512) cache.delete(cache.keys().next().value!);
    }
    return p;
  };
  const available = (x: number, y: number, level: number) => {
    const a = provider.availability;
    return a ? a.isTileAvailable(level, x, y) : level <= 14;
  };
  const tileHeights: TileHeights = async (x, y, level) => {
    let tx = x, ty = y, tl = level;
    while (tl > 0 && !available(tx, ty, tl)) (tx >>= 1), (ty >>= 1), tl--;
    const data = await tile(tx, ty, tl);
    const out = new Float32Array(n * n);
    if (!data) return out;
    const src = tilingScheme.tileXYToRectangle(tx, ty, tl);
    const rect = tilingScheme.tileXYToRectangle(x, y, level);
    for (let r = 0; r < n; r++) {
      const lat = rect.north - ((rect.north - rect.south) * r) / (n - 1);
      for (let c = 0; c < n; c++) {
        const lon = rect.west + ((rect.east - rect.west) * c) / (n - 1);
        const h = data.interpolateHeight(src, lon, lat);
        out[r * n + c] = h ?? 0;
      }
    }
    return out;
  };
  const p = new CustomHeightmapTerrainProvider({ width: n, height: n, tilingScheme, callback: tileHeights });
  return Object.assign(p, { tileHeights, samples: n });
}
