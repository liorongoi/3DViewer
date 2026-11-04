import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema.gen";

/**
 * The typed client for the VIEWER API (WP 3.1), generated from the server's published OpenAPI.
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

/** Throws the server's error message, or returns the data. */
export function must<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { error?: string } | undefined;
    throw new Error(e?.error ?? `The server answered ${r.response.status}.`);
  }
  return r.data as T;
}
