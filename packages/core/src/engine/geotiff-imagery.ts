import { fromBlob, fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { Credit, Event, GeographicTilingScheme, Math as CMath, Rectangle, type ImageryProvider } from "cesium";
import { converterForEpsg, type CrsConverter } from "../geo/crs";

/**
 * GeoTIFF / Cloud Optimised GeoTIFF as a tiled imagery layer (plan WP 1.9, VWR-DAT-01).
 *
 * Each Cesium tile reads only the window it needs, from the overview whose resolution
 * fits the tile, so a 1 GB orthophoto opens in a second and a COG on a web server is read
 * with range requests. Pixels are warped from the file's coordinate system to the globe
 * on the fly (UTM, ITM, Lambert-93, Web Mercator, geographic and others in geo/crs.ts).
 */

const TILE = 256;
const GRID = 17; // control points per tile edge; coordinates in between are interpolated

interface Level {
  image: GeoTIFFImage;
  /** Full-resolution pixels per pixel of this level. */
  scale: number;
}

export interface GeoTiffInfo {
  width: number;
  height: number;
  bands: number;
  bits: number;
  crs: string;
  /** Ground size of one pixel in the file's units. */
  resolution: number;
  /** West, south, east, north in degrees. */
  bounds: [number, number, number, number];
}

type Stretch = { min: number; max: number }[];

export class GeoTiffImageryProvider {
  readonly tileWidth = TILE;
  readonly tileHeight = TILE;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle: Rectangle;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  readonly info: GeoTiffInfo;

  private constructor(
    private readonly levels: Level[],
    private readonly crs: CrsConverter,
    private readonly origin: [number, number],
    private readonly res: [number, number],
    private readonly bandsUsed: number[],
    private readonly stretch: Stretch | null,
    private readonly noData: number | null,
    info: GeoTiffInfo,
    name: string,
  ) {
    this.info = info;
    const [w, s, e, n] = info.bounds;
    this.rectangle = Rectangle.fromDegrees(w, s, e, n);
    const resDeg = crs.label === "EPSG:4326" ? Math.abs(res[0]) : Math.abs(res[0]) / 111320;
    this.maximumLevel = Math.max(1, Math.min(22, Math.ceil(Math.log2(180 / (TILE * resDeg))) + 1));
    this.credit = new Credit(name);
  }

  static async fromFile(file: Blob, name: string): Promise<GeoTiffImageryProvider> {
    return GeoTiffImageryProvider.open(await fromBlob(file), name);
  }

  static async fromUrl(url: string, name: string): Promise<GeoTiffImageryProvider> {
    return GeoTiffImageryProvider.open(await fromUrl(url), name);
  }

  private static async open(tiff: GeoTIFF, name: string): Promise<GeoTiffImageryProvider> {
    const main = await tiff.getImage(0);
    const keys = (main.getGeoKeys() ?? {}) as Record<string, number | undefined>;
    const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
    if (!epsg || epsg === 32767) throw new Error("This GeoTIFF has no EPSG code in its geo keys, so the viewer cannot place it.");
    const crs = converterForEpsg(epsg);
    const width = main.getWidth();
    const height = main.getHeight();
    const bands = main.getSamplesPerPixel();
    const bits = main.getBitsPerSample();
    const origin = main.getOrigin() as [number, number];
    const res = main.getResolution() as [number, number];

    // Overviews: same band count, smaller size. Mask images (one band) are skipped.
    const count = await tiff.getImageCount();
    const levels: Level[] = [{ image: main, scale: 1 }];
    for (let i = 1; i < count; i++) {
      const im = await tiff.getImage(i);
      if (im.getSamplesPerPixel() === bands && im.getWidth() < width) levels.push({ image: im, scale: width / im.getWidth() });
    }
    levels.sort((a, b) => a.scale - b.scale);

    // Footprint on the globe: walk the image edges.
    const [x0, y0, x1, y1] = main.getBoundingBox() as [number, number, number, number];
    let w = 180,
      s = 90,
      e = -180,
      n = -90;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      for (const [x, y] of [
        [x0 + (x1 - x0) * t, y0],
        [x0 + (x1 - x0) * t, y1],
        [x0, y0 + (y1 - y0) * t],
        [x1, y0 + (y1 - y0) * t],
      ] as const) {
        const [lon, lat] = crs.toLonLat(x, y);
        w = Math.min(w, lon);
        e = Math.max(e, lon);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
    }

    // Colour: 8-bit RGB(A) is shown as is; anything else is stretched from the smallest overview.
    const rgb = bands >= 3;
    const bandsUsed = rgb ? [0, 1, 2] : [0];
    const nd = main.getGDALNoData();
    let stretch: Stretch | null = null;
    if (bits !== 8 || !rgb) {
      const small = levels[levels.length - 1]!.image;
      const data = (await small.readRasters({ samples: bandsUsed, interleave: false })) as unknown as ArrayLike<number>[];
      stretch = data.map((band) => {
        const v: number[] = [];
        for (let i = 0; i < band.length; i += 1) {
          const x = band[i]!;
          if (Number.isFinite(x) && x !== nd && !(nd === null && x === 0 && bits !== 8)) v.push(x);
        }
        v.sort((a, b) => a - b);
        return { min: v[Math.floor(v.length * 0.02)] ?? 0, max: v[Math.floor(v.length * 0.98)] ?? 1 };
      });
      if (rgb && stretch.length === 3) {
        // One stretch for all three bands keeps the colour balance.
        const min = Math.min(...stretch.map((x) => x.min));
        const max = Math.max(...stretch.map((x) => x.max));
        stretch = stretch.map(() => ({ min, max }));
      }
    }

    const info: GeoTiffInfo = { width, height, bands, bits, crs: crs.label, resolution: Math.abs(res[0]), bounds: [w, s, e, n] };
    return new GeoTiffImageryProvider(levels, crs, origin, res, bandsUsed, stretch, nd, info, name);
  }

  getTileCredits(): Credit[] {
    return [];
  }

  pickFeatures(): undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = TILE;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    if (!Rectangle.intersection(rect, this.rectangle)) return canvas;

    // Control grid: tile lon/lat -> full-resolution pixel coordinates.
    const gx = new Float64Array(GRID * GRID);
    const gy = new Float64Array(GRID * GRID);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let r = 0; r < GRID; r++) {
      const lat = CMath.toDegrees(rect.north - ((rect.north - rect.south) * r) / (GRID - 1));
      for (let c = 0; c < GRID; c++) {
        const lon = CMath.toDegrees(rect.west + ((rect.east - rect.west) * c) / (GRID - 1));
        const [sx, sy] = this.crs.fromLonLat(lon, lat);
        const px = (sx - this.origin[0]) / this.res[0];
        const py = (sy - this.origin[1]) / this.res[1];
        gx[r * GRID + c] = px;
        gy[r * GRID + c] = py;
        if (Number.isFinite(px) && Number.isFinite(py)) {
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
      }
    }
    const W = this.info.width;
    const H = this.info.height;
    const wx0 = Math.max(0, Math.floor(minX));
    const wy0 = Math.max(0, Math.floor(minY));
    const wx1 = Math.min(W, Math.ceil(maxX) + 1);
    const wy1 = Math.min(H, Math.ceil(maxY) + 1);
    if (wx1 <= wx0 || wy1 <= wy0) return canvas;

    // Pick the coarsest level that still gives about one source pixel per output pixel.
    const want = Math.max(maxX - minX, maxY - minY) / TILE;
    let lv = this.levels[0]!;
    for (const l of this.levels) if (l.scale <= want * 1.2) lv = l;
    const s = lv.scale;
    const lw = lv.image.getWidth();
    const lh = lv.image.getHeight();
    const lx0 = Math.max(0, Math.floor(wx0 / s));
    const ly0 = Math.max(0, Math.floor(wy0 / s));
    const lx1 = Math.min(lw, Math.ceil(wx1 / s));
    const ly1 = Math.min(lh, Math.ceil(wy1 / s));
    if (lx1 <= lx0 || ly1 <= ly0) return canvas;
    const bands = (await lv.image.readRasters({ window: [lx0, ly0, lx1, ly1], samples: this.bandsUsed, interleave: false })) as unknown as ArrayLike<number>[];
    const bw = lx1 - lx0;
    const bh = ly1 - ly0;

    const ctx = canvas.getContext("2d")!;
    const out = ctx.createImageData(TILE, TILE);
    const px = out.data;
    const cell = (TILE - 1) / (GRID - 1);
    const nd = this.noData;
    const st = this.stretch;
    const v = (b: number, i: number) => {
      const raw = bands[b]![i]!;
      if (!st) return raw;
      const { min, max } = st[b]!;
      return ((raw - min) / (max - min || 1)) * 255;
    };
    for (let oy = 0; oy < TILE; oy++) {
      const fy = oy / cell;
      const r0 = Math.min(GRID - 2, Math.floor(fy));
      const ty = fy - r0;
      for (let ox = 0; ox < TILE; ox++) {
        const fx = ox / cell;
        const c0 = Math.min(GRID - 2, Math.floor(fx));
        const tx = fx - c0;
        const i00 = r0 * GRID + c0;
        const sx =
          (gx[i00]! * (1 - tx) + gx[i00 + 1]! * tx) * (1 - ty) + (gx[i00 + GRID]! * (1 - tx) + gx[i00 + GRID + 1]! * tx) * ty;
        const sy =
          (gy[i00]! * (1 - tx) + gy[i00 + 1]! * tx) * (1 - ty) + (gy[i00 + GRID]! * (1 - tx) + gy[i00 + GRID + 1]! * tx) * ty;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const bx = Math.floor(sx / s) - lx0;
        const by = Math.floor(sy / s) - ly0;
        if (bx < 0 || by < 0 || bx >= bw || by >= bh) continue;
        const i = by * bw + bx;
        const o = (oy * TILE + ox) * 4;
        const raw0 = bands[0]![i]!;
        if ((nd !== null && raw0 === nd) || Number.isNaN(raw0)) continue;
        if (this.bandsUsed.length === 3) {
          const r = v(0, i),
            g = v(1, i),
            b = v(2, i);
          if (r === 0 && g === 0 && b === 0 && nd === null) continue; // common black collar
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
        } else {
          px[o] = px[o + 1] = px[o + 2] = v(0, i);
        }
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  /** Cesium's ImageryLayer takes any object with the ImageryProvider shape. */
  asProvider(): ImageryProvider {
    return this as unknown as ImageryProvider;
  }
}
