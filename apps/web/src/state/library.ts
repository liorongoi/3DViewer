import { useMemo } from "react";
import { SAMPLE_LIBRARY, type ModelSummary } from "@viewer/shared";
import { listModels } from "../server/api";
import { useApp } from "./store";

/**
 * Everything the library shows: this session's uploads first, then the server's library,
 * or the bundled samples when no server answers.
 */
export function useLibrary(): ModelSummary[] {
  const uploads = useApp((s) => s.uploads);
  const server = useApp((s) => s.server);
  const serverModels = useApp((s) => s.serverModels);
  return useMemo(() => [...uploads, ...(server ? serverModels : SAMPLE_LIBRARY)], [uploads, server, serverModels]);
}

export function findModel(id: string): ModelSummary | undefined {
  const s = useApp.getState();
  return s.uploads.find((m) => m.id === id) ?? (s.server ? s.serverModels : SAMPLE_LIBRARY).find((m) => m.id === id);
}

/** Reloads the server's library. */
export async function refreshLibrary(): Promise<void> {
  const srv = useApp.getState().server;
  if (!srv) return;
  useApp.setState({ serverModels: await listModels(srv) });
}
