import {
  CesiumTerrainProvider,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  OpenStreetMapImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
  buildModuleUrl,
  type ImageryProvider,
  type TerrainProvider,
} from "cesium";
import type { BaseMapConfig, BaseMapSource } from "@viewer/shared";
import { signal } from "../signal";
import { readWmts } from "./ogc";
import { createTerrariumTerrain } from "./terrain";
import { wmtsProvider } from "./user-layers";

/**
 * Base map and terrain catalogue (plan WP 1.6, VWR-GEO-01). Online entries are for
 * development and demonstrations; on the internal network the admin points the same
 * kinds of source at internal servers (WP 3.9), so the code path is identical.
 */
export interface BaseMapDef {
  id: string;
  label: string;
  online: boolean;
  attribution: string;
  /** Set up by this site's administrator. */
  site?: boolean;
  /** Another base map drawn underneath, for sources that only cover some areas. */
  underlay?: string;
  create: () => Promise<ImageryProvider>;
}

export interface TerrainDef {
  id: string;
  label: string;
  online: boolean;
  attribution: string;
  site?: boolean;
  create: () => Promise<TerrainProvider>;
}

// Resolve against the page, keeping the {z}/{x}/{y} placeholders unescaped.
const rel = (p: string) => new URL(p, document.baseURI).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");

export const BASE_MAPS: BaseMapDef[] = [
  {
    id: "bundled",
    label: "Bundled world map (offline)",
    online: false,
    attribution: "Natural Earth II",
    create: () => TileMapServiceImageryProvider.fromUrl(buildModuleUrl("Assets/Textures/NaturalEarthII")),
  },
  {
    id: "local-s2",
    label: "Sentinel-2 demo areas (offline)",
    online: false,
    underlay: "bundled",
    attribution: "Contains modified Copernicus Sentinel data 2025",
    create: async () =>
      new UrlTemplateImageryProvider({
        url: rel("samples/imagery/s2/{z}/{x}/{y}.jpg"),
        tilingScheme: new WebMercatorTilingScheme(),
        maximumLevel: 16,
        credit: new Credit("Contains modified Copernicus Sentinel data 2025"),
      }),
  },
  {
    id: "esri",
    label: "Esri World Imagery (online)",
    online: true,
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    create: async () =>
      new UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 19,
        credit: new Credit("Esri, Maxar, Earthstar Geographics"),
      }),
  },
  {
    id: "s2cloudless",
    label: "Sentinel-2 cloudless 2016 (online)",
    online: true,
    attribution: "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (CC BY 4.0)",
    create: async () =>
      new UrlTemplateImageryProvider({
        url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
        maximumLevel: 15,
        credit: new Credit("Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)"),
      }),
  },
  {
    id: "osm",
    label: "OpenStreetMap (online)",
    online: true,
    attribution: "© OpenStreetMap contributors",
    create: async () => new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
  },
];

export const TERRAINS: TerrainDef[] = [
  { id: "none", label: "No terrain (ellipsoid)", online: false, attribution: "", create: async () => new EllipsoidTerrainProvider() },
  {
    id: "local",
    label: "Terrain, demo areas (offline)",
    online: false,
    attribution: "Terrain Tiles: SRTM, GMTED, ETOPO1 and others (AWS Open Data)",
    create: async () => createTerrariumTerrain({ url: rel("samples/terrain/{z}/{x}/{y}.png"), maxZoom: 14 }),
  },
  {
    id: "aws",
    label: "Terrain Tiles, world (online)",
    online: true,
    attribution: "Terrain Tiles: SRTM, GMTED, ETOPO1 and others (AWS Open Data)",
    create: async () => createTerrariumTerrain({ url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", maxZoom: 15 }),
  },
];

/** What the pickers offer: this site's sources first, then the built-in ones (WP 3.9). */
export const catalogue = signal<{ baseMaps: BaseMapDef[]; terrains: TerrainDef[] }>({ baseMaps: BASE_MAPS, terrains: TERRAINS });

const isCapabilities = (u: string) => /\.xml(\?|$)|request=getcapabilities/i.test(u);

/** One admin-configured imagery source. `base` resolves paths on the VIEWER server. */
export function siteBaseMap(s: BaseMapSource, base: string): BaseMapDef {
  const url = new URL(s.url, base.endsWith("/") ? base : `${base}/`).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  const credit = s.attribution ? new Credit(s.attribution) : undefined;
  const create = async (): Promise<ImageryProvider> => {
    if (s.type === "tms") return TileMapServiceImageryProvider.fromUrl(url, { maximumLevel: s.maxZoom, credit });
    if (s.type === "wmts") {
      if (isCapabilities(url)) {
        const layers = await readWmts(url);
        const l = layers.find((x) => x.id === s.layer && (!s.matrixSet || x.matrixSet === s.matrixSet)) ?? layers.find((x) => x.id === s.layer);
        if (!l) throw new Error(`The service has no layer "${s.layer}".`);
        return wmtsProvider(l);
      }
      return new WebMapTileServiceImageryProvider({
        url,
        layer: s.layer ?? "",
        style: s.style ?? "default",
        format: s.format ?? "image/jpeg",
        tileMatrixSetID: s.matrixSet ?? "GoogleMapsCompatible",
        tilingScheme: new WebMercatorTilingScheme(),
        maximumLevel: s.maxZoom,
        credit,
      });
    }
    return new UrlTemplateImageryProvider({ url, tilingScheme: new WebMercatorTilingScheme(), maximumLevel: s.maxZoom ?? 19, credit });
  };
  return { id: s.id, label: s.label, online: false, site: true, attribution: s.attribution ?? "", create };
}

export function siteTerrain(s: BaseMapSource, base: string): TerrainDef {
  const url = new URL(s.url, base.endsWith("/") ? base : `${base}/`).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  const create = async (): Promise<TerrainProvider> =>
    s.type === "quantized-mesh" ? CesiumTerrainProvider.fromUrl(url, { requestVertexNormals: true }) : createTerrariumTerrain({ url, maxZoom: s.maxZoom ?? 15 });
  return { id: s.id, label: s.label, online: false, site: true, attribution: s.attribution ?? "", create };
}

/** Puts this site's sources in the catalogue; with `hideOnline` the built-in internet ones go. */
export function applySiteConfig(cfg: BaseMapConfig, base: string): void {
  const keep = <T extends { online: boolean; id: string }>(list: T[], site: T[]) => [...site, ...list.filter((d) => !(cfg.hideOnline && d.online) && !site.some((x) => x.id === d.id))];
  catalogue.set({
    baseMaps: keep(BASE_MAPS, cfg.sources.filter((s) => s.kind === "imagery").map((s) => siteBaseMap(s, base))),
    terrains: keep(TERRAINS, cfg.sources.filter((s) => s.kind === "terrain").map((s) => siteTerrain(s, base))),
  });
}

/** The imagery layers for a base map, bottom first. */
export async function makeBaseLayers(id: string): Promise<ImageryLayer[]> {
  const list = catalogue.get().baseMaps;
  const def = list.find((b) => b.id === id) ?? list.find((b) => b.id === "bundled") ?? BASE_MAPS[0]!;
  const under = def.underlay ? await makeBaseLayers(def.underlay) : [];
  return [...under, new ImageryLayer(await def.create())];
}
