/** Thrown for a problem a retry cannot fix (a damaged file, a missing converter). */
export class PermanentError extends Error {
  override name = "PermanentError";
}
