import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { zipSync } from "fflate";
import { buildApp } from "./app.ts";
import { migrate, openPglite, openPostgres, type Db } from "./db.ts";
import { gridGlb } from "./test-models.ts";
import { ingestHandler, type IngestOptions } from "./ingest.ts";
import { enqueue, PermanentError, Worker } from "./jobs.ts";
import { seed } from "./seed.ts";
import { Storage } from "./storage.ts";
import { thumbnailHandler, type Renderer } from "./thumbnails.ts";

let db: Db;
let app: FastifyInstance;
let storage: Storage;
let dir: string;
const opts: IngestOptions = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-ingest-"));
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    // CI shares one PostgreSQL with the library tests, so this file works in its own schema.
    const admin = await openPostgres(url);
    await admin.exec("DROP SCHEMA IF EXISTS ingest_test CASCADE; CREATE SCHEMA ingest_test");
    await admin.close();
    db = await openPostgres(`${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=ingest_test")}`);
  } else db = await openPglite();
  await migrate(db);
  await seed(db, { samples: false });
  storage = new Storage(dir);
  await storage.init();
  app = await buildApp({ db, storage });
});
afterAll(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
function glb(json: object, bin: Uint8Array = new Uint8Array(36)): Uint8Array {
  let j = enc(JSON.stringify(json));
  j = Uint8Array.from([...j, ...Array((4 - (j.length % 4)) % 4).fill(0x20)]);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}
const triangle = {
  asset: { version: "2.0" },
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "Water tower", mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ count: 3, componentType: 5126, type: "VEC3", bufferView: 0, min: [0, 0, 0], max: [1, 1, 0] }],
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
};
const model = { name: "Water tower", project: "Utilities", status: "draft", classificationId: "restricted" };
const placement = { lat: 32.08, lon: 34.78, height: 30, aboveGround: 0 };

const worker = () => new Worker(db, { ingest: ingestHandler(db, storage, opts) });

async function upload(files: { path: string; data: Uint8Array }[], extra: Record<string, unknown> = { model, placement }) {
  const res = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: files.map((f) => ({ path: f.path, size: f.data.length })), ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  const ing = res.json() as { id: string; uploads: { path: string; url: string }[] };
  for (const u of ing.uploads) {
    const data = files.find((f) => f.path === u.path)!.data;
    const r = await patch(u.url, 0, data);
    expect(r.statusCode, r.body).toBe(204);
  }
  return ing;
}
const patch = (url: string, offset: number, data: Uint8Array) =>
  app.inject({ method: "PATCH", url, headers: { "content-type": "application/offset+octet-stream", "upload-offset": String(offset), "tus-resumable": "1.0.0" }, payload: Buffer.from(data) });

async function submitAndRun(id: string) {
  const s = await app.inject({ method: "POST", url: `/api/ingests/${id}/submit` });
  expect(s.statusCode, s.body).toBe(202);
  await worker().runOnce();
  return (await app.inject(`/api/ingests/${id}`)).json();
}

describe("resumable upload (tus)", () => {
  it("resumes after a partial send and refuses a wrong offset", async () => {
    const data = glb(triangle);
    const res = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: "tower.glb", size: data.length }], model, placement } });
    const { id, uploads } = res.json();
    const url = uploads[0].url as string;

    expect((await patch(url, 0, data.subarray(0, 40))).headers["upload-offset"]).toBe("40");
    // The connection dropped; the client asks where to continue.
    const head = await app.inject({ method: "HEAD", url });
    expect(head.headers).toMatchObject({ "upload-offset": "40", "upload-length": String(data.length), "tus-resumable": "1.0.0" });
    expect((await patch(url, 0, data)).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/ingests/${id}/submit` })).statusCode).toBe(409);
    expect((await app.inject(`/api/ingests/${id}`)).json().upload).toMatchObject({ bytes: data.length, received: 40 });

    expect((await patch(url, 40, data.subarray(40))).headers["upload-offset"]).toBe(String(data.length));
    expect((await patch(url, data.length, enc("extra"))).statusCode).toBe(413);

    const done = await submitAndRun(id);
    expect(done).toMatchObject({ state: "ready", version: 1, report: { ok: true, format: "glb", nodes: ["Water tower"] } });
    expect(done.report.items.find((i: { id: string }) => i.id === "scan")).toMatchObject({ severity: "warning", title: "Not scanned for viruses" });

    // Published, in the library, and served with ranges.
    const m = (await app.inject(`/api/models/${done.modelId}`)).json();
    expect(m).toMatchObject({ name: "Water tower", sourceFormat: "glb", placement: { lat: 32.08 }, sizeBytes: data.length });
    expect(m.source.url).toBe(`files/${done.modelId}/${id}/tower.glb`);
    const file = await app.inject(`/${m.source.url}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("model/gltf-binary");
    expect(file.rawPayload.equals(Buffer.from(data))).toBe(true);
    const part = await app.inject({ url: `/${m.source.url}`, headers: { range: "bytes=0-3" } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("glTF");
    expect((await app.inject({ url: `/${m.source.url}`, headers: { range: `bytes=${data.length}-` } })).statusCode).toBe(416);
    expect((await app.inject({ url: `/${m.source.url}`, headers: { "if-none-match": file.headers.etag as string } })).statusCode).toBe(304);
    expect((await app.inject("/files/..%2F..%2Fetc%2Fpasswd")).statusCode).toBe(404);

    // Upload parts and the work folder are gone.
    expect(await readdir(storage.uploads)).toEqual([]);
    expect(await readdir(storage.ingests)).toEqual([]);

    const actions = (await db.query<{ action: string }>("SELECT action FROM audit_events WHERE target = $1", [done.modelId])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["model.create", "model.view"]));
  });

  it("refuses unsafe names and oversize declarations up front", async () => {
    for (const p of ["../x.glb", "/etc/x.glb", "a//b.glb", "C:/x.glb"]) {
      const r = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: p, size: 1 }], model } });
      expect(r.statusCode, p).toBe(400);
    }
    const big = await app.inject({ method: "POST", url: "/api/ingests", payload: { files: [{ path: "x.glb", size: 3 * 1024 ** 3 }], model } });
    expect(big.statusCode).toBe(413);
  });
});

describe("ingest job", () => {
  it("adds a version to an existing model", async () => {
    const first = await submitAndRun((await upload([{ path: "a.glb", data: glb(triangle) }])).id);
    const second = await submitAndRun((await upload([{ path: "b.glb", data: glb(triangle) }], { modelId: first.modelId, placement, note: "Roof fixed" })).id);
    expect(second).toMatchObject({ state: "ready", modelId: first.modelId, version: 2 });
    const m = (await app.inject(`/api/models/${first.modelId}`)).json();
    expect(m.history.map((h: { version: number; note: string }) => [h.version, h.note])).toEqual([
      [2, "Roof fixed"],
      [1, ""],
    ]);
  });

  it("lists every problem in a broken glTF and publishes nothing", async () => {
    const gltf = { ...triangle, buffers: [{ byteLength: 36, uri: "geometry.bin" }], images: [{ uri: "textures/wall.png" }] };
    const ing = await upload([{ path: "tower/tower.gltf", data: enc(JSON.stringify(gltf)) }]);
    const r = await submitAndRun(ing.id);
    expect(r.state).toBe("failed");
    const refs = r.report.items.find((i: { id: string }) => i.id === "references");
    expect(refs.severity).toBe("error");
    expect(refs.detail).toContain("geometry.bin");
    expect(refs.detail).toContain("textures/wall.png");
    const published = await readdir(storage.files, { recursive: true });
    expect(published.some((f) => f.includes(ing.id))).toBe(false);
    const rejects = await db.query<{ detail: { ingest: string } }>("SELECT detail FROM audit_events WHERE action = 'ingest.reject' ORDER BY seq DESC");
    expect(rejects[0]!.detail.ingest).toBe(ing.id);
  });

  it("unpacks a zip with the tileset in a folder", async () => {
    const tileset = { asset: { version: "1.1" }, geometricError: 100, root: { boundingVolume: { region: [0.6, 0.55, 0.61, 0.56, 0, 50] }, geometricError: 0, content: { uri: "tiles/0.glb" } } };
    const zip = zipSync({ "city/tileset.json": enc(JSON.stringify(tileset)), "city/tiles/0.glb": glb(triangle) });
    const r = await submitAndRun((await upload([{ path: "city.zip", data: zip }], { model: { ...model, name: "City block" }, groundFit: "street" })).id);
    expect(r, JSON.stringify(r.report?.items)).toMatchObject({ state: "ready", report: { format: "3dtiles", mainFile: "tileset.json" } });
    expect(r.report.items.find((i: { id: string }) => i.id === "validator")?.title).toMatch(/official 3D Tiles validator/);
    const m = (await app.inject(`/api/models/${r.modelId}`)).json();
    expect(m.source).toEqual({ kind: "3dtiles", url: `files/${r.modelId}/${r.id}/tileset.json`, groundFit: "street" });
    expect(m.centre.lat).toBeCloseTo((0.555 * 180) / Math.PI, 3);
    expect((await app.inject(`/files/${r.modelId}/${r.id}/tiles/0.glb`)).statusCode).toBe(200);
  });

  it("stops a zip whose entries point outside the upload", async () => {
    const zip = zipSync({ "model.glb": glb(triangle), "../../escaped.txt": enc("gotcha") });
    const r = await submitAndRun((await upload([{ path: "evil.zip", data: zip }])).id);
    expect(r).toMatchObject({ state: "failed" });
    expect(r.error).toMatch(/outside the upload/);
    expect(await readdir(dir)).not.toContain("escaped.txt");
    expect(await readdir(path.dirname(dir))).not.toContain("escaped.txt");
  });

  it("stops a zip bomb", async () => {
    const zip = zipSync({ "model.glb": glb(triangle), "padding.bin": new Uint8Array(40 * 1024 * 1024) }, { level: 9 });
    expect(zip.length).toBeLessThan(100_000);
    const r = await submitAndRun((await upload([{ path: "bomb.zip", data: zip }])).id);
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/zip bomb/);
  });

  it("rejects an infected upload when ClamAV finds a virus", async () => {
    const fake = path.join(dir, "fake-clamdscan.sh");
    await writeFile(fake, '#!/bin/sh\necho "$4/model.glb: Eicar-Signature FOUND"\nexit 1\n');
    await chmod(fake, 0o755);
    opts.clamdscan = fake;
    try {
      const r = await submitAndRun((await upload([{ path: "model.glb", data: glb(triangle) }])).id);
      expect(r).toMatchObject({ state: "failed", error: "A virus was found" });
      expect(r.report.items.find((i: { id: string }) => i.id === "scan").detail).toBe("model.glb: Eicar-Signature FOUND");
    } finally {
      delete opts.clamdscan;
    }
  });

  it("fails an FBX with a clear reason when FBX2glTF is not set up", async () => {
    const fbx = new Uint8Array(64);
    fbx.set(enc("Kaydara FBX Binary  \0\x1a\0"));
    new DataView(fbx.buffer).setUint32(23, 7400, true);
    const r = await submitAndRun((await upload([{ path: "plant.fbx", data: fbx }])).id);
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/FBX2GLTF/);
  });

  it("converts FBX to GLB with FBX2glTF", async () => {
    const fake = path.join(dir, "fake-fbx2gltf.mjs");
    // Stands in for FBX2glTF: writes a GLB next to the --output base name.
    const out = Buffer.from(glb(triangle)).toString("base64");
    await writeFile(fake, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst a = process.argv;\nwriteFileSync(a[a.indexOf("--output") + 1] + ".glb", Buffer.from("${out}", "base64"));\n`);
    await chmod(fake, 0o755);
    opts.fbx2gltf = fake;
    try {
      const fbx = new Uint8Array(64);
      fbx.set(enc("Kaydara FBX Binary  \0\x1a\0"));
      new DataView(fbx.buffer).setUint32(23, 7400, true);
      const r = await submitAndRun((await upload([{ path: "plant.fbx", data: fbx }])).id);
      expect(r, r.error).toMatchObject({ state: "ready", report: { format: "fbx", ok: true, nodes: ["Water tower"] } });
      expect(r.report.items.map((i: { id: string; severity: string }) => `${i.id}:${i.severity}`)).toEqual(expect.arrayContaining(["format:ok", "conversion:ok"]));
      // The official validator checks the converted GLB, not the FBX.
      expect(r.report.items.find((i: { id: string }) => i.id === "validator")?.title).toMatch(/official glTF validator/);
      const m = (await app.inject(`/api/models/${r.modelId}`)).json();
      expect(m).toMatchObject({ sourceFormat: "fbx", source: { kind: "glb", url: `files/${r.modelId}/${r.id}/plant.glb` } });
      expect((await app.inject(`/files/${r.modelId}/${r.id}/original/plant.fbx`)).statusCode).toBe(200);
    } finally {
      delete opts.fbx2gltf;
    }
  });

  it("tiles a large model into 3D Tiles and keeps the upload", async () => {
    // Thresholds lowered so a 5,000-triangle grid counts as large.
    opts.tileIf = { triangles: 1000, bytes: 1e12 };
    opts.leafTriangles = 1000;
    try {
      const zPlacement = { ...placement, upAxis: "z", scale: 0.01 };
      const r = await submitAndRun((await upload([{ path: "site.glb", data: gridGlb(50, true) }], { model: { ...model, name: "Site" }, placement: zPlacement })).id);
      expect(r, r.error).toMatchObject({ state: "ready", report: { format: "glb", ok: true } });
      expect(r.report.items.find((i: { id: string }) => i.id === "tiling")).toMatchObject({ severity: "ok", title: expect.stringMatching(/^Tiled for streaming: \d+ tiles in \d+ levels$/) });
      const m = (await app.inject(`/api/models/${r.modelId}`)).json();
      expect(m.source).toEqual({ kind: "3dtiles", url: `files/${r.modelId}/${r.id}/tileset.json`, localFrame: true });
      // The axis and scale are in the tiles now, so the placement no longer applies them.
      expect(m.placement).toEqual({ lat: placement.lat, lon: placement.lon, height: placement.height, aboveGround: placement.aboveGround });
      const ts = (await app.inject(`/files/${r.modelId}/${r.id}/tileset.json`)).json();
      expect(ts.root.children.length).toBeGreaterThan(1);
      expect((await app.inject(`/files/${r.modelId}/${r.id}/${ts.root.content.uri}`)).statusCode).toBe(200);
      expect((await app.inject(`/files/${r.modelId}/${r.id}/original/site.glb`)).statusCode).toBe(200);
    } finally {
      delete opts.tileIf;
      delete opts.leafTriangles;
    }
  }, 60_000);
});

describe("thumbnails (WP 3.5)", () => {
  it("renders a turntable after publishing, and again when the classification changes", async () => {
    const seen: { name: string; version: number; level: string | null; url: string }[] = [];
    const renderer: Renderer = {
      render: async (m, level) => {
        seen.push({ name: m.name, version: m.version, level: level?.label ?? null, url: m.source.url });
        return new TextEncoder().encode("RIFF....WEBP");
      },
    };
    opts.thumbnails = true;
    const thumbApp = await buildApp({ db, storage, thumbnails: true });
    try {
      const w = new Worker(db, { ingest: ingestHandler(db, storage, opts), thumbnail: thumbnailHandler(db, storage, renderer) });
      const ing = await upload([{ path: "tower.glb", data: glb(triangle) }]);
      expect((await app.inject({ method: "POST", url: `/api/ingests/${ing.id}/submit` })).statusCode).toBe(202);
      while (await w.runOnce());
      const r = (await app.inject(`/api/ingests/${ing.id}`)).json();
      const m = (await app.inject(`/api/models/${r.modelId}`)).json();
      expect(m.thumbnail).toBe(`files/${r.modelId}/thumbs/v1.webp`);
      expect(seen[0]).toMatchObject({ name: "Water tower", version: 1, level: "RESTRICTED", url: `files/${r.modelId}/${ing.id}/tower.glb` });
      const file = await app.inject(`/${m.thumbnail}`);
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toBe("image/webp");

      // The band on the picture names the level, so a new level means a new picture.
      await thumbApp.inject({ method: "PATCH", url: `/api/models/${r.modelId}`, payload: { classificationId: "secret" } });
      while (await w.runOnce());
      expect(seen.at(-1)).toMatchObject({ version: 1, level: "SECRET" });
    } finally {
      delete opts.thumbnails;
      await thumbApp.close();
    }
  });
});

describe("cross-origin calls", () => {
  it("answers a preflight and exposes the tus headers to an allowed origin only", async () => {
    const corsApp = await buildApp({ db, storage, corsOrigins: ["app://viewer"] });
    const pre = await corsApp.inject({ method: "OPTIONS", url: "/api/ingests", headers: { origin: "app://viewer", "access-control-request-method": "POST" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toContain("upload-offset");
    const ok = await corsApp.inject({ url: "/api/health", headers: { origin: "app://viewer" } });
    expect(ok.headers["access-control-expose-headers"]).toContain("upload-offset");
    const other = await corsApp.inject({ url: "/api/health", headers: { origin: "https://elsewhere.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    await corsApp.close();
  });
});

describe("job queue", () => {
  it("gives a job to another worker when the first one's lease runs out", async () => {
    let runs = 0;
    const handlers = { probe: async () => void runs++ };
    const id = await enqueue(db, "probe", {});
    const a = new Worker(db, handlers, { leaseSeconds: 60 });
    const claimed = await a.claim();
    expect(claimed?.id).toBe(id);
    // Worker A dies here. While its lease holds, nobody else takes the job.
    const b = new Worker(db, handlers);
    expect(await b.runOnce()).toBe(false);
    await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await b.runOnce()).toBe(true);
    const [row] = await db.query<{ state: string; attempts: number }>("SELECT state, attempts FROM jobs WHERE id = $1", [id]);
    expect(row).toEqual({ state: "done", attempts: 2 });
    expect(runs).toBe(1);
  });

  it("retries with backoff, and stops at once on a permanent error", async () => {
    const w = new Worker(db, {
      flaky: async () => {
        throw new Error("network blip");
      },
      broken: async () => {
        throw new PermanentError("damaged file");
      },
    });
    const flaky = await enqueue(db, "flaky", {});
    expect(await w.runOnce()).toBe(true);
    const [f] = await db.query<{ state: string; error: string; wait: boolean }>("SELECT state, error, run_after > now() + interval '5 seconds' AS wait FROM jobs WHERE id = $1", [flaky]);
    expect(f).toEqual({ state: "queued", error: "network blip", wait: true });
    expect(await w.runOnce()).toBe(false);

    const broken = await enqueue(db, "broken", {});
    await w.runOnce();
    const [b] = await db.query<{ state: string }>("SELECT state FROM jobs WHERE id = $1", [broken]);
    expect(b!.state).toBe("failed");
  });
});
