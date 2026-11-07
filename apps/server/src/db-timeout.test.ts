import { describe, expect, it } from "vitest";
import { openPostgres } from "./db.ts";

// Needs a real PostgreSQL (CI sets TEST_DATABASE_URL); the embedded database has no statement limit.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("database time limits", () => {
  it("stops a statement that runs past the limit, and the pool keeps working", async () => {
    const db = await openPostgres(url!, { statementTimeoutMs: 1000 });
    try {
      const t0 = Date.now();
      await expect(db.query("SELECT pg_sleep(5)")).rejects.toThrow(/statement timeout/);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(await db.query<{ n: number }>("SELECT 1 AS n")).toEqual([{ n: 1 }]);
      const [s] = await db.query<{ idle: string; app: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('application_name') AS app");
      expect(s).toEqual({ idle: "5min", app: "viewer-server" });
    } finally {
      await db.close();
    }
  });
});
