import {
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  OpenStreetMapImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
  buildModuleUrl,
  type ImageryProvider,
  type TerrainProvider,
} from "cesium";
import { createTerrariumTerrain } from "./terrain";

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
  /** Another base map drawn underneath, for sources that only cover some areas. */
  underlay?: string;
  create: () => Promise<ImageryProvider>;
}

export interface TerrainDef {
  id: string;
  label: string;
  online: boolean;
  attribution: string;
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

/** The imagery layers for a base map, bottom first. */
export async function makeBaseLayers(id: string): Promise<ImageryLayer[]> {
  const def = BASE_MAPS.find((b) => b.id === id) ?? BASE_MAPS[0]!;
  const under = def.underlay ? await makeBaseLayers(def.underlay) : [];
  return [...under, new ImageryLayer(await def.create())];
}
