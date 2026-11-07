import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, writeLimiter } from "./app.ts";
import { migrate, openPglite, type Db } from "./db.ts";

describe("write rate limit", () => {
  it("allows a burst, then refills at the limit per minute", () => {
    let t = 0;
    const wait = writeLimiter(3, () => t);
    expect([wait("a"), wait("a"), wait("a")]).toEqual([0, 0, 0]);
    expect(wait("a")).toBe(20);
    expect(wait("b")).toBe(0); // other addresses are not affected
    t = 20_000;
    expect(wait("a")).toBe(0);
    expect(wait("a")).toBeGreaterThan(0);
  });

  let db: Db;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await openPglite();
    await migrate(db);
    app = await buildApp({ db, writeRateLimit: 2 });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("answers 429 with Retry-After, never for reads or upload chunks", async () => {
    const post = () => app.inject({ method: "POST", url: "/api/no-such-route", payload: {} });
    expect((await post()).statusCode).toBe(404);
    expect((await post()).statusCode).toBe(404);
    const r = await post();
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.json().code).toBe("RATE_LIMITED");
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/tus/x" })).statusCode).not.toBe(429);
  });
});
