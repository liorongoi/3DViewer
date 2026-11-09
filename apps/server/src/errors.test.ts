import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { migrate, openPglite } from "./db.ts";

describe("error answers", () => {
  it("name the message by its key and values, beside the English text", async () => {
    const db = await openPglite();
    await migrate(db);
    const app = await buildApp({ db });
    try {
      const missing = await app.inject("/api/models/no-such-model");
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "No model with this id.", key: "noModel" });

      const invalid = await app.inject({ method: "PATCH", url: "/api/models/no-such-model", payload: { status: "nonsense" } });
      expect(invalid.statusCode).toBe(400);
      const j = invalid.json();
      expect(j.key).toBe("invalidRequest");
      expect(j.error).toBe(`The request is not valid: ${j.params.detail}`);
      expect(j.params.detail).toMatch(/status/);
    } finally {
      await app.close();
    }
  }, 30000);
});
