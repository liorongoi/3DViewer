/**
 * The conversion sandbox with real Podman (NFR-14): every step that reads an uploaded file runs in
 * a container with no network, a read-only root and one writable folder.
 *
 * Needs podman, so it runs where SANDBOX_TEST=1 (CI's server job, and a developer machine with
 * podman); elsewhere it is skipped. The sandbox's root is built here from this machine's Node.js
 * and FBX2glTF, as the server bundle builds it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { migrate, openPglite, type Db } from "./db.ts";
import { ingestHandler, type IngestOptions } from "./ingest.ts";
import { Worker } from "./jobs.ts";
import { PodmanSandbox, probeSandbox } from "./sandbox.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";
import { gridGlb } from "./test-models.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const run = process.env.SANDBOX_TEST === "1";
const fbx2gltf = (() => {
  try {
    return path.join(path.dirname(createRequire(path.join(ROOT, "apps/desktop/package.json")).resolve("fbx2gltf/package.json")), "bin/Linux/FBX2glTF");
  } catch {
    return "";
  }
})();

let dir: string;
let db: Db;
let app: FastifyInstance;
let storage: Storage;
let sandbox: PodmanSandbox;
const opts: IngestOptions = {};

describe.runIf(run)("conversion sandbox (podman)", () => {
  beforeAll(async () => {
    // The sandbox runs the built step runner (dist/convert-step.js).
    execFileSync(process.execPath, [path.join(ROOT, "apps/server/node_modules/vite/bin/vite.js"), "build", "--outDir", "dist", "--emptyOutDir", "--logLevel", "error"], { cwd: path.join(ROOT, "apps/server"), stdio: "inherit" });
    dir = await mkdtemp(path.join(tmpdir(), "viewer-sandbox-"));
    const rootfs = path.join(dir, "rootfs");
    execFileSync("bash", [path.join(ROOT, "scripts/build-sandbox-rootfs.sh"), rootfs, process.execPath, fbx2gltf, path.join(ROOT, "node_modules/.pnpm")], { stdio: "inherit" });
    // From source the server's packages are the workspace's: the whole checkout is mounted read-only.
    sandbox = new PodmanSandbox({ podman: process.env.PODMAN ?? "podman", rootfs, stateDir: path.join(dir, "podman"), mounts: [ROOT, path.dirname(fbx2gltf)] });
    db = await openPglite();
    await migrate(db);
    await seed(db, { samples: false });
    storage = new Storage(path.join(dir, "storage"));
    await storage.init();
    app = await buildApp({ db, storage });
    Object.assign(opts, { sandbox, fbx2gltf, tileIf: { triangles: 50_000, bytes: 1e9 } });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function ingest(name: string, data: Uint8Array) {
    const res = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: name, size: data.length }], model: { name, status: "draft", classificationId: "unclassified" }, placement: { lat: 32.08, lon: 34.78, height: 0, aboveGround: 0 } } });
    expect(res.statusCode, res.body).toBe(201);
    const ing = res.json() as { id: string; uploads: { url: string }[] };
    const up = await app.inject({ method: "PATCH", url: ing.uploads[0]!.url, headers: { "content-type": "application/offset+octet-stream", "upload-offset": "0", "tus-resumable": "1.0.0" }, payload: Buffer.from(data) });
    expect(up.statusCode, up.body).toBe(204);
    expect((await app.inject({ method: "POST", url: `/api/ingests/${ing.id}/submit` })).statusCode).toBe(202);
    const t = performance.now();
    await new Worker(db, { ingest: ingestHandler(db, storage, opts) }).runOnce();
    const r = (await app.inject(`/api/ingests/${ing.id}`)).json();
    return { ...r, ms: performance.now() - t };
  }

  it("gives a step no network, no name lookups and no writable root", async () => {
    const p = await probeSandbox(sandbox, path.join(dir, "probe"));
    expect(p.problems).toEqual([]);
    expect(p.result).toMatchObject({ rootWritable: false, workWritable: true });
    expect(p.result!.network).toBe("ENETUNREACH");
    expect(p.result!.dns).not.toBe("resolved");
  }, 120_000);

  it("converts a real FBX with FBX2glTF, validates and optimises it, all in the sandbox", async () => {
    const r = await ingest("bunny.fbx", new Uint8Array(await readFile(path.join(ROOT, "apps/web/public/samples/fbx/stanford-bunny.fbx"))));
    expect(r.state, r.error).toBe("ready");
    const ids = (r.report.items as { id: string; severity: string }[]).map((i) => `${i.id}:${i.severity}`);
    expect(ids).toEqual(expect.arrayContaining(["conversion:ok", "validator:ok", "optimise:ok"]));
    const files = await readdir(path.join(storage.files, r.modelId, r.id), { recursive: true });
    expect(files).toEqual(expect.arrayContaining(["bunny.glb", path.join("original", "bunny.fbx")]));
    console.log(`FBX in the sandbox: ${(r.ms / 1000).toFixed(1)} s`);
  }, 300_000);

  it("tiles a large model in the sandbox", async () => {
    const r = await ingest("grid.glb", gridGlb(300));
    expect(r.state, r.error).toBe("ready");
    expect(r.report.items.find((i: { id: string }) => i.id === "tiling")).toMatchObject({ severity: "ok" });
    expect(r.modelId).toBeTruthy();
  }, 300_000);

  it("reports a step's progress", async () => {
    const work = path.join(dir, "progress");
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, "grid.glb"), gridGlb(400));
    const seen: number[] = [];
    const r = await sandbox.run<{ tiles: number }>({ task: "tile", file: path.join(work, "grid.glb"), outDir: path.join(work, "out"), opts: { leafTriangles: 20_000 } }, work, { timeoutMs: 120_000, onProgress: (p) => seen.push(p.done) });
    expect(r.tiles).toBeGreaterThan(1);
    expect(seen.length).toBeGreaterThan(0);
  }, 120_000);

  it("stops a step that runs past its time, and leaves no container behind", async () => {
    const work = path.join(dir, "slow");
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, "grid.glb"), gridGlb(1500));
    const t = performance.now();
    await expect(sandbox.run({ task: "tile", file: path.join(work, "grid.glb"), outDir: path.join(work, "out"), opts: {} }, work, { timeoutMs: 1000 })).rejects.toThrow(/stopped/);
    expect(performance.now() - t).toBeLessThan(30_000);
    const left = execFileSync(process.env.PODMAN ?? "podman", ["--root", path.join(dir, "podman/storage"), "--runroot", path.join(dir, "podman/run"), "ps", "--all", "--quiet"], { encoding: "utf8" });
    expect(left.trim()).toBe("");
  }, 60_000);
});
