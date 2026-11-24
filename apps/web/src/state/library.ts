import { useMemo } from "react";
import { SAMPLE_LIBRARY, type ModelSummary } from "@viewer/shared";
import { listModels } from "../server/api";
import { useApp } from "./store";

/**
 * Everything the library shows: the models opened from this computer first (kept from earlier
 * starts in the Windows app), then the server's library, or the bundled samples when no server
 * answers. The Windows app has no samples: without a server it shows only the user's own models.
 */
export function useLibrary(): ModelSummary[] {
  const uploads = useApp((s) => s.uploads);
  const server = useApp((s) => s.server);
  const serverModels = useApp((s) => s.serverModels);
  const samples = useApp((s) => s.samples);
  return useMemo(() => [...uploads, ...(server ? serverModels : samples ? SAMPLE_LIBRARY : [])], [uploads, server, serverModels, samples]);
}

export function findModel(id: string): ModelSummary | undefined {
  const s = useApp.getState();
  return s.uploads.find((m) => m.id === id) ?? (s.server ? s.serverModels : s.samples ? SAMPLE_LIBRARY : []).find((m) => m.id === id);
}

/** Reloads the server's library. */
export async function refreshLibrary(): Promise<void> {
  const srv = useApp.getState().server;
  if (!srv) return;
  useApp.setState({ serverModels: await listModels(srv) });
}

/** A model the user can delete: one opened from this computer, or any model on the server. The bundled samples stay. */
export function canDelete(m: ModelSummary, server: boolean): boolean {
  return m.id.startsWith("upload-") || server;
}
