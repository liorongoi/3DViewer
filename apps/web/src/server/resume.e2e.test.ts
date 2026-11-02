// @vitest-environment node
/**
 * AC-07, WP 3.2: a 1.5 GB upload resumes after the connection is cut at 50%.
 *
 * Runs the real server (apps/server/dist, build it first) and the web app's own upload code.
 * Halfway through, the server is killed outright, which drops every connection, and started
 * again; the client must carry on from the server's offset, re-send at most what was in
 * flight, and the model must publish. It writes about 3 GB to a temporary folder.
 *
 *   pnpm --filter @viewer/server build
 *   E2E_RESUME=1 pnpm --filter @viewer/web exec vitest run src/server/resume.e2e.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { LocalFile } from "@viewer/core";
import { uploadAndIngest, type ServerInfo } from "./api";

const SIZE = 1.5 * 1024 ** 3;
const CHUNK = 8 * 1024 * 1024;
const server = fileURLToPath(new URL("../../../server/dist/main.js", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "ac07-"));
const port = 8900 + Math.floor(Math.random() * 90);
const srv: ServerInfo = { base: `http://127.0.0.1:${port}`, db: "" };
let proc: ChildProcess | null = null;

/** A valid GLB of `size` bytes: one triangle, and a buffer padded out with zeros (a sparse file). */
function bigGlb(file: string, size: number): void {
  const text = (binLen: number) =>
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: "Big site" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: binLen }],
    });
  // The JSON chunk is padded to a fixed 1 KB so the binary length is known before writing it.
  const J = 1024;
  const binLen = size - 12 - 8 - J - 8;
  const json = Buffer.from(text(binLen).padEnd(J, " "));
  const head = Buffer.alloc(12 + 8 + J + 8 + 36);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(size, 8);
  head.writeUInt32LE(J, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  json.copy(head, 20);
  head.writeUInt32LE(binLen, 20 + J);
  head.writeUInt32LE(0x004e4942, 24 + J);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(head, 28 + J);
  const fd = openSync(file, "w");
  writeSync(fd, head);
  ftruncateSync(fd, size);
  closeSync(fd);
}

/** A file on disk, read a slice at a time, as the browser's File is. */
function diskFile(file: string, name: string, size: number): LocalFile {
  return {
    path: name,
    size,
    bytes: async () => {
      throw new Error("The upload must read slices, not the whole file.");
    },
    slice: async (start, end) => {
      const buf = new Uint8Array(end - start);
      const fd = openSync(file, "r");
      try {
        readSync(fd, buf, 0, buf.length, start);
      } finally {
        closeSync(fd);
      }
      return buf;
    },
  };
}

async function start(): Promise<void> {
  proc = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, "data"), SEED_SAMPLES: "0" }, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr!.on("data", (d: Buffer) => process.stderr.write(`server: ${d}`));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${srv.base}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The server did not start.");
}

afterAll(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.env.E2E_RESUME === "1")("AC-07: resume after a cut", () => {
  it("uploads 1.5 GB, survives the server dying at 50%, and publishes", async () => {
    const file = path.join(dir, "big-site.glb");
    bigGlb(file, SIZE);
    await start();

    // After the cut, note where the first accepted chunk starts: the server's offset, not 0.
    let resumedFrom = -1;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await realFetch(input, init);
      if (cut && resumedFrom < 0 && init?.method === "PATCH" && r.ok) resumedFrom = Number((init.headers as Record<string, string>)["upload-offset"]);
      return r;
    }) as typeof fetch;

    let cut = false;
    let cutAt = 0;
    const t0 = Date.now();
    const status = await uploadAndIngest(srv, [diskFile(file, "big-site.glb", SIZE)], {
      model: { name: "Big site", status: "draft", classificationId: "unclassified" },
      placement: { lat: 32.08, lon: 34.78, height: 0, aboveGround: 0 },
    }, (p) => {
      if (!cut && p.step === "upload" && p.sent >= p.total / 2) {
        cut = true;
        cutAt = p.sent;
        // Kill the server outright: every connection drops mid-transfer. Back after 3 s.
        proc!.kill("SIGKILL");
        setTimeout(() => void start(), 3000);
      }
    });
    globalThis.fetch = realFetch;
    const seconds = (Date.now() - t0) / 1000;
    console.log(`AC-07: ${(SIZE / 1024 ** 3).toFixed(1)} GB in ${seconds.toFixed(0)} s, cut at ${((cutAt / SIZE) * 100).toFixed(1)}%, resumed at ${((resumedFrom / SIZE) * 100).toFixed(1)}%`);

    expect(cut).toBe(true);
    expect(status, status.error ?? "").toMatchObject({ state: "ready", version: 1 });
    expect(status.upload.received).toBe(SIZE);
    // It carried on from what the server had: at most the chunk in flight is sent again.
    expect(resumedFrom).toBeGreaterThanOrEqual(cutAt - CHUNK);
  }, 30 * 60_000);
});
