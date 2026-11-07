/**
 * The real server process (dist/main.js, built here first): a wrong setting stops it with code 78
 * and a message naming the setting, and SIGTERM shuts it down cleanly.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = path.join(root, "dist/main.js");
const dir = mkdtempSync(path.join(tmpdir(), "viewer-process-"));

function run(env: Record<string, string>) {
  const p = spawn(process.execPath, [main], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exit = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  return { p, exit, out: () => out };
}

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--outDir", "dist", "--emptyOutDir", "--logLevel", "error"], { cwd: root, stdio: "inherit" });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("server process", () => {
  it("stops with code 78 on a wrong setting, naming it", async () => {
    const r = run({ PORT: "80a", NODE_ENV: "production" });
    expect(await r.exit).toBe(78);
    expect(r.out()).toContain("PORT must be a whole number");
    expect(r.out()).toContain("DATABASE_URL is required in production");
  });

  it("starts, reports ready, and shuts down cleanly on SIGTERM", async () => {
    const port = 8900 + Math.floor(Math.random() * 90);
    const r = run({ PORT: String(port), DATA_DIR: dir, WORKERS: "0", SEED_SAMPLES: "0" });
    let health: { ok: boolean; checks: object } | null = null;
    for (let i = 0; i < 300 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`).then((x) => x.json() as Promise<{ ok: boolean; checks: object }>, () => null);
      if (!health) await new Promise((res) => setTimeout(res, 100));
    }
    expect(health).toEqual({ ok: true, db: "pglite", checks: { database: "ok", storage: "ok" } });
    const t0 = Date.now();
    r.p.kill("SIGTERM");
    expect(await r.exit).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.out()).toContain("shutting down");
  }, 60_000);
});
