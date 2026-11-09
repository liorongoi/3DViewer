import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import { isServerErrorKey, ServerError, type ServerErrorKey } from "@viewer/shared";
import type { components, paths } from "./schema.gen";

/**
 * The typed client for the HOLO API (WP 3.1), generated from the server's published OpenAPI.
 * Paths, parameters, bodies and answers are all checked by the compiler, so a change to the API
 * that the web app is not ready for fails the type-check instead of failing at run time.
 */
export type ApiClient = Client<paths>;
export type { components, paths };
export type Schemas = components["schemas"];

export function createApiClient(baseUrl: string, options: Omit<ClientOptions, "baseUrl"> = {}): ApiClient {
  return createClient<paths>({ ...options, baseUrl });
}

/** The error object every route answers with when something is wrong. */
export type ApiError = Schemas["Error"];

/**
 * The error a server answer stands for: a ServerError with the message's key, so the app can
 * show it in its own language; a plain Error with the server's English text when the key is one
 * this app does not know (a newer server).
 */
export function errorFrom(body: unknown, status: number): Error {
  const e = (body ?? {}) as Partial<ApiError>;
  const details = (e.details ?? []).filter((d) => isServerErrorKey(d.key)).map((d) => ({ key: d.key as ServerErrorKey, params: d.params }));
  if (isServerErrorKey(e.key)) return new ServerError(e.key, e.params ?? {}, e.error, details, status);
  if (typeof e.error === "string") return new Error(e.error);
  return new ServerError("answered", { status }, undefined, [], status);
}

/** Throws the server's error, or returns the data. */
export function must<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.error !== undefined || !r.response.ok) throw errorFrom(r.error, r.response.status);
  return r.data as T;
}
