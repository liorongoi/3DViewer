import { useMemo } from "react";
import { SAMPLE_LIBRARY, type ModelSummary } from "@viewer/shared";
import { useApp } from "./store";

/** Everything the library shows: this session's uploads first, then the sample library. */
export function useLibrary(): ModelSummary[] {
  const uploads = useApp((s) => s.uploads);
  return useMemo(() => [...uploads, ...SAMPLE_LIBRARY], [uploads]);
}

export function findModel(id: string): ModelSummary | undefined {
  return useApp.getState().uploads.find((m) => m.id === id) ?? SAMPLE_LIBRARY.find((m) => m.id === id);
}
