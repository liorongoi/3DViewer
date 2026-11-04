/**
 * WP 3.4 acceptance, kill-worker test: a job resumes after its worker dies, and nothing is lost.
 *
 * Runs the real server (apps/server/dist, build it first) with a 15 s job lease. It uploads a
 * terrain-like mesh of 3 M triangles (over the 1.5 M limit, so the job tiles it into 3D Tiles,
 * which takes a while), and kills the server outright while the job is tiling. Started again, the server must take the
 * job up once the lease runs out and publish exactly one model, with every tile, the original
 * kept, one audit entry for the new model and no work files left behind.
 *
 *   pnpm --filter @viewer/server build
 *   E2E_KILL=1 pnpm --filter @viewer/server exec vitest run src/worker-kill.e2e.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const server = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "kill-worker-"));
const port = 8800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const PASSWORD = "kill worker test password";
let proc: ChildProcess | null = null;
const log: string[] = [];

/** A rolling surface of (n-1) × (m-1) × 2 triangles, about 1 km across, as a GLB. */
function gridGlb(n: number, m: number): Buffer {
  const pos = new Float32Array(n * m * 3);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = (i / (n - 1)) * 1000 - 500;
      pos[k + 1] = 20 * Math.sin(i / 40) * Math.cos(j / 30);
      pos[k + 2] = (j / (m - 1)) * 700 - 350;
    }
  const idx = new Uint32Array((n - 1) * (m - 1) * 6);
  let t = 0;
  for (let j = 0; j < m - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.set([a, c, b, b, c, d], t);
      t += 6;
    }
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Terrain" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n * m, type: "VEC3", min: [-500, -20, -350], max: [500, 20, 350] },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (type: number, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([head, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}

async function start(): Promise<void> {
  proc = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, "data"), SEED_SAMPLES: "0", JOB_LEASE_SECONDS: "15", ADMIN_PASSWORD: PASSWORD },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d: Buffer) => log.push(String(d)));
  proc.stderr!.on("data", (d: Buffer) => log.push(String(d)));
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The server did not start.\n${log.join("")}`);
}
const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(`${base}${url}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers as Record<string, string>) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
type Status = { state: string; modelId: string | null; version: number | null; error: string | null; job: { state: string; progress: { step?: string }; attempts: number } | null };

afterAll(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.env.E2E_KILL === "1")("WP 3.4: kill the worker mid-job", () => {
  it("takes the job up again after a restart and publishes exactly once", async () => {
    await start();
    const bytes = gridGlb(1500, 1001); // 3.0 M triangles, 54 MB
    const ing = await json<{ id: string; uploads: { url: string }[] }>("/api/ingests", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "terrain.glb", size: bytes.length }],
        model: { name: "Terrain, kill test", status: "draft", classificationId: "unclassified" },
        placement: { lat: 31.7745, lon: 35.2405, height: 0, aboveGround: 0 },
      }),
    });
    const put = await fetch(`${base}${ing.uploads[0]!.url}`, { method: "PATCH", headers: { "tus-resumable": "1.0.0", "upload-offset": "0", "content-type": "application/offset+octet-stream" }, body: bytes });
    expect(put.status).toBe(204);
    await json(`/api/ingests/${ing.id}/submit`, { method: "POST" });

    // Wait until the job is tiling, then kill the server outright.
    let s: Status;
    let slowest = 0;
    for (let tilePolls = 0; ; ) {
      const t = Date.now();
      s = await json<Status>(`/api/ingests/${ing.id}`);
      slowest = Math.max(slowest, Date.now() - t);
      // Let it tile for a few polls first, so the kill lands in the middle of the work.
      if ((s.job?.progress.step === "tile" && ++tilePolls >= 5) || s.state === "ready" || s.state === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(s.job?.progress.step, "the job finished before it could be killed").toBe("tile");
    const killedAt = Date.now();
    proc!.kill("SIGKILL");
    await new Promise((r) => proc!.once("exit", r));

    // Back up: the job waits out the dead worker's lease, then runs again from the upload.
    await start();
    for (;;) {
      s = await json<Status>(`/api/ingests/${ing.id}`);
      if (s.state === "ready" || s.state === "failed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const recovered = (Date.now() - killedAt) / 1000;
    console.log(`kill-worker: killed while tiling, published ${recovered.toFixed(0)} s later after ${s.job?.attempts} attempts; slowest API answer while the job ran ${slowest} ms`);
    expect(s, s.error ?? "").toMatchObject({ state: "ready", version: 1, job: { state: "done", attempts: 2 } });

    // Exactly one model with one version, and its tileset and every tile are there.
    const models = await json<{ id: string; name: string }[]>("/api/models");
    expect(models.filter((m) => m.name === "Terrain, kill test")).toHaveLength(1);
    const m = await json<{ id: string; versions: number; source: { kind: string; url: string }; history: unknown[] }>(`/api/models/${s.modelId}`);
    expect(m).toMatchObject({ versions: 1, source: { kind: "3dtiles" } });
    expect(m.history).toHaveLength(1);
    const tileset = await json<{ root: unknown }>(`/${m.source.url}`);
    const uris: string[] = [];
    const walk = (t: { content?: { uri: string }; children?: unknown[] }) => (t.content && uris.push(t.content.uri), (t.children ?? []).forEach((c) => walk(c as typeof t)));
    walk(tileset.root as Parameters<typeof walk>[0]);
    expect(uris.length).toBeGreaterThan(20);
    const folder = m.source.url.slice(0, m.source.url.lastIndexOf("/") + 1);
    const missing = [];
    for (const u of uris) if (!(await fetch(`${base}/${folder}${u}`, { method: "HEAD" })).ok) missing.push(u);
    expect(missing).toEqual([]);

    // The original is kept beside the tiles, and the work files are gone.
    const storage = path.join(dir, "data", "storage");
    expect(existsSync(path.join(storage, "files", s.modelId!, ing.id, "original", "terrain.glb"))).toBe(true);
    expect(existsSync(path.join(storage, "ingests", ing.id))).toBe(false);
    const parts = existsSync(path.join(storage, "uploads")) ? readdirSync(path.join(storage, "uploads")) : [];
    expect(parts).toEqual([]);

    // One audit entry for the new model, though the job ran twice.
    const { token } = await json<{ token: string }>("/api/admin/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    const events = await json<{ action: string }[]>(`/api/audit?target=${encodeURIComponent(s.modelId!)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(events.filter((e) => e.action === "model.create")).toHaveLength(1);
  }, 20 * 60_000);
});
