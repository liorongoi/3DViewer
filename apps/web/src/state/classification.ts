import { SAMPLE_CLASSIFICATIONS, type ClassificationLevel } from "@viewer/shared";
import { useApp } from "./store";

/** A model's classification: the user's choice if any, otherwise the library value (UPL-10). */
export function useClassOf(): (m: { id: string; classificationId: string }) => ClassificationLevel {
  const overrides = useApp((s) => s.classOverrides);
  return (m) => level(overrides[m.id] ?? m.classificationId);
}

export function level(id: string): ClassificationLevel {
  return SAMPLE_CLASSIFICATIONS.find((c) => c.id === id) ?? SAMPLE_CLASSIFICATIONS[0]!;
}

/** The globe, terrain and base map alone are unclassified. */
export const UNCLASSIFIED = SAMPLE_CLASSIFICATIONS[0]!;
