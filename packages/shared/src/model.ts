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
  };
  thumbnail?: string;
  sizeBytes: number;
}
