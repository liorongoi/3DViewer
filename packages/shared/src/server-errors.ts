import { english, type Strings } from "./i18n";

type Plain<K> = K extends `${infer B}_${"one" | "two" | "other"}` ? B : K;
/** A server error message: a key of `serverErrors` in the interface strings. */
export type ServerErrorKey = Plain<keyof Strings["serverErrors"]>;
export type ErrorParams = Record<string, string | number>;

/**
 * An error the server answered with (or the app met talking to it). The message is English, for
 * logs and API users; `key` and `params` let the interface show it in its own language.
 */
export class ServerError extends Error {
  constructor(
    readonly key: ServerErrorKey,
    readonly params: ErrorParams = {},
    message = english(`serverErrors.${key}`, params),
    /** Several problems at once (base map sources): each in the interface language too. */
    readonly details: { key: ServerErrorKey; params?: ErrorParams }[] = [],
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/** The English text of a server error. */
export function serverErrorText(key: ServerErrorKey, params: ErrorParams = {}): string {
  return english(`serverErrors.${key}`, params);
}

/** True when this is one of the server's error keys (an answer from a newer server may not be). */
export function isServerErrorKey(key: unknown): key is ServerErrorKey {
  return typeof key === "string" && /^\w+$/.test(key) && english(`serverErrors.${key}`, { count: 2 }) !== `serverErrors.${key}`;
}
