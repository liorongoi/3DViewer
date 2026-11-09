import type { TFunction } from "i18next";
import { ServerError } from "@viewer/shared";

/** An error's message in the interface language: the server's errors by their key, others as they are. */
export function errorText(e: unknown, t: TFunction): string {
  if (e instanceof ServerError) {
    if (e.details.length) return e.details.map((d) => t(`serverErrors.${d.key}`, d.params ?? {})).join(" ");
    return t(`serverErrors.${e.key}`, e.params);
  }
  return e instanceof Error ? e.message : String(e);
}
