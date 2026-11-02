/// <reference path="../types/shpjs.d.ts" />
import type * as GeoJSON from "geojson";
import {
  Color,
  ConstantProperty,
  DistanceDisplayCondition,
  GeoJsonDataSource,
  GeographicTilingScheme,
  HeightReference,
  ImageryLayer,
  KmlDataSource,
  LabelStyle,
  NearFarScalar,
  Cartesian2,
  Rectangle,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  WebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
  type CesiumWidget,
  type DataSource,
} from "cesium";
import shp from "shpjs";
import { signal } from "../signal";
import { GeoTiffImageryProvider } from "./geotiff-imagery";
import { readWms, readWmts, type WmtsLayerInfo } from "./ogc";

/**
 * The user's own data on the map (plan WP 1.9, VWR-DAT-01): shapefiles, GeoJSON, KML,
 * GeoTIFF / COG imagery, WMTS, WMS and XYZ services. Vectors are draped on the terrain;
 * imagery can sit over the base map or replace it ("use as base map").
 */

export type UserLayerSource = "shapefile" | "geojson" | "kml" | "geotiff" | "wmts" | "wms" | "xyz";

export interface UserLayer {
  id: string;
  name: string;
  source: UserLayerSource;
  kind: "vector" | "imagery";
  visible: boolean;
  /** 0–1. */
  opacity: number;
  /** Imagery shown instead of the built-in base map. */
  asBase: boolean;
  /** Short facts for the list: feature count, CRS, size. */
  info: string;
  color: string;
  bounds?: [number, number, number, number];
}

const PALETTE = ["#FFB547", "#5AC8FA", "#F05BDC", "#7BE495", "#FF7A59", "#B49CFF"];

type Handle = { ds?: DataSource; layer?: ImageryLayer };

export class UserLayers {
  readonly list = signal<UserLayer[]>([]);
  private handles = new Map<string, Handle>();
  private seq = 0;

  constructor(
    private readonly widget: CesiumWidget,
    /** Hide or show the built-in base map when a user layer becomes the base. */
    private readonly setBuiltInBase: (shown: boolean) => void,
  ) {}

  // ---------- adding ----------

  /**
   * Files from a picker or a drop. Shapefile parts (.shp .dbf .prj .cpg .shx) are grouped by
   * name, so dropping the four files of one layer adds one layer.
   */
  async addFiles(files: File[]): Promise<{ added: number; errors: string[] }> {
    const errors: string[] = [];
    let added = 0;
    const groups = new Map<string, Record<string, File>>();
    for (const f of files) {
      const m = /^(.*)\.([^.]+)$/.exec(f.name);
      const base = m ? m[1]! : f.name;
      const ext = (m ? m[2]! : "").toLowerCase();
      if (["shp", "dbf", "prj", "cpg", "shx"].includes(ext)) {
        const g = groups.get(base) ?? {};
        g[ext] = f;
        groups.set(base, g);
        continue;
      }
      try {
        if (ext === "zip") await this.addShapefileZip(f);
        else if (ext === "geojson" || ext === "json") await this.addGeoJson(JSON.parse(await f.text()), base, "geojson");
        else if (ext === "kml" || ext === "kmz") await this.addKml(f, base);
        else if (ext === "tif" || ext === "tiff") await this.addGeoTiff(f, base);
        else throw new Error(`${f.name}: this file type is not supported here. Use .shp, .zip, .geojson, .kml, .kmz or .tif.`);
        added++;
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const [name, g] of groups) {
      try {
        if (!g.shp) throw new Error("the .shp file is missing (select the .shp, .dbf and .prj together)");
        const geo = await shp({
          shp: await g.shp.arrayBuffer(),
          dbf: g.dbf ? await g.dbf.arrayBuffer() : undefined,
          prj: g.prj ? await g.prj.text() : undefined,
          cpg: g.cpg ? await g.cpg.text() : undefined,
        } as never);
        const crs = g.prj ? prjName(await g.prj.text()) : "no .prj, assumed WGS 84";
        await this.addGeoJson(geo as GeoJSON.FeatureCollection, name, "shapefile", crs);
        added++;
      } catch (e) {
        errors.push(`${name}.shp: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { added, errors };
  }

  async addShapefileZip(f: File): Promise<void> {
    const out = (await shp(await f.arrayBuffer())) as GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[];
    const list = Array.isArray(out) ? out : [out];
    for (const fc of list) {
      const name = (fc as { fileName?: string }).fileName ?? f.name.replace(/\.zip$/i, "");
      await this.addGeoJson(fc, name.split("/").pop()!, "shapefile");
    }
  }

  async addGeoJson(geo: GeoJSON.GeoJSON, name: string, source: UserLayerSource, crs?: string): Promise<UserLayer> {
    const color = PALETTE[this.seq % PALETTE.length]!;
    const c = Color.fromCssColorString(color);
    const ds = await GeoJsonDataSource.load(geo as object, {
      clampToGround: true,
      stroke: c,
      strokeWidth: 2.5,
      fill: c.withAlpha(0.22),
      markerColor: c,
    });
    ds.name = name;
    const count = styleVectors(ds, c);
    await this.widget.dataSources.add(ds);
    const bounds = geoBounds(geo);
    return this.push(
      { name, source, kind: "vector", color, bounds, info: `${count.toLocaleString()} features${crs ? ` · ${crs}` : ""}` },
      { ds },
    );
  }

  async addKml(f: File, name: string): Promise<void> {
    const ds = await KmlDataSource.load(f, { clampToGround: true, canvas: document.createElement("canvas"), camera: this.widget.camera });
    await this.widget.dataSources.add(ds);
    this.push({ name, source: "kml", kind: "vector", color: "#FFFFFF", info: `${ds.entities.values.length.toLocaleString()} features` }, { ds });
  }

  async addGeoTiff(f: File | string, name: string): Promise<UserLayer> {
    const p = typeof f === "string" ? await GeoTiffImageryProvider.fromUrl(f, name) : await GeoTiffImageryProvider.fromFile(f, name);
    const i = p.info;
    const layer = this.widget.imageryLayers.addImageryProvider(p.asProvider());
    return this.push(
      {
        name,
        source: "geotiff",
        kind: "imagery",
        color: "#FFFFFF",
        bounds: i.bounds,
        info: `${i.width.toLocaleString()} × ${i.height.toLocaleString()} px · ${i.bands} band${i.bands > 1 ? "s" : ""} · ${fmtRes(i.resolution, i.crs)} · ${i.crs}`,
      },
      { layer },
    );
  }

  /** Layers a WMTS offers, for the picker. */
  listWmts(url: string): Promise<WmtsLayerInfo[]> {
    return readWmts(url);
  }

  addWmts(l: WmtsLayerInfo): UserLayer {
    if (l.crs === "other") throw new Error(`The tile matrix set "${l.matrixSet}" is not Web Mercator or WGS 84, which the viewer needs.`);
    const provider = new WebMapTileServiceImageryProvider({
      url: l.template ?? l.kvpUrl,
      layer: l.id,
      style: l.style,
      format: l.format,
      tileMatrixSetID: l.matrixSet,
      tileMatrixLabels: l.matrixLabels.length ? l.matrixLabels : undefined,
      tilingScheme: l.crs === "3857" ? new WebMercatorTilingScheme() : new GeographicTilingScheme(),
      maximumLevel: l.matrixLabels.length ? l.matrixLabels.length - 1 : undefined,
      rectangle: l.bounds ? Rectangle.fromDegrees(...l.bounds) : undefined,
    });
    const layer = this.widget.imageryLayers.addImageryProvider(provider);
    return this.push({ name: l.title, source: "wmts", kind: "imagery", color: "#FFFFFF", bounds: l.bounds, info: `WMTS · ${l.matrixSet}` }, { layer });
  }

  listWms(url: string) {
    return readWms(url);
  }

  addWms(url: string, layerName: string, title: string, bounds?: [number, number, number, number]): UserLayer {
    const provider = new WebMapServiceImageryProvider({
      url,
      layers: layerName,
      parameters: { transparent: true, format: "image/png" },
      rectangle: bounds ? Rectangle.fromDegrees(...bounds) : undefined,
    });
    const layer = this.widget.imageryLayers.addImageryProvider(provider);
    return this.push({ name: title, source: "wms", kind: "imagery", color: "#FFFFFF", bounds, info: `WMS · ${layerName}` }, { layer });
  }

  addXyz(template: string, name = "Tile service"): UserLayer {
    if (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{(y|reverseY)\}/.test(template)) throw new Error("The address needs {z}, {x} and {y}.");
    const layer = this.widget.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: template, tilingScheme: new WebMercatorTilingScheme(), maximumLevel: 20 }));
    return this.push({ name, source: "xyz", kind: "imagery", color: "#FFFFFF", info: "XYZ tiles" }, { layer });
  }

  // ---------- editing ----------

  setVisible(id: string, visible: boolean): void {
    const h = this.handles.get(id);
    if (h?.ds) h.ds.show = visible;
    if (h?.layer) h.layer.show = visible;
    this.patch(id, { visible });
  }

  setOpacity(id: string, opacity: number): void {
    const h = this.handles.get(id);
    if (h?.layer) h.layer.alpha = opacity;
    if (h?.ds) for (const e of h.ds.entities.values) fade(e, opacity);
    this.patch(id, { opacity });
  }

  /** Make an imagery layer the base map (the built-in one is hidden), or put it back on top. */
  setAsBase(id: string, on: boolean): void {
    const coll = this.widget.imageryLayers;
    for (const l of this.list.get()) {
      const h = this.handles.get(l.id);
      if (!h?.layer || l.kind !== "imagery") continue;
      if (l.id === id) {
        if (on) coll.lowerToBottom(h.layer);
        else coll.raiseToTop(h.layer);
      } else if (on && l.asBase) {
        coll.raiseToTop(h.layer);
      }
    }
    this.list.set(this.list.get().map((l) => ({ ...l, asBase: l.id === id ? on : on ? false : l.asBase })));
    this.setBuiltInBase(!this.list.get().some((l) => l.asBase));
  }

  /** Move a layer up (towards the top of the drawing order) or down. */
  move(id: string, dir: 1 | -1): void {
    const h = this.handles.get(id);
    if (h?.layer) {
      if (dir > 0) this.widget.imageryLayers.raise(h.layer);
      else this.widget.imageryLayers.lower(h.layer);
    }
    if (h?.ds) {
      if (dir > 0) this.widget.dataSources.raise(h.ds);
      else this.widget.dataSources.lower(h.ds);
    }
    const list = [...this.list.get()];
    const i = list.findIndex((l) => l.id === id);
    const j = i - dir; // the list shows the top layer first
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    this.list.set(list);
  }

  remove(id: string): void {
    const h = this.handles.get(id);
    const wasBase = this.list.get().find((l) => l.id === id)?.asBase;
    if (h?.ds) this.widget.dataSources.remove(h.ds, true);
    if (h?.layer) this.widget.imageryLayers.remove(h.layer, true);
    this.handles.delete(id);
    this.list.set(this.list.get().filter((l) => l.id !== id));
    if (wasBase) this.setBuiltInBase(true);
  }

  zoomTo(id: string): void {
    const l = this.list.get().find((x) => x.id === id);
    const h = this.handles.get(id);
    if (l?.bounds) {
      const [w, s, e, n] = l.bounds;
      const pad = Math.max(e - w, n - s) * 0.08 || 0.01;
      void this.widget.camera.flyTo({ destination: Rectangle.fromDegrees(w - pad, s - pad, e + pad, n + pad), duration: 1.4 });
    } else if (h?.ds) {
      void this.widget.flyTo(h.ds, { duration: 1.4 });
    }
  }

  private push(p: Omit<UserLayer, "id" | "visible" | "opacity" | "asBase">, h: Handle): UserLayer {
    const layer: UserLayer = { ...p, id: `user-${++this.seq}`, visible: true, opacity: 1, asBase: false };
    this.handles.set(layer.id, h);
    this.list.set([layer, ...this.list.get()]);
    this.widget.scene.requestRender();
    return layer;
  }

  private patch(id: string, p: Partial<UserLayer>): void {
    this.list.set(this.list.get().map((l) => (l.id === id ? { ...l, ...p } : l)));
    this.widget.scene.requestRender();
  }
}

/** Points become dots with a name label; lines and polygons keep the layer colour. */
function styleVectors(ds: DataSource, c: Color): number {
  const entities = ds.entities.values;
  const many = entities.length > 400;
  for (const e of entities) {
    if (!e.billboard) continue;
    const props = e.properties?.getValue(undefined) as Record<string, unknown> | undefined;
    const name = props && (props.name ?? props.NAME ?? props.Name ?? props.nameascii ?? props.NAMEASCII ?? props.title);
    e.billboard = undefined;
    e.point = {
      pixelSize: new ConstantProperty(7),
      color: new ConstantProperty(c),
      outlineColor: new ConstantProperty(Color.BLACK.withAlpha(0.7)),
      outlineWidth: new ConstantProperty(1.5),
      heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND),
      disableDepthTestDistance: new ConstantProperty(Number.POSITIVE_INFINITY),
    } as never;
    if (name) {
      e.label = {
        text: new ConstantProperty(String(name)),
        font: new ConstantProperty("500 12px 'IBM Plex Sans', sans-serif"),
        fillColor: new ConstantProperty(Color.WHITE),
        outlineColor: new ConstantProperty(Color.BLACK),
        outlineWidth: new ConstantProperty(3),
        style: new ConstantProperty(LabelStyle.FILL_AND_OUTLINE),
        pixelOffset: new ConstantProperty(new Cartesian2(0, -10)),
        verticalOrigin: new ConstantProperty(VerticalOrigin.BOTTOM),
        heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND),
        disableDepthTestDistance: new ConstantProperty(Number.POSITIVE_INFINITY),
        // Large point layers only label what is near, so the map stays readable.
        distanceDisplayCondition: new ConstantProperty(new DistanceDisplayCondition(0, many ? 250_000 : 2_000_000)),
        translucencyByDistance: new ConstantProperty(new NearFarScalar(50_000, 1, many ? 250_000 : 2_000_000, 0)),
      } as never;
    }
  }
  return entities.length;
}

function fade(e: import("cesium").Entity, a: number): void {
  const set = (p: { material?: unknown } | undefined, base: number) => {
    const m = p?.material as { color?: ConstantProperty } | undefined;
    const col = m?.color?.getValue(undefined) as Color | undefined;
    if (col && m?.color) m.color.setValue(col.withAlpha(base * a));
  };
  set(e.polygon as never, 0.22);
  set(e.polyline as never, 1);
  if (e.point) e.point.color = new ConstantProperty((e.point.color?.getValue(undefined) as Color).withAlpha(a));
  if (e.label) e.label.show = new ConstantProperty(a > 0.05);
}

function geoBounds(geo: GeoJSON.GeoJSON): [number, number, number, number] | undefined {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        w = Math.min(w, x!);
        e = Math.max(e, x!);
        s = Math.min(s, y!);
        n = Math.max(n, y!);
      }
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  const walk = (g: GeoJSON.GeoJSON | null): void => {
    if (!g) return;
    if (g.type === "FeatureCollection") g.features.forEach(walk);
    else if (g.type === "Feature") walk(g.geometry);
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    else visit((g as { coordinates: unknown }).coordinates);
  };
  walk(geo);
  return Number.isFinite(w) ? [w, s, e, n] : undefined;
}

function prjName(wkt: string): string {
  const m = /^\s*\w+\["([^"]+)"/.exec(wkt);
  return m ? m[1]!.replace(/_/g, " ") : "custom CRS";
}

function fmtRes(r: number, crs: string): string {
  if (crs === "EPSG:4326") return `${(r * 3600).toFixed(2)}″ / px`;
  return r >= 1 ? `${r.toFixed(r < 10 ? 1 : 0)} m / px` : `${(r * 100).toFixed(0)} cm / px`;
}
