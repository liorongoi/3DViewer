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
  placement?: { lat: number; lon: number; height: number; headingDeg?: number };
  thumbnail?: string;
  sizeBytes: number;
}
