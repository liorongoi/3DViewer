import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { zipSync } from "fflate";
import type { ServerHardware } from "@viewer/shared";
import { buildApp } from "./app.ts";
import { migrate, openPglite, type Db } from "./db.ts";
import { appleGpu, parseNvidiaSmi } from "./hardware.ts";
import { ingestHandler, unpackUpload } from "./ingest.ts";
import { Worker } from "./jobs.ts";
import { captureFileOk, reconstructHandler, runWorker, type ReconstructOptions } from "./reconstruct.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";

// Every splat "made" here comes from a TEST FIXTURE worker (test-fixtures/splat-worker-fixture.mjs),
// not from a real training program; the tests check that its output is labelled as such.
const FIXTURE = fileURLToPath(new URL("../test-fixtures/splat-worker-fixture.mjs", import.meta.url));
const rtx: ServerHardware = { platform: "linux", arch: "x64", cpuModel: "Test CPU", cpus: 8, ramGb: 64, gpus: [{ vendor: "nvidia", name: "NVIDIA RTX A5000", memoryGb: 24, driver: "550.54.14" }] };

describe("hardware", () => {
  it("reads the GPU name and memory from nvidia-smi, never the driver version as the model", () => {
    const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 20480, 550.54.14\nNVIDIA RTX A2000, 6138, 512, R530\n\n");
    expect(gpus).toEqual([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", memoryGb: 24, freeGb: 20, driver: "550.54.14" },
      { vendor: "nvidia", name: "NVIDIA RTX A2000", memoryGb: 6, freeGb: 0.5, driver: "R530" },
    ]);
    // An older query without the free column still reads.
    expect(parseNvidiaSmi("NVIDIA L40S, 46068, 535.104.05")).toEqual([{ vendor: "nvidia", name: "NVIDIA L40S", memoryGb: 45, driver: "535.104.05" }]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toEqual([]);
  });
  it("counts three quarters of Apple unified memory as GPU memory", () => {
    expect(appleGpu("Apple M2 Max", 32)).toEqual({ vendor: "apple", name: "Apple M2 Max", memoryGb: 24 });
  });
});

describe("capture files", () => {
  it("accepts the files a capture can use and nothing else", () => {
    expect(captureFileOk("video", "walk.MP4")).toBe(true);
    expect(captureFileOk("photos", "set/IMG_0001.jpg")).toBe(true);
    expect(captureFileOk("photos", "photos.zip")).toBe(true);
    expect(captureFileOk("satellite", "scene_01.tif")).toBe(true);
    expect(captureFileOk("satellite", "scene_01_rpc.txt")).toBe(true);
    expect(captureFileOk("photos", "run.sh")).toBe(false);
    expect(captureFileOk("video", "model.glb")).toBe(false);
  });
});

describe("the worker runner", () => {
  it("passes discrete arguments without a shell and reads progress lines", async () => {
    const seen: number[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "viewer-runner-"));
    // An argument that a shell would expand stays one literal argument.
    const r = await runWorker(process.execPath, ["-e", "console.log('progress 0.5 x'); console.error(process.argv[1])", "$(touch pwned); *"], dir, 10_000, (f) => seen.push(f));
    expect(r.code).toBe(0);
    expect(r.stderr.trim()).toBe("$(touch pwned); *");
    expect(seen).toEqual([0.5]);
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
  it("stops a worker that runs past its time", async () => {
    const r = await runWorker(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], tmpdir(), 300, () => undefined);
    expect(r.timedOut).toBe(true);
  });
});

describe("making splats from a capture", () => {
  let db: Db;
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const capture: ReconstructOptions = { workers: { gsplat: FIXTURE, brush: FIXTURE }, hardware: async () => rtx, timeoutHours: 1 };
  const model = { name: "Courtyard", project: "Captures", status: "draft", classificationId: "restricted" };
  const placement = { lat: 32.08, lon: 34.78, height: 0, scale: 1, modelUnit: 1 };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "viewer-capture-"));
    db = await openPglite();
    await migrate(db);
    await seed(db, { samples: false });
    storage = new Storage(dir);
    await storage.init();
    app = await buildApp({ db, storage, capture });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function send(files: { path: string; data: Uint8Array }[], reconstruct: object) {
    const res = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: files.map((f) => ({ path: f.path, size: f.data.length })), model, placement, reconstruct } });
    if (res.statusCode !== 201) return res;
    const ing = res.json() as { id: string; uploads: { path: string; url: string }[] };
    for (const u of ing.uploads) {
      const data = files.find((f) => f.path === u.path)!.data;
      await app.inject({ method: "PATCH", url: u.url, headers: { "content-type": "application/offset+octet-stream", "upload-offset": "0", "tus-resumable": "1.0.0" }, payload: Buffer.from(data) });
    }
    expect((await app.inject({ method: "POST", url: `/api/ingests/${ing.id}/submit` })).statusCode).toBe(202);
    return ing;
  }
  const trainer = () => new Worker(db, { reconstruct: reconstructHandler(db, storage, capture, unpackUpload) });
  const publisher = () => new Worker(db, { ingest: ingestHandler(db, storage, {}) });
  const drain = async () => {
    while ((await trainer().runOnce()) || (await publisher().runOnce()));
  };
  const photos = () => zipSync({ "IMG_0001.jpg": new Uint8Array([0xff, 0xd8, 1]), "IMG_0002.jpg": new Uint8Array([0xff, 0xd8, 2]), "cameras.txt": new TextEncoder().encode("#") });

  it("lists the methods installed, the hardware, and each method's separate install states", async () => {
    const r = (await app.inject("/api/splat-methods")).json();
    expect(r).toMatchObject({ hardware: rtx, installed: ["gsplat", "brush"] });
    const gs = r.components.find((c: { method: string }) => c.method === "gsplat");
    expect(gs).toEqual({ method: "gsplat", configured: true, environment: "ok", revision: "test-fixture", version: "1", problems: [], trained: null, fixture: true });
    expect(r.components.find((c: { method: string }) => c.method === "opensplat")).toMatchObject({ configured: false, environment: "unchecked", revision: null, trained: null });
  });

  it("does not offer a method whose worker's own check fails, and says why", async () => {
    const broken = path.join(dir, "broken-worker.mjs");
    await writeFile(broken, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: false, tool: "opensplat", revision: "v1.1.4", problems: ["libtorch was not found."] }));\n`);
    await chmod(broken, 0o755);
    const opts: ReconstructOptions = { workers: { opensplat: broken }, hardware: async () => rtx };
    const app2 = await buildApp({ db, storage, capture: opts });
    const r = (await app2.inject("/api/splat-methods")).json();
    expect(r.installed).toEqual([]);
    expect(r.components.find((c: { method: string }) => c.method === "opensplat")).toMatchObject({ configured: true, environment: "broken", revision: "v1.1.4", problems: ["libtorch was not found."] });
    const res = await app2.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: "photos.zip", size: 3 }], model, placement, reconstruct: { input: "photos", goal: "scene", methods: ["opensplat"], preset: "fast" } } });
    expect(res.json()).toMatchObject({ key: "captureMethodBroken" });
    expect(res.json().error).toMatch(/libtorch was not found/);
    await app2.close();
  });

  it("refuses, before any upload, a method that is not installed, does not fit, or files that are not pictures", async () => {
    const zip = photos();
    const f = [{ path: "photos.zip", data: zip }];
    const notInstalled = (await send(f, { input: "photos", goal: "surface", methods: ["gsplat-2dgs"], preset: "fast" })) as { statusCode: number; json: () => { key: string } };
    expect(notInstalled.statusCode).toBe(400);
    expect(notInstalled.json().key).toBe("captureMethodNotInstalled");
    const wrongGoal = (await send(f, { input: "satellite", goal: "scene", methods: ["gsplat"], preset: "fast" })) as { statusCode: number; json: () => { key: string } };
    expect(wrongGoal.json().key).toBe("captureGoalMismatch");
    const script = (await send([{ path: "run.sh", data: new Uint8Array([1]) }], { input: "photos", goal: "scene", methods: ["gsplat"], preset: "fast" })) as { statusCode: number; json: () => { key: string } };
    expect(script.json().key).toBe("captureFileType");
  });

  it("queues one job per method at once, and publishes the results as versions of one model, labelled as a test fixture", async () => {
    const ing = (await send([{ path: "photos.zip", data: photos() }], { input: "photos", goal: "scene", methods: ["gsplat", "brush"], preset: "fast" })) as { id: string };
    const queued = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1", [ing.id]);
    expect(queued[0]!.n).toBe(2);
    expect((await app.inject(`/api/captures/${ing.id}`)).json()).toMatchObject({ state: "working", methods: [{ method: "gsplat", state: "queued" }, { method: "brush", state: "queued" }] });

    await drain();
    const status = (await app.inject(`/api/captures/${ing.id}`)).json();
    expect(status.state, JSON.stringify(status)).toBe("ready");
    const [a, b] = status.methods;
    expect(a).toMatchObject({ method: "gsplat", state: "ready", version: 1 });
    expect(b).toMatchObject({ method: "brush", state: "ready", modelId: a.modelId, version: 2 });

    const m = (await app.inject(`/api/models/${a.modelId}`)).json();
    expect(m).toMatchObject({ name: "Courtyard (gsplat (MCMC))", source: { kind: "3dtiles", splats: true }, versions: 2 });
    const [kid] = await db.query<{ report: { items: { key?: string; severity: string }[] }; request: { note: string } }>("SELECT report, request FROM ingests WHERE request->>'parentIngest' = $1 AND request->>'method' = 'gsplat'", [ing.id]);
    expect(kid!.report.items[0]).toMatchObject({ key: "splatFixture", severity: "warning" });
    expect(kid!.report.items.map((i) => i.key)).toContain("splatMade");
    expect(kid!.request.note).toMatch(/^TEST FIXTURE/);
    // The capture's uploaded bytes and work folders are gone once every method finished.
    expect(await readdir(storage.ingests)).toEqual([]);
    const audit = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE target = $1 ORDER BY at", [ing.id]);
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["reconstruct.submit", "reconstruct.done"]));
    // A finished run counts as a training on this server, marked as a fixture run.
    const comps = (await app.inject("/api/splat-methods")).json().components;
    expect(comps.find((c: { method: string }) => c.method === "gsplat").trained).toMatchObject({ fixture: true });
  });

  it("cancels a capture: queued methods end at once, the running worker is stopped, and its files are removed", async () => {
    const zip = zipSync({ "slow_1.jpg": new Uint8Array([0xff, 0xd8, 1]) });
    const ing = (await send([{ path: "photos.zip", data: zip }], { input: "photos", goal: "scene", methods: ["gsplat", "brush"], preset: "fast" })) as { id: string };
    const running = trainer().runOnce();
    // Wait until the first method's worker is training.
    for (let i = 0; i < 100; i++) {
      const s = (await app.inject(`/api/captures/${ing.id}`)).json();
      if (s.methods[0].state === "training" && s.methods[0].stage === "train") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const t0 = Date.now();
    const res = await app.inject({ method: "POST", url: `/api/captures/${ing.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json().methods[1]).toMatchObject({ method: "brush", state: "cancelled" });
    await running;
    expect(Date.now() - t0).toBeLessThan(15_000);
    const status = (await app.inject(`/api/captures/${ing.id}`)).json();
    expect(status).toMatchObject({ state: "cancelled", methods: [{ method: "gsplat", state: "cancelled" }, { method: "brush", state: "cancelled" }] });
    expect(await readdir(storage.ingests)).toEqual([]);
    const [row] = await db.query<{ state: string }>("SELECT state FROM ingests WHERE id = $1", [ing.id]);
    expect(row!.state).toBe("failed");
    const audit = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE target = $1 ORDER BY at", [ing.id]);
    expect(audit.map((x) => x.action)).toContain("reconstruct.cancel");
    expect(audit.map((x) => x.action)).not.toContain("reconstruct.fail");
    expect((await app.inject({ method: "POST", url: "/api/captures/i-nothing/cancel" })).statusCode).toBe(404);
  }, 30_000);

  it("ends with the worker's reason when a capture cannot be used, without retrying it", async () => {
    const zip = zipSync({ "unusable_1.jpg": new Uint8Array([0xff, 0xd8, 1]) });
    const ing = (await send([{ path: "photos.zip", data: zip }], { input: "photos", goal: "scene", methods: ["gsplat"], preset: "fast" })) as { id: string };
    await drain();
    const status = (await app.inject(`/api/captures/${ing.id}`)).json();
    expect(status).toMatchObject({ state: "failed", methods: [{ method: "gsplat", state: "failed" }] });
    expect(status.methods[0].error).toMatch(/too few matching features/);
    const [job] = await db.query<{ attempts: number }>("SELECT attempts FROM jobs WHERE kind = 'reconstruct' AND payload->>'ingestId' = $1", [ing.id]);
    expect(job!.attempts).toBe(1);
  });
});
