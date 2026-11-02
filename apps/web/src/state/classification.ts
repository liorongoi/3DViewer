import type { ClassificationLevel } from "@viewer/shared";
import { useApp } from "./store";

/** The levels the admin defined (from the server), or the prototype ones with no server. Lowest first. */
export function useLevels(): ClassificationLevel[] {
  return useApp((s) => s.levels);
}

/** A model's classification: the user's choice if any, otherwise the library value (UPL-10). */
export function useClassOf(): (m: { id: string; classificationId: string }) => ClassificationLevel {
  const overrides = useApp((s) => s.classOverrides);
  const levels = useLevels();
  return (m) => pick(levels, overrides[m.id] ?? m.classificationId);
}

/**
 * A level by id. An id the list does not have (a level the admin removed, a stale override)
 * shows the highest level, never the lowest, so a model is not under-marked.
 */
function pick(levels: ClassificationLevel[], id: string): ClassificationLevel {
  return levels.find((c) => c.id === id) ?? levels[levels.length - 1]!;
}

/** The globe, terrain and base map alone carry the lowest level. */
export function useLowestLevel(): ClassificationLevel {
  return useApp((s) => s.levels[0]!);
}
