import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { migrate, openPglite } from "./db.ts";
import { Storage } from "./storage.ts";

describe("health check", () => {
  it("checks the database and storage, and answers 503 naming what failed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "viewer-health-"));
    const storage = new Storage(dir);
    await storage.init();
    const db = await openPglite();
    await migrate(db);
    const app = await buildApp({ db, storage });
    try {
      const ok = await app.inject("/api/health");
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true, db: "pglite", checks: { database: "ok", storage: "ok" } });

      await rm(dir, { recursive: true, force: true }); // storage gone
      await db.close(); // database gone
      const bad = await app.inject("/api/health");
      expect(bad.statusCode).toBe(503);
      const j = bad.json();
      expect(j.ok).toBe(false);
      expect(j.checks.database).toMatch(/^failed/);
      expect(j.checks.storage).toMatch(/^failed/);
      expect(j.error).toBe("Not ready: database and storage failed.");
      // Liveness only says the process answers.
      expect((await app.inject("/api/health/live")).statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
