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
  }, 30_000); // the first call starts the official 3D Tiles validator

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
      // A file of unknown units (MSR-06): drawn at the scale given, measured in model units.
      const zPlacement = { ...placement, upAxis: "z", scale: 0.01, modelUnit: 0.01 };
      const r = await submitAndRun((await upload([{ path: "site.glb", data: gridGlb(50, true) }], { model: { ...model, name: "Site" }, placement: zPlacement })).id);
      expect(r, r.error).toMatchObject({ state: "ready", report: { format: "glb", ok: true } });
      expect(r.report.items.find((i: { id: string }) => i.id === "tiling")).toMatchObject({ severity: "ok", title: expect.stringMatching(/^Tiled for streaming: \d+ tiles in \d+ levels$/) });
      const m = (await app.inject(`/api/models/${r.modelId}`)).json();
      expect(m.source).toEqual({ kind: "3dtiles", url: `files/${r.modelId}/${r.id}/tileset.json`, localFrame: true });
      // The axis and scale are in the tiles now, so the placement no longer applies them; the
      // model unit stays, as it says how long one unit of the file is drawn.
      expect(m.placement).toEqual({ lat: placement.lat, lon: placement.lon, height: placement.height, aboveGround: placement.aboveGround, modelUnit: 0.01 });
      const ts = (await app.inject(`/files/${r.modelId}/${r.id}/tileset.json`)).json();
      expect(ts.root.children.length).toBeGreaterThan(1);
      expect((await app.inject(`/files/${r.modelId}/${r.id}/${ts.root.content.uri}`)).statusCode).toBe(200);
      expect((await app.inject(`/files/${r.modelId}/${r.id}/original/site.glb`)).statusCode).toBe(200);
    } finally {
      delete opts.tileIf;
      delete opts.leafTriangles;
    }
  }, 60_000);

  it("publishes a GLB compressed, and keeps the upload to download", async () => {
    const data = gridGlb(200); // 80,000 triangles, mostly geometry
    const r = await submitAndRun((await upload([{ path: "field.glb", data }], { model: { ...model, name: "Field" }, placement })).id);
    expect(r, r.error).toMatchObject({ state: "ready", report: { format: "glb", ok: true } });
    expect(r.report.items.find((i: { id: string }) => i.id === "optimise")).toMatchObject({ severity: "ok", title: expect.stringMatching(/^Compressed for sending: [\d.]+ MB to [\d.]+ MB$/) });
    const m = (await app.inject(`/api/models/${r.modelId}`)).json();
    expect(m.source).toEqual({ kind: "glb", url: `files/${r.modelId}/${r.id}/field.glb` });
    const sent = (await app.inject(`/${m.source.url}`)).rawPayload;
    expect(sent.length).toBeLessThan(data.length * 0.8);
    expect(sent.subarray(0, 4).toString()).toBe("glTF");
    expect(sent.toString("latin1")).toContain("EXT_meshopt_compression");
    expect((await app.inject(`/files/${r.modelId}/${r.id}/original/field.glb`)).rawPayload.equals(Buffer.from(data))).toBe(true);
  }, 60_000);
});

describe("AC-02: the bad-file kit", () => {
  // The corrupt and hostile files from docs/DATA_SOURCES.md, each through the real upload and job.
  // Every one must fail with a reason that names the problem, list each problem it has (not just
  // the first), publish nothing, leave no work files and keep the server answering.
  const region = [0.6, 0.55, 0.61, 0.56, 0, 50];
  const tileset = (uris: string[]) => ({
    asset: { version: "1.1" },
    geometricError: 100,
    root: { boundingVolume: { region }, geometricError: 10, refine: "REPLACE", children: uris.map((uri) => ({ boundingVolume: { region }, geometricError: 0, content: { uri } })) },
  });
  const fbx = (version: number) => {
    const b = new Uint8Array(64);
    b.set(enc("Kaydara FBX Binary  \0\x1a\0"));
    new DataView(b.buffer).setUint32(23, version, true);
    return b;
  };
  const whole = glb(triangle);
  const brokenJson = glb(triangle);
  brokenJson.set(enc("{{{{"), 20);
  const kit: { name: string; files: { path: string; data: Uint8Array }[]; error: RegExp; problems?: { id: string; detail: RegExp }[] }[] = [
    { name: "truncated GLB", files: [{ path: "tower.glb", data: whole.subarray(0, whole.length - 20) }], error: /^tower\.glb cannot be read$/, problems: [{ id: "format", detail: /cut short: the header says \d+ bytes, the file has \d+/ }] },
    { name: "GLB whose JSON is broken", files: [{ path: "tower.glb", data: brokenJson }], error: /^tower\.glb cannot be read$/, problems: [{ id: "format", detail: /JSON cannot be read/ }] },
    {
      name: "glTF with a missing texture",
      files: [{ path: "tower/tower.gltf", data: enc(JSON.stringify({ ...triangle, buffers: [{ byteLength: 36, uri: "geometry.bin" }], images: [{ uri: "textures/wall.png" }] })) }],
      error: /^2 referenced files are missing$/,
      problems: [{ id: "references", detail: /geometry\.bin.*textures\/wall\.png|textures\/wall\.png.*geometry\.bin/ }],
    },
    {
      name: "glTF with several problems at once",
      files: [{ path: "tower.gltf", data: enc(JSON.stringify({ ...triangle, extensionsRequired: ["ACME_holograms"], buffers: [{ byteLength: 36, uri: "geometry.bin" }] })) }],
      error: /./,
      problems: [
        { id: "extensions", detail: /ACME_holograms/ },
        { id: "references", detail: /geometry\.bin/ },
      ],
    },
    { name: "FBX with a bad header", files: [{ path: "plant.fbx", data: fbx(99999) }], error: /^The FBX header is damaged$/, problems: [{ id: "format", detail: /version 99999/ }] },
    { name: "FBX that is not FBX inside", files: [{ path: "plant.fbx", data: enc("hello, this is not a model") }], error: /^The file is not FBX$/, problems: [{ id: "format", detail: /FBX header/ }] },
    {
      name: "tileset with missing tiles",
      files: [{ path: "city/tileset.json", data: enc(JSON.stringify(tileset(["tiles/0.glb", "tiles/1.glb", "tiles/2.glb"]))) }, { path: "city/tiles/0.glb", data: glb(triangle) }],
      error: /^2 tile files are missing$/,
      problems: [{ id: "references", detail: /(?=.*tiles\/1\.glb)(?=.*tiles\/2\.glb)/ }],
    },
    { name: "file of no known kind", files: [{ path: "notes.txt", data: enc("not a model") }], error: /^No model found$/, problems: [{ id: "format", detail: /opens GLB, glTF, FBX and 3D Tiles.*Found: txt/ }] },
    { name: "zip bomb", files: [{ path: "bomb.zip", data: zipSync({ "model.glb": glb(triangle), "padding.bin": new Uint8Array(40 * 1024 * 1024) }, { level: 9 }) }], error: /^padding\.bin expands over \d+ times; this looks like a zip bomb\.$/ },
    { name: "zip with a path out of the upload", files: [{ path: "evil.zip", data: zipSync({ "model.glb": glb(triangle), "../../escaped.txt": enc("gotcha") }) }], error: /^The zip has an entry that points outside the upload: \.\.\/\.\.\/escaped\.txt$/ },
    { name: "damaged zip", files: [{ path: "broken.zip", data: zipSync({ "model.glb": glb(triangle) }).subarray(0, 60) }], error: /^broken\.zip is not a readable zip file\.$/ },
  ];
  const ids: string[] = [];
  let modelsBefore = 0;
  beforeAll(async () => {
    modelsBefore = (await app.inject("/api/models")).json().length;
  });

  it.each(kit)("rejects a $name, naming the problem", async ({ files, error, problems }) => {
    const ing = await upload(files);
    ids.push(ing.id);
    const r = await submitAndRun(ing.id);
    expect(r.state).toBe("failed");
    expect(r.modelId, "no model is made").toBeNull();
    expect(r.error).toMatch(error);
    for (const p of problems ?? []) {
      const item = r.report?.items.find((i: { id: string }) => i.id === p.id);
      expect(item, `${p.id} is listed: ${JSON.stringify(r.report?.items)}`).toMatchObject({ severity: "error" });
      expect(item.detail).toMatch(p.detail);
    }
    if (problems) expect(r.report.ok).toBe(false);
    // One try only: a bad file does not get better on a retry.
    expect(r.job.attempts).toBe(1);
  });

  it("published nothing, left nothing behind, recorded each refusal and kept answering", async () => {
    expect(ids).toHaveLength(kit.length);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/models")).json()).toHaveLength(modelsBefore);
    const published = await readdir(storage.files, { recursive: true }).catch(() => []);
    const work = await readdir(storage.ingests).catch(() => []);
    const parts = await readdir(storage.uploads).catch(() => []);
    for (const id of ids) {
      expect(published.some((f) => f.includes(id)), `${id} published`).toBe(false);
      expect(work).not.toContain(id);
      expect(parts.some((f) => f.startsWith(id))).toBe(false);
    }
    const rejects = await db.query<{ detail: { ingest: string; reason: string } }>("SELECT detail FROM audit_events WHERE action = 'ingest.reject'");
    for (const id of ids) expect(rejects.filter((e) => e.detail.ingest === id), `one refusal recorded for ${id}`).toHaveLength(1);
  });
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
      expect(m.thumbnail).toMatch(new RegExp(`^files/${r.modelId}/thumbs/v1-[0-9a-z]+\\.webp$`));
      expect(seen[0]).toMatchObject({ name: "Water tower", version: 1, level: "RESTRICTED", url: `files/${r.modelId}/${ing.id}/tower.glb` });
      const file = await app.inject(`/${m.thumbnail}`);
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toBe("image/webp");

      // The band on the picture names the level, so a new level means a new picture.
      await thumbApp.inject({ method: "PATCH", url: `/api/models/${r.modelId}`, payload: { classificationId: "secret" } });
      while (await w.runOnce());
      expect(seen.at(-1)).toMatchObject({ version: 1, level: "SECRET" });
      // Files are cached as immutable, so the new picture has a new address and the old one goes.
      const after = (await app.inject(`/api/models/${r.modelId}`)).json().thumbnail;
      expect(after).not.toBe(m.thumbnail);
      expect((await app.inject(`/${after}`)).statusCode).toBe(200);
      expect((await app.inject(`/${m.thumbnail}`)).statusCode).toBe(404);
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

describe("georeference (WP 1.3)", () => {
  it("places an upload from the metadata.xml beside it, grid north and scale included", async () => {
    const xml = enc("<ModelMetadata version=\"1\"><SRS>EPSG:2039</SRS><SRSOrigin>280171.881,813577.484,2000</SRSOrigin></ModelMetadata>");
    const ing = await upload([{ path: "hermon/Data/site.glb", data: glb(triangle) }, { path: "hermon/metadata.xml", data: xml }], { model });
    const done = await submitAndRun(ing.id);
    expect(done, JSON.stringify(done.report?.items)).toMatchObject({ state: "ready" });
    const m = (await app.inject(`/api/models/${done.modelId}`)).json();
    expect(m.placement.lat).toBeCloseTo(33.4163, 6);
    expect(m.placement.lon).toBeCloseTo(35.8572, 6);
    expect(m.placement).toMatchObject({ height: 2000, grid: { epsg: 2039, x: 280171.881, y: 813577.484 } });
    // Grid north on Mount Hermon is 0.36° east of true north.
    expect(m.placement.headingDeg).toBeCloseTo(0.3595, 3);
    expect(m.centre.lat).toBeCloseTo(33.4163, 6);
  });

  it("publishes a GLB with its own Earth position as it is, with no placement", async () => {
    // Haifa, in ECEF metres, as a CESIUM_RTC centre.
    const own = { ...triangle, extensionsUsed: ["CESIUM_RTC"], extensions: { CESIUM_RTC: { center: [4396858.842, 3077524.467, 3434781.512] } } };
    const ing = await upload([{ path: "port.glb", data: glb(own) }], { model });
    const done = await submitAndRun(ing.id);
    expect(done, JSON.stringify(done.report?.items)).toMatchObject({ state: "ready" });
    const m = (await app.inject(`/api/models/${done.modelId}`)).json();
    expect(m.placement).toBeUndefined();
    expect(m.source.georeferenced).toBe(true);
    expect(m.centre.lat).toBeCloseTo(32.79, 1);
  });
});
