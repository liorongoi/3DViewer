import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addonParts, cleanRequest, currentAddon, readAddon, startBuild, verifySums, workerConfig } from "./local-build.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "holo-build-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in add-on: this test's Node.js runs a small worker that reports progress and writes a PLY. */
function fakeAddon(worker = FAKE_WORKER): string {
  const dir = path.join(tmp(), "holo-building-1.3.0-windows-x64");
  const p = addonParts(dir);
  for (const f of [p.python, p.ffmpeg, p.brush, p.worker]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
  }
  fs.mkdirSync(path.dirname(p.node), { recursive: true });
  // A link where it can be; Windows needs a copy (links there need special rights).
  if (process.platform === "win32") fs.copyFileSync(process.execPath, p.node);
  else fs.symlinkSync(process.execPath, p.node);
  fs.writeFileSync(p.worker, worker);
  fs.writeFileSync(path.join(dir, "VERSION"), "holo-building 1.3.0 windows-x64\nnode v26\n");
  const sums = ["VERSION", "worker/holo-splat-worker.mjs"].map((f) => `${createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")}  ./${f}`);
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  return dir;
}

const FAKE_WORKER = `
import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
const out = arg("--output");
console.log("progress 0.100 frames");
if (!fs.readdirSync(arg("--input")).length) { console.error("The capture has no video."); process.exit(2); }
if (a[0] === "--assess") { fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ verdict: "good", items: [] })); process.exit(0); }
console.log("progress 0.500 train");
fs.writeFileSync(path.join(out, "splats.ply"), "ply");
fs.writeFileSync(path.join(out, "provenance.json"), JSON.stringify({ config: process.env.HOLO_WORKER_CONFIG ? "set" : "missing", secret: process.env.HOLO_TEST_SECRET ?? null }));
console.log("progress 1.000 done");
`;

describe("the building add-on", () => {
  it("is read only when it is complete", () => {
    const dir = fakeAddon();
    expect(readAddon(dir)).toEqual({ dir, version: "1.3.0" });
    fs.rmSync(addonParts(dir).brush);
    expect(readAddon(dir)).toBeNull();
    expect(readAddon(path.join(dir, "nope"))).toBeNull();
  });

  it("is the one building.json names", () => {
    const dir = fakeAddon();
    const data = tmp();
    expect(currentAddon(data)).toBeNull();
    fs.writeFileSync(path.join(data, "building.json"), JSON.stringify({ dir }));
    expect(currentAddon(data)?.version).toBe("1.3.0");
  });

  it("is checked file by file, and may not name files outside it", async () => {
    const dir = fakeAddon();
    expect(await verifySums(dir)).toBeNull();
    fs.appendFileSync(addonParts(dir).worker, "// changed");
    expect(await verifySums(dir)).toMatch(/damaged/);
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${"0".repeat(64)}  ../outside\n`);
    expect(await verifySums(dir)).toMatch(/outside/);
    fs.rmSync(path.join(dir, "SHA256SUMS"));
    expect(await verifySums(dir)).toMatch(/no SHA256SUMS/);
  });

  it("gives the worker its own programs and the detector when it has one", () => {
    const dir = fakeAddon();
    const cfg = workerConfig({ dir, version: "1.3.0" });
    expect(cfg).toMatchObject({ sfm: "pycolmap", sfmGpu: false, methods: { brush: { program: addonParts(dir).brush, revision: "1.3.0" } } });
    expect(cfg.masks).toBeUndefined();
    fs.mkdirSync(path.join(dir, "models"));
    fs.writeFileSync(addonParts(dir).masks, "");
    expect(workerConfig({ dir, version: "1.3.0" }).masks).toBe(addonParts(dir).masks);
  });
});

describe("a build request", () => {
  it("holds every number to a sane range and the name to a safe folder name", () => {
    const r = cleanRequest({ name: '..\\..\\evil:<name>?', iterations: 1e9, maxSplats: -5, resolution: Number.NaN, shDegree: 9, videoFps: 0, threads: 1e6, inputKind: "satellite" as never, checkOnly: "yes" as never }, ["a.mp4"]);
    expect(r.name).not.toMatch(/[\\/:<>?]/);
    expect(r).toMatchObject({ inputKind: "video", checkOnly: false, iterations: 60_000, maxSplats: 100_000, resolution: 1600, shDegree: 3, videoFps: 1 });
    expect(r.threads).toBeLessThanOrEqual(os.availableParallelism());
    expect(cleanRequest({ name: "   " }, []).name).toBe("Splat");
  });
});

describe("a build", () => {
  const request = (files: string[], checkOnly = false) => cleanRequest({ name: "Garage", inputKind: "video", checkOnly }, files);

  it("runs the worker, reports progress, and leaves the splats in the builds folder", async () => {
    const dir = fakeAddon();
    const video = path.join(tmp(), "walk.mp4");
    fs.writeFileSync(video, "video");
    const work = tmp();
    const outRoot = path.join(tmp(), "HOLO builds");
    const seen: string[] = [];
    process.env.HOLO_TEST_SECRET = "do not pass";
    try {
      const r = await startBuild({ dir, version: "1.3.0" }, request([video]), work, outRoot, (p) => seen.push(p.stage)).done;
      expect(r.ok).toBe(true);
      expect(seen).toEqual(["frames", "train", "done"]);
      expect(fs.readFileSync(r.file!, "utf8")).toBe("ply");
      expect(path.dirname(r.file!)).toBe(r.folder);
      expect(r.folder!.startsWith(outRoot)).toBe(true);
      // Only what the tools need reaches the worker.
      expect(JSON.parse(fs.readFileSync(path.join(r.folder!, "provenance.json"), "utf8"))).toEqual({ config: "set", secret: null });
    } finally {
      delete process.env.HOLO_TEST_SECRET;
    }
    // The user's file is untouched and the build's own folder is gone.
    expect(fs.readFileSync(video, "utf8")).toBe("video");
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it("returns the check's report", async () => {
    const dir = fakeAddon();
    const video = path.join(tmp(), "walk.mp4");
    fs.writeFileSync(video, "video");
    const r = await startBuild({ dir, version: "1.3.0" }, request([video], true), tmp(), tmp(), () => undefined).done;
    expect(r).toEqual({ ok: true, report: { verdict: "good", items: [] } });
  });

  it("says why it did not work, in the worker's words", async () => {
    const dir = fakeAddon();
    const r = await startBuild({ dir, version: "1.3.0" }, request([]), tmp(), tmp(), () => undefined).done;
    expect(r).toEqual({ ok: false, reason: "The capture has no video." });
  });

  it("says to update the driver when Brush finds no graphics card", async () => {
    const dir = fakeAddon("console.error(\"panicked: No possible adapter available for backend.\"); process.exit(101);");
    const video = path.join(tmp(), "walk.mp4");
    fs.writeFileSync(video, "video");
    const r = await startBuild({ dir, version: "1.3.0" }, request([video]), tmp(), tmp(), () => undefined).done;
    expect(r.reason).toMatch(/Update the NVIDIA driver/);
  });

  it("stops when asked", async () => {
    const dir = fakeAddon("setTimeout(() => {}, 60000); console.log('progress 0.100 frames');");
    const video = path.join(tmp(), "walk.mp4");
    fs.writeFileSync(video, "video");
    const run = startBuild({ dir, version: "1.3.0" }, request([video]), tmp(), tmp(), () => run.stop());
    expect(await run.done).toEqual({ ok: false, stopped: true });
  });
});
