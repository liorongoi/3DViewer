import { serverErrorText, type ErrorParams, type ServerErrorKey } from "@viewer/shared";

/**
 * An error answer: `error` is the English text, for API users and logs; `key` and `params` let
 * the app show the same message in the interface language (strings `serverErrors.*`).
 */
export function problem<E extends object = Record<never, never>>(key: ServerErrorKey, params?: ErrorParams, extra?: E) {
  return { error: serverErrorText(key, params), key, ...(params ? { params } : {}), ...(extra ?? ({} as E)) };
}
