import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no types
import { generate } from "../scripts/generate.mjs";
import { ServerError } from "@viewer/shared";
import { createApiClient, errorFrom, must } from "./index";

describe("generated client", () => {
  it("is up to date with openapi.json", async () => {
    const onDisk = await readFile(new URL("./schema.gen.ts", import.meta.url), "utf8");
    expect(onDisk === (await generate()), "src/schema.gen.ts is out of date: run pnpm --filter @viewer/api-client generate").toBe(true);
  });

  it("calls the documented path and hands back the data or the server's error", async () => {
    const seen: string[] = [];
    const api = createApiClient("http://srv", {
      fetch: async (req: Request) => {
        seen.push(`${req.method} ${req.url}`);
        return req.url.endsWith("/api/models/nope")
          ? new Response(JSON.stringify({ error: "No model with this id." }), { status: 404, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(must(await api.GET("/api/models", { params: { query: { q: "גשר" } } }))).toEqual([]);
    await expect(api.GET("/api/models/{id}", { params: { path: { id: "nope" } } }).then(must)).rejects.toThrow("No model with this id.");
    expect(seen).toEqual([`GET http://srv/api/models?q=${encodeURIComponent("גשר")}`, "GET http://srv/api/models/nope"]);
  });
});

describe("server errors", () => {
  it("keep the message's key and values, so the app can show it in its own language", () => {
    const e = errorFrom({ error: "Too many changes from this address. Try again in 30 s.", key: "rateLimited", params: { seconds: 30 }, code: "RATE_LIMITED" }, 429);
    expect(e).toBeInstanceOf(ServerError);
    expect(e).toMatchObject({ key: "rateLimited", params: { seconds: 30 }, status: 429, message: "Too many changes from this address. Try again in 30 s." });
    const many = errorFrom({ error: "a b", key: "sourceAddress", params: { label: "A" }, details: [{ key: "sourceAddress", params: { label: "A" } }, { key: "sourceNeedsLayer", params: { label: "B" } }] }, 400) as ServerError;
    expect(many.details.map((d) => d.key)).toEqual(["sourceAddress", "sourceNeedsLayer"]);
  });

  it("fall back to the server's English text for a key this app does not know, and to the status with no text", () => {
    const newer = errorFrom({ error: "Something new went wrong.", key: "somethingNew" }, 400);
    expect(newer).not.toBeInstanceOf(ServerError);
    expect(newer.message).toBe("Something new went wrong.");
    const bare = errorFrom(null, 502);
    expect(bare).toMatchObject({ key: "answered", message: "The server answered 502." });
  });
});
