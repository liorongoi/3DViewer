import type { TFunction } from "i18next";
import { groupByStandard, toManifest, type EditLayer, type ViewerEngine } from "@viewer/core";
import type { LayerManifest } from "@viewer/shared";
import { putLayerManifest, type ServerInfo } from "./server/api";
import { suggestLayer } from "./upload/read-drop";

/** The standard layer names (UPL-09), as suggestLayer gives them; shown and saved in the interface language. */
export const STANDARD_LAYERS = ["Terrain", "Buildings", "Infrastructure", "Vegetation", "Water", "Other"] as const;

/** The layers gathered under the standard names in the interface language. */
export function standardGroups(tree: EditLayer[], t: TFunction): EditLayer[] {
  return groupByStandard(tree, (n) => t(`layerEditor.standard.${suggestLayer(n)}`), STANDARD_LAYERS.map((s) => t(`layerEditor.standard.${s}`)));
}

/**
 * Once a model just published is open and its layers are known, saves them gathered under the
 * standard names (the upload wizard's Layers step), and shows them so. Gives up after two
 * minutes, or when another model is opened; the producer can still arrange them later.
 */
export async function arrangeWhenOpen(engine: ViewerEngine, srv: ServerInfo, modelId: string, t: TFunction): Promise<LayerManifest | null> {
  for (let i = 0; i < 480; i++) {
    const m = engine.current.get();
    if (i > 8 && m?.id !== modelId) return null;
    if (m?.id === modelId && !engine.loading.get() && engine.layers.get().length) {
      const manifest = toManifest(standardGroups(engine.editableLayers(), t));
      if (!manifest.layers.length) return null;
      await putLayerManifest(srv, modelId, manifest);
      if (engine.current.get() === m) engine.setLayerManifest(manifest);
      return manifest;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
