export type UpdateStatus = "draft" | "inProduction" | "current" | "superseded";

export const UPDATE_STATUSES: UpdateStatus[] = ["draft", "inProduction", "current", "superseded"];

export type ModelFormat = "glb" | "gltf" | "fbx" | "3dtiles";

export interface ClassificationLevel {
  id: string;
  /** Label shown on the banner, already in the display language set by the admin. */
  label: string;
  /** Banner background colour. */
  color: string;
  /** Banner text colour, chosen by the admin for contrast. */
  textColor: string;
  order: number;
}

export interface ModelSource {
  kind: "glb" | "3dtiles";
  url: string;
  /**
   * How a georeferenced dataset meets the terrain (VWR-GEO-01):
   * "street" lifts or lowers it so its lowest surface (streets, ground) meets the terrain;
   * "none" trusts its own heights.
   */
  groundFit?: "street" | "surface" | "none";
  /** Cut the terrain away under the model's footprint, for meshes that carry their own ground. */
  clipTerrain?: boolean;
  /** The tileset is in local coordinates and is placed by the model's placement, like a GLB. */
  localFrame?: boolean;
  /** A GLB that carries its own Earth position (CESIUM_RTC or an Earth-centred node); it has no placement. */
  georeferenced?: boolean;
  /** Licence and origin, shown in Properties. */
  attribution?: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  project: string;
  operation: string;
  responsibleEntity: string;
  description: string;
  status: UpdateStatus;
  statusChangedAt: string;
  classificationId: string;
  version: number;
  versions: number;
  sourceFormat: ModelFormat;
  source: ModelSource;
  /** Footprint centre for the globe view. */
  centre: { lat: number; lon: number };
  /** Optional georeference for models that carry none (e.g. plain GLB samples). */
  placement?: {
    lat: number;
    lon: number;
    /** Ellipsoidal height in metres, used when there is no terrain or no aboveGround. */
    height: number;
    /** When set and terrain is on, the model base sits this many metres above the terrain. */
    aboveGround?: number;
    headingDeg?: number;
    scale?: number;
    /** The file's up axis. glTF is y-up; many CAD and FBX exports are z-up and would lie on their side. */
    upAxis?: "y" | "z";
    /**
     * The position as entered in a projected grid (ITM, UTM…). Grid north and grid scale are
     * already folded into headingDeg and scale; these are kept to show what was entered.
     */
    grid?: { epsg: number; x: number; y: number; northDeg: number; groundPerGrid: number };
    /**
     * Set when the file has no reliable scale (MSR-06): one of the file's units is drawn this many
     * metres long, and measurements are shown in model units, not metres.
     */
    modelUnit?: number;
  };
  thumbnail?: string;
  sizeBytes: number;
}

/**
 * How a producer arranged a model's layers (UPL-09, WP 2.1 / 4.3): renamed, merged, nested
 * and ordered. Each layer names the glTF nodes it stands for; a node stands for its whole
 * subtree, except the parts the manifest puts somewhere else.
 */
export interface LayerManifest {
  layers: ManifestLayer[];
}
export interface ManifestLayer {
  name: string;
  nodes?: number[];
  children?: ManifestLayer[];
}

/** A base map or terrain source the admin configured for this site (WP 3.9, RND-11). */
export interface BaseMapSource {
  id: string;
  label: string;
  /** Imagery draped on the globe, or terrain under it. */
  kind: "imagery" | "terrain";
  /** xyz, tms or wmts for imagery; terrarium (PNG heights) or quantized-mesh for terrain. */
  type: "xyz" | "tms" | "wmts" | "terrarium" | "quantized-mesh";
  /**
   * xyz and terrarium: a template with {z}, {x} and {y}. tms and quantized-mesh: the service root.
   * wmts: a GetCapabilities address, or the service address with layer, style, matrixSet and format.
   * A path without a scheme is on the VIEWER server.
   */
  url: string;
  layer?: string;
  style?: string;
  matrixSet?: string;
  format?: string;
  maxZoom?: number;
  attribution?: string;
}

export interface BaseMapConfig {
  sources: BaseMapSource[];
  /** What the viewer opens with: an id from `sources` or from the built-in list. */
  defaultImagery?: string;
  defaultTerrain?: string;
  /** Hide the built-in internet sources, for the internal network. */
  hideOnline?: boolean;
}
