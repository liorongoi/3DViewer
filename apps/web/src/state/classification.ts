import type { ClassificationLevel } from "@viewer/shared";
import { useApp } from "./store";

/** The levels the admin defined (from the server), or the prototype ones with no server. Lowest first. */
export function useLevels(): ClassificationLevel[] {
  return useApp((s) => s.levels);
}

/** A model's classification (UPL-10): see classificationIdOf. */
export function useClassOf(): (m: { id: string; classificationId: string }) => ClassificationLevel {
  const overrides = useApp((s) => s.classOverrides);
  const server = useApp((s) => !!s.server);
  const levels = useLevels();
  return (m) => pick(levels, classificationIdOf(m, overrides, server));
}

/**
 * The library's classification for a server model, which only the library changes, so a choice
 * kept on one workstation never marks it differently there. Samples and this session's uploads
 * have no library: the choice made on this workstation, if any.
 */
export function classificationIdOf(m: { id: string; classificationId: string }, overrides: Record<string, string>, server: boolean): string {
  return (server && !m.id.startsWith("upload-") ? undefined : overrides[m.id]) ?? m.classificationId;
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
