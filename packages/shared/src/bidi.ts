const FSI = "⁨";
const PDI = "⁩";

/**
 * A value put into a right-to-left sentence (a coordinate, a length, an English model name) keeps
 * its own direction (WP 6.1): it is wrapped in first-strong isolate marks, so "-33.5" does not show
 * as "33.5-" and a name ending in ")" does not jump to the other side. The marks are invisible.
 * Left-to-right languages, and values that are not text or number, are left alone.
 */
export function isolateValue<T>(value: T, lng: string | undefined): T | string {
  if (!lng?.startsWith("he")) return value;
  if (typeof value !== "string" && typeof value !== "number") return value;
  const s = String(value);
  return !s || (s.startsWith(FSI) && s.endsWith(PDI)) ? s : FSI + s + PDI;
}

/** The text without isolate and direction marks, for comparing what the reader sees. */
export function stripBidi(s: string): string {
  return s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
}
