import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySim,
  DEFAULTS,
  exifGps,
  fill,
  fitSimilarity,
  georeference,
  parseFrameScores,
  frameMotion,
  selectFrames,
  videoFrames,
  loadConfig,
  parseGnssCsv,
  parseSrt,
  positionAt,
  readImages,
  toEnu,
  toGeodetic,
  toEcef,
  transformModel,
  type Sim,
  type V3,
} from "../../../workers/holo-splat-worker.mjs";

// The splat training worker (workers/holo-splat-worker.mjs): its geometry and file readers.
// Real training needs a GPU and the upstream programs; these check what HOLO's own code does.

const rotZ = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a), Math.cos(a), 0],
    [0, 0, 1],
  ];
};
const rotX = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
};
const mul = (P: number[][], Q: number[][]) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => P[i]![0]! * Q[0]![j]! + P[i]![1]! * Q[1]![j]! + P[i]![2]! * Q[2]![j]!));
const known: Sim = { s: 3.7, R: mul(rotZ(35), rotX(-80)), t: [12, -40, 5] };
const inverse = (T: Sim): Sim => {
  const Rt = [0, 1, 2].map((i) => [0, 1, 2].map((j) => T.R[j]![i]!));
  const rt = [0, 1, 2].map((i) => Rt[i]![0]! * T.t[0] + Rt[i]![1]! * T.t[1] + Rt[i]![2]! * T.t[2]);
  return { s: 1 / T.s, R: Rt, t: rt.map((v) => -v / T.s) as V3 };
};

describe("similarity fit", () => {
  it("recovers scale, turn and shift from point pairs, and refuses points on one line", () => {
    const xs: V3[] = [[0, 0, 0], [1, 0, 0], [0, 2, 0], [1, 1, 3], [-2, 0.5, 1]];
    const T = fitSimilarity(xs, xs.map((p) => applySim(known, p)))!;
    expect(T.s).toBeCloseTo(3.7, 9);
    for (const p of xs) applySim(T, p).forEach((v, i) => expect(v).toBeCloseTo(applySim(known, p)[i]!, 8));
    expect(fitSimilarity([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]], [[0, 0, 0], [2, 2, 2], [4, 4, 4], [6, 6, 6]])).toBeNull();
    expect(fitSimilarity([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toBeNull();
  });
  it("goes from WGS 84 to east-north-up and back", () => {
    const o = { lat: 32.0853, lon: 34.7818, height: 30 };
    const enu = toEnu(o, 32.0862, 34.7829, 45);
    expect(enu[0]).toBeCloseTo(103.8, 0);
    expect(enu[1]).toBeCloseTo(99.8, 0);
    const g = toGeodetic(toEcef(32.0862, 34.7829, 45));
    expect(g.lat).toBeCloseTo(32.0862, 9);
    expect(g.lon).toBeCloseTo(34.7829, 9);
    expect(g.height).toBeCloseTo(45, 4);
  });
});

/** A JPEG with only an EXIF GPS block, as a camera writes it. */
function jpegWithGps(lat: number, lon: number, alt: number, le: boolean): Buffer {
  const t = Buffer.alloc(200);
  const w16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  t.write(le ? "II" : "MM", 0, "latin1");
  w16(42, 2);
  w32(8, 4);
  // IFD0: one entry, the GPS IFD pointer.
  w16(1, 8);
  w16(0x8825, 10), w16(4, 12), w32(1, 14), w32(26, 18);
  w32(0, 22);
  // GPS IFD at 26 with 6 entries; values from 100.
  w16(6, 26);
  const entry = (k: number, tag: number, type: number, count: number, value: number) => {
    const e = 28 + k * 12;
    w16(tag, e), w16(type, e + 2), w32(count, e + 4);
    if (type === 2 || type === 1) t[e + 8] = value;
    else w32(value, e + 8);
  };
  const dms = (v: number, at: number) => {
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = Math.round(((v - d) * 60 - m) * 60 * 10000);
    [d, 1, m, 1, s, 10000].forEach((x, i) => w32(x, at + i * 4));
  };
  entry(0, 1, 2, 2, lat < 0 ? 83 : 78);
  entry(1, 2, 5, 3, 100);
  entry(2, 3, 2, 2, lon < 0 ? 87 : 69);
  entry(3, 4, 5, 3, 124);
  entry(4, 5, 1, 1, 0);
  entry(5, 6, 5, 1, 148);
  dms(Math.abs(lat), 100);
  dms(Math.abs(lon), 124);
  w32(Math.round(alt * 100), 148), w32(100, 152);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xda, 0, 2])]);
}

describe("camera positions", () => {
  it("reads GPS from photo EXIF in either byte order", () => {
    for (const le of [true, false]) {
      const g = exifGps(jpegWithGps(32.08531, -34.78182, 61.25, le))!;
      expect(g.lat).toBeCloseTo(32.08531, 6);
      expect(g.lon).toBeCloseTo(-34.78182, 6);
      expect(g.height).toBeCloseTo(61.25, 6);
    }
    expect(exifGps(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(exifGps(Buffer.from("not a jpeg"))).toBeNull();
  });
  it("reads drone .SRT logs, camera-gnss.csv, and interpolates a frame's position", () => {
    const srt = `1\n00:00:00,000 --> 00:00:00,033\n[latitude: 32.100000] [longitude: 34.800000] [rel_alt: 50.0 abs_alt: 80.500]\n\n2\n00:00:01,000 --> 00:00:01,033\n[latitude: 32.100100] [longitude: 34.800200] [rel_alt: 50.0 abs_alt: 82.500]\n\n3\n00:00:02,000 --> 00:00:02,033\nGPS(34.8004,32.1002,84.5) HOME(0,0)\n`;
    const track = parseSrt(srt);
    expect(track).toHaveLength(3);
    expect(track[2]).toEqual({ t: 2, lon: 34.8004, lat: 32.1002, height: 84.5 });
    const p = positionAt(track, 0.5)!;
    expect(p.lat).toBeCloseTo(32.10005, 8);
    expect(p.height).toBeCloseTo(81.5, 8);
    expect(positionAt(track, 3)).toBeNull();
    const csv = parseGnssCsv("time_s,longitude,latitude,ellipsoidal_height_m\n0,34.8,32.1,100\n1,34.8001,32.1,101\n");
    expect(csv[1]).toEqual({ t: 1, lon: 34.8001, lat: 32.1, height: 101 });
    expect(() => parseGnssCsv("t,x,y\n0,1,2")).toThrow(/header/);
    expect(() => parseGnssCsv("time_s,longitude,latitude,ellipsoidal_height_m\n1,34,32,0\n1,34,32,0")).toThrow(/increase/);
  });
});

/** Writes a COLMAP binary model: cameras at given centres looking down, and a few 3D points. */
async function writeModel(dir: string, centres: V3[], points: V3[]) {
  const imgs: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(centres.length));
  centres.forEach((c, k) => {
    const name = Buffer.from(`frame_${String(k).padStart(6, "0")}.jpg\0`);
    const rec = Buffer.alloc(64 + name.length + 8 + 24);
    rec.writeUInt32LE(k + 1, 0);
    // A camera turned 180 degrees about x (looking down): q = (0, 1, 0, 0); t = -R c.
    [0, 1, 0, 0].forEach((v, i) => rec.writeDoubleLE(v, 4 + i * 8));
    const t = [-c[0], c[1], c[2]];
    t.forEach((v, i) => rec.writeDoubleLE(v, 36 + i * 8));
    rec.writeUInt32LE(1, 60);
    name.copy(rec, 64);
    rec.writeBigUInt64LE(1n, 64 + name.length);
    rec.writeDoubleLE(10, 64 + name.length + 8);
    rec.writeDoubleLE(20, 64 + name.length + 16);
    rec.writeBigInt64LE(-1n, 64 + name.length + 24);
    imgs.push(rec);
  });
  await writeFile(path.join(dir, "images.bin"), Buffer.concat([head, ...imgs]));
  const pts: Buffer[] = [];
  const ph = Buffer.alloc(8);
  ph.writeBigUInt64LE(BigInt(points.length));
  points.forEach((p, k) => {
    const rec = Buffer.alloc(51 + 8);
    rec.writeBigUInt64LE(BigInt(k + 1), 0);
    p.forEach((v, i) => rec.writeDoubleLE(v, 8 + i * 8));
    rec.writeUInt8(200, 32);
    rec.writeDoubleLE(0.5, 35);
    rec.writeBigUInt64LE(1n, 43);
    rec.writeUInt32LE(1, 51);
    rec.writeUInt32LE(0, 55);
    pts.push(rec);
  });
  await writeFile(path.join(dir, "points3D.bin"), Buffer.concat([ph, ...pts]));
}

describe("COLMAP model", () => {
  it("reads camera centres and moves the whole model by a similarity, keeping every projection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "viewer-colmap-"));
    const centres: V3[] = [[0, 0, 10], [5, 1, 10], [2, 7, 11]];
    const points: V3[] = [[1, 2, 0], [4, 4, 0.5]];
    await writeModel(dir, centres, points);
    const before = readImages(await readFile(path.join(dir, "images.bin")));
    expect(before.map((c) => c.name)).toEqual(["frame_000000.jpg", "frame_000001.jpg", "frame_000002.jpg"]);
    before.forEach((c, i) => c.centre.forEach((v, k) => expect(v).toBeCloseTo(centres[i]![k]!, 9)));

    transformModel(dir, known);
    const after = readImages(await readFile(path.join(dir, "images.bin")));
    after.forEach((c, i) => c.centre.forEach((v, k) => expect(v).toBeCloseTo(applySim(known, centres[i]!)[k]!, 6)));
    const pb = await readFile(path.join(dir, "points3D.bin"));
    const moved = [0, 1, 2].map((i) => pb.readDoubleLE(8 + 8 + i * 8));
    moved.forEach((v, k) => expect(v).toBeCloseTo(applySim(known, points[0]!)[k]!, 6));
    // A point seen by a camera projects to the same image direction before and after.
    const dir0 = (q: number[], t: number[], X: number[]) => {
      const [w, x, y, z] = q as [number, number, number, number];
      const R = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
      ];
      const c = [0, 1, 2].map((i) => R[i]![0]! * X[0]! + R[i]![1]! * X[1]! + R[i]![2]! * X[2]! + t[i]!);
      return [c[0]! / c[2]!, c[1]! / c[2]!];
    };
    const a = dir0(before[1]!.q, before[1]!.t, points[1]!);
    const b = dir0(after[1]!.q, after[1]!.t, applySim(known, points[1]!));
    expect(b[0]).toBeCloseTo(a[0]!, 9);
    expect(b[1]).toBeCloseTo(a[1]!, 9);
    await rm(dir, { recursive: true, force: true });
  });

  it("places a reconstruction from camera positions and checks it on cameras held back", () => {
    const origin = { lat: 31.7683, lon: 35.2137, height: 780 };
    // Camera centres in metres east, north and up, on a drone's lawnmower path.
    const enu: V3[] = [];
    for (let i = 0; i < 20; i++) enu.push([(i % 5) * 12, Math.floor(i / 5) * 15, 60 + (i % 3)]);
    const toModel = inverse(known);
    const cams = enu.map((p, i) => ({ name: `IMG_${i}.jpg`, centre: applySim(toModel, p) }));
    const fixes = new Map(
      enu.map((p, i) => {
        // ENU at the origin back to WGS 84, through Earth-centred coordinates.
        const o = toEcef(origin.lat, origin.lon, origin.height);
        const la = (origin.lat * Math.PI) / 180;
        const lo = (origin.lon * Math.PI) / 180;
        const e = [-Math.sin(lo), Math.cos(lo), 0];
        const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
        const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
        const x = [0, 1, 2].map((k) => o[k]! + e[k]! * p[0] + n[k]! * p[1] + u[k]! * p[2]) as V3;
        return [`IMG_${i}.jpg`, toGeodetic(x)];
      }),
    );
    const g = georeference(cams, fixes, "photo EXIF GPS");
    expect("georef" in g).toBe(true);
    if (!("georef" in g)) return;
    expect(g.georef.metresPerModelUnit).toBeCloseTo(known.s, 4);
    expect(g.georef.controls.count).toBe(16);
    expect(g.georef.checks!.count).toBe(4);
    expect(g.georef.checks!.horizontalRms).toBeLessThan(0.01);
    expect(g.georef.checks!.verticalRms).toBeLessThan(0.01);
    expect(georeference(cams.slice(0, 2), fixes, "x")).toEqual({ reason: expect.stringMatching(/at least 3/) });
  });
});

describe("video frames", () => {
  it("reads blur scores and times by frame number", () => {
    const text = "frame:0    pts:0       pts_time:0\nlavfi.blurdetect.blur=5.2\nframe:1    pts:512     pts_time:0.0333\nlavfi.blurdetect.blur=2.1\n";
    const r = parseFrameScores(text);
    expect([...r.blur.entries()]).toEqual([[0, 5.2], [1, 2.1]]);
    expect(r.times).toEqual([0, 0.0333]);
  });

  it("measures a pan and a forward move, and ignores a blank area", () => {
    const W = 192, H = 108;
    // Texture that is smooth enough to match: a sum of sines.
    const tex = (x: number, y: number) => 128 + 60 * Math.sin(x * 0.31) * Math.cos(y * 0.23) + 40 * Math.sin((x + 2 * y) * 0.17);
    const img = (f: (x: number, y: number) => number) => Uint8Array.from({ length: W * H }, (_, i) => f(i % W, Math.floor(i / W)));
    const a = img(tex);
    expect(frameMotion(a, img((x, y) => tex(x - 4, y)), W, H)).toBeCloseTo(4, 0);
    // Zoom by 5% about the centre: shifts grow towards the edges.
    const zoom = frameMotion(a, img((x, y) => tex(96 + (x - 96) / 1.05, 54 + (y - 54) / 1.05)), W, H);
    expect(zoom).toBeGreaterThan(1.5);
    expect(zoom).toBeLessThan(6);
    const blank = new Uint8Array(W * H).fill(90);
    expect(frameMotion(blank, blank, W, H)).toBe(0);
  });

  it("keeps the sharpest frame near each point the view had moved enough, and fills long gaps", () => {
    const blur = new Map(Array.from({ length: 60 }, (_, i) => [i, i === 11 ? 1 : 3]));
    // Moved enough at 0, 10, 12, 14, then nothing until 50.
    expect(selectFrames([0, 10, 12, 14, 50], 60, blur, { maxGap: 15 })).toEqual([0, 11, 12, 14, 29, 44, 50]);
    // A camera standing still still gives one frame per maxGap.
    expect(selectFrames([0], 46, new Map(), { maxGap: 15 })).toEqual([0, 15, 30, 45]);
  });

  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("takes frames from a real video densely while it pans", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vf-"));
    const video = path.join(dir, "pan.mp4");
    // 2 s panning 300 px/s, then 2 s still on a plain colour.
    spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1600x360:r=30,crop=640:360:t*300:0", "-t", "2", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30", "-t", "2", "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", video]);
    const out = await videoFrames(loadConfig(path.join(dir, "none.json")), video, path.join(dir, "images"), { resolution: 640, videoFps: 2 });
    const pan = out.filter((f) => f.time < 2);
    const still = out.filter((f) => f.time >= 2.05);
    expect(pan.length).toBeGreaterThan(20);
    expect(still.length).toBeLessThanOrEqual(5);
    expect(readdirSync(path.join(dir, "images")).length).toBe(out.length);
  }, 60_000);
});

describe("training commands", () => {
  it("fills placeholders into whole arguments, never splitting or interpreting them", () => {
    const argv = fill(DEFAULTS.methods.opensplat!.train, { program: "/opt/opensplat/opensplat", data: "/srv/w/my data; rm -rf /", iterations: 7000, shDegree: 1, train: "/srv/w/train" });
    expect(argv).toEqual(["/opt/opensplat/opensplat", "/srv/w/my data; rm -rf /", "-n", "7000", "--sh-degree", "1", "-o", "/srv/w/train/splats.ply"]);
  });
});

describe("satellite views through EOGS++", () => {
  const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
  const bridge = path.resolve(__dirname, "../../../workers/eogs/holo_eogs.py");

  it("runs the bridge with its default command and hands over the splats, georef.json and the view count", async () => {
    // A copy of the worker with its own holo-worker.json; a stand-in bridge (Node) plays EOGS++.
    const dir = await mkdtemp(path.join(tmpdir(), "holo-eogs-"));
    try {
      const worker = path.join(dir, "holo-splat-worker.mjs");
      await writeFile(worker, await readFile(path.resolve(__dirname, "../../../workers/holo-splat-worker.mjs")));
      await writeFile(path.join(dir, "holo-worker.json"), JSON.stringify({ methods: { "eogs-plus": { python: process.execPath, repo: dir } } }));
      await mkdir(path.join(dir, "eogs"));
      await writeFile(
        path.join(dir, "eogs", "holo_eogs.py"),
        `const fs = require("node:fs"), p = require("node:path");
const a = process.argv.slice(2), get = (k) => a[a.indexOf(k) + 1];
if (a[0] === "check") { console.log("EOGS++ test"); process.exit(0); }
const train = get("--train");
fs.writeFileSync(p.join(train, "args.json"), JSON.stringify(a));
console.log("Training progress: 50%| " + (Number(get("--iterations")) / 2) + "/" + get("--iterations"));
fs.writeFileSync(p.join(train, "splats.ply"), "ply\\n");
fs.writeFileSync(p.join(train, "georef.json"), JSON.stringify({ frame: "enu", origin: { lat: 32, lon: 34, height: 40 } }));
fs.writeFileSync(p.join(train, "holo-eogs.json"), JSON.stringify({ views: 3 }));
`,
      );
      const input = path.join(dir, "capture");
      await mkdir(input);
      for (const n of ["a.tif", "b.tif", "c.tif", "d.ntf"]) await writeFile(path.join(input, n), "x");
      const output = path.join(dir, "job", "out");
      const r = spawnSync(process.execPath, [worker, "--method", "eogs-plus", "--input", input, "--input-kind", "satellite", "--goal", "satellite", "--output", output, "--iterations", "7000", "--max-splats", "1000000", "--resolution", "1280", "--sh-degree", "0", "--video-fps", "2", "--threads", "4"], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("progress 0.475 train");
      const args = JSON.parse(await readFile(path.join(dir, "job", "work", "train", "args.json"), "utf8"));
      expect(args).toEqual(["run", "--eogs", dir, "--data", input, "--train", path.join(dir, "job", "work", "train"), "--iterations", "7000", "--max-size", "1280"]);
      expect(readdirSync(output).sort()).toEqual(["georef.json", "provenance.json", "splats.ply"]);
      const prov = JSON.parse(await readFile(path.join(output, "provenance.json"), "utf8"));
      expect(prov).toMatchObject({ tool: "eogs-plus", version: "EOGS++ test", frames: 4, registeredViews: 3 });
      expect(prov.georefNote).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)("changes EOGS++ only where its text is exactly as expected, once, and can undo it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "holo-eogs-repo-"));
    try {
      const patches = JSON.parse(spawnSync(python!, ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.dirname(bridge))}); import holo_eogs as h; print(json.dumps(h.PATCHES))`], { encoding: "utf8" }).stdout) as [string, string, string][];
      const files = new Map<string, string>();
      for (const [rel, old] of patches) files.set(rel, `${files.get(rel) ?? "# upstream\n"}${old}# more\n`);
      for (const [rel, text] of files) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), text);
      }
      const patch = (...extra: string[]) => spawnSync(python!, [bridge, "patch", "--eogs", dir, ...extra], { encoding: "utf8" });
      expect(patch().status).toBe(0);
      const once = new Map<string, string>();
      for (const rel of files.keys()) once.set(rel, await readFile(path.join(dir, rel), "utf8"));
      for (const [rel, , now] of patches) expect(once.get(rel)).toContain(now);
      expect(patch().status).toBe(0);
      for (const rel of files.keys()) expect(await readFile(path.join(dir, rel), "utf8")).toBe(once.get(rel));
      expect(patch("--undo").status).toBe(0);
      for (const [rel, text] of files) expect(await readFile(path.join(dir, rel), "utf8")).toBe(text);
      // Another release: one file differs, so nothing at all is changed.
      const [firstRel] = files.keys();
      await writeFile(path.join(dir, firstRel!), "# someone else's version\n");
      const refused = patch();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("nothing was changed");
      for (const [rel, text] of files) if (rel !== firstRel) expect(await readFile(path.join(dir, rel), "utf8")).toBe(text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
