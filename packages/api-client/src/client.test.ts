import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no types
import { generate } from "../scripts/generate.mjs";
import { createApiClient, must } from "./index";

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
