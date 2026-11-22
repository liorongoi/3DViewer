import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySim,
  blockShifts,
  controlPlacement,
  judgePoses,
  judgeVideo,
  parseMediaInfo,
  sharpness,
  timeRanges,
  verdictOf,
  DEFAULTS,
  pixelRay,
  exifGps,
  exportStep,
  fill,
  fitSimilarity,
  georeference,
  parseFrameScores,
  frameMotion,
  jpegSplitter,
  levelTransform,
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

  it("moves the frame poses of a COLMAP 3.12+ model too, which is what newer readers use", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "viewer-colmap-"));
    const centres: V3[] = [[0, 0, 10], [5, 1, 10], [2, 7, 11]];
    await writeModel(dir, centres, [[1, 2, 0]]);
    // frames.bin as pycolmap 3.13 writes it: id, rig id, rig-from-world (q, t), then data ids.
    const frames = Buffer.alloc(8 + centres.length * (68 + 16));
    frames.writeBigUInt64LE(BigInt(centres.length));
    centres.forEach((c, k) => {
      const o = 8 + k * 84;
      frames.writeUInt32LE(k + 1, o);
      frames.writeUInt32LE(1, o + 4);
      [0, 1, 0, 0].forEach((v, i) => frames.writeDoubleLE(v, o + 8 + i * 8));
      [-c[0], c[1], c[2]].forEach((v, i) => frames.writeDoubleLE(v, o + 40 + i * 8));
      frames.writeUInt32LE(1, o + 64);
      frames.writeUInt32LE(0, o + 68);
      frames.writeUInt32LE(1, o + 72);
      frames.writeBigUInt64LE(BigInt(k + 1), o + 76);
    });
    await writeFile(path.join(dir, "frames.bin"), frames);
    transformModel(dir, known);
    const images = readImages(await readFile(path.join(dir, "images.bin")));
    const fb = await readFile(path.join(dir, "frames.bin"));
    images.forEach((im, k) => {
      const o = 8 + k * 84;
      [0, 1, 2, 3].forEach((i) => expect(fb.readDoubleLE(o + 8 + i * 8)).toBeCloseTo(im.q[i]!, 12));
      [0, 1, 2].forEach((i) => expect(fb.readDoubleLE(o + 40 + i * 8)).toBeCloseTo(im.t[i]!, 9));
      expect(fb.readBigUInt64LE(o + 76)).toBe(BigInt(k + 1));
    });
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

describe("levelling a model with no placement", () => {
  type M = [V3, V3, V3];
  const norm = (v: V3): V3 => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const mv = (m: M, v: V3): V3 => [0, 1, 2].map((i) => m[i]![0] * v[0] + m[i]![1] * v[1] + m[i]![2] * v[2]) as V3;
  const mt = (m: M): M => [0, 1, 2].map((i) => [m[0][i]!, m[1][i]!, m[2][i]!]) as M;
  const mm = (a: M, b: M): M => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0][j]! + a[i]![1] * b[1][j]! + a[i]![2] * b[2][j]!)) as M;
  const quat = (R: M): number[] => {
    // Shepperd: any rotation matrix to (w, x, y, z).
    const tr = R[0][0] + R[1][1] + R[2][2];
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      return [s / 4, (R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s];
    }
    if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
      const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
      return [(R[2][1] - R[1][2]) / s, s / 4, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s];
    }
    if (R[1][1] > R[2][2]) {
      const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
      return [(R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, s / 4, (R[1][2] + R[2][1]) / s];
    }
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    return [(R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, s / 4];
  };
  // A turn of `deg` about `axis`, the way pose software leaves a scene.
  const turn = (axis: V3, deg: number): M => {
    const [x, y, z] = norm(axis);
    const c = Math.cos((deg * Math.PI) / 180);
    const s = Math.sin((deg * Math.PI) / 180);
    const C = 1 - c;
    return [
      [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
      [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
      [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ];
  };
  // Cameras in a world with up = +z, held level (no roll), then the world turned by Q.
  const cameras = (Q: M, look: (i: number) => V3, roll = (_i: number) => 0) =>
    Array.from({ length: 40 }, (_, i) => {
      const fwd = norm(look(i));
      const ref: V3 = Math.abs(fwd[2]) > 0.99 ? [Math.cos(i), Math.sin(i), 0] : [0, 0, 1];
      let x = norm(cross(fwd, ref));
      if (Math.abs(fwd[2]) > 0.99) x = norm(cross(fwd, [0, 0, 1]).some((v) => Math.abs(v) > 1e-9) ? cross(fwd, [0, 0, 1]) : [Math.cos(i), Math.sin(i), 0]);
      const r = (roll(i) * Math.PI) / 180;
      const y0 = cross(fwd, x);
      x = norm([x[0] * Math.cos(r) + y0[0] * Math.sin(r), x[1] * Math.cos(r) + y0[1] * Math.sin(r), x[2] * Math.cos(r) + y0[2] * Math.sin(r)]);
      const y = cross(fwd, x);
      const Rc: M = [x, y, fwd];
      const centre: V3 = [Math.cos(i / 6) * 8, Math.sin(i / 6) * 5, 1.6];
      return { q: quat(mm(Rc, mt(Q))), centre: mv(Q, centre) };
    });
  const upAfter = (T: Sim, Q: M) => norm(mv(T.R as M, mv(Q, [0, 0, 1])));

  it("turns a walk-through so that up is the viewer's up (COLMAP −y), keeping the heading", () => {
    const Q = turn([0.3, 1, 0.2], 37);
    const cams = cameras(Q, (i) => [Math.cos(i / 5), Math.sin(i / 5), 0.15 * Math.sin(i)], (i) => 3 * Math.sin(i * 1.7));
    const l = levelTransform(cams);
    if (!l.T) throw new Error(l.reason);
    const up = upAfter(l.T, Q);
    expect((Math.acos(Math.min(1, -up[1])) * 180) / Math.PI).toBeLessThan(1);
    expect(l.tiltDeg).toBeGreaterThan(30);
    // The cameras' middle is at the origin.
    const mid = [0, 1, 2].map((k) => cams.reduce((a, c) => a + applySim(l.T, c.centre)[k]!, 0) / cams.length);
    mid.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-9));
  });

  it("levels a drone's straight-down survey from the view direction", () => {
    const Q = turn([1, 0, 0.4], 15);
    const l = levelTransform(cameras(Q, () => [0, 0, -1]));
    const up = upAfter(l.T!, Q);
    expect(-up[1]).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
  });

  it("leaves a model alone when the cameras were turned every way", () => {
    const l = levelTransform(cameras(turn([0, 0, 1], 0), (i) => [Math.cos(i * 2.4), Math.sin(i * 1.3), Math.cos(i * 0.7)], (i) => (i * 47) % 360));
    expect(l.reason).toMatch(/which way is up/);
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

  it("cuts a JPEG stream into whole pictures however the pipe splits it", () => {
    // Two JPEGs; the first holds an EXIF thumbnail (its own FF D8 ... FF D9) and a stuffed FF 00.
    const a = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd8, 1, 0xff, 0xd9, 0xff, 0xda, 7, 0xff, 0x00, 8, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xda, 9, 0xff, 0xff, 0xd9]);
    const stream = Buffer.concat([a, b]);
    for (let cut = 1; cut < stream.length; cut++) {
      const got: [number, string][] = [];
      const feed = jpegSplitter((jpg, n) => got.push([n, jpg.toString("hex")]));
      feed(stream.subarray(0, cut));
      feed(stream.subarray(cut));
      expect(got, `cut at ${cut}`).toEqual([
        [0, a.toString("hex")],
        [1, b.toString("hex")],
      ]);
    }
  });

  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("writes hundreds of picked frames, each the frame it is named after", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vf-"));
    const video = path.join(dir, "long.mp4");
    // 12 s of fast motion at 30 fps: nearly every frame is picked (the old select list broke here).
    spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=3200x240:r=30,crop=320:240:t*240:0", "-t", "12", "-pix_fmt", "yuv420p", video]);
    const out = await videoFrames({ ...loadConfig(path.join(dir, "none.json")), frameStep: 0.001 }, video, path.join(dir, "images"), { resolution: 320, videoFps: 2 });
    expect(out.length).toBeGreaterThan(300);
    // A picked frame equals the same frame decoded on its own.
    const pick = out[Math.floor(out.length / 2)]!;
    const n = Number(/frame_(\d+)/.exec(pick.name)![1]);
    const grey = async (input: string, select: string | null, name: string) => {
      const f = path.join(dir, name);
      spawnSync("ffmpeg", ["-loglevel", "error", "-i", input, "-vf", `${select ? `select=eq(n\\,${select}),` : ""}format=gray`, "-frames:v", "1", "-fps_mode", "passthrough", f]);
      return readFile(f);
    };
    const meanDiff = (x: Buffer, y: Buffer) => {
      let d = 0;
      for (let i = 20; i < x.length; i++) d += Math.abs(x[i]! - y[i]!);
      return d / x.length;
    };
    const kept = await grey(path.join(dir, "images", pick.name), null, "kept.pgm");
    const same = meanDiff(kept, await grey(video, String(n), "same.pgm"));
    const next = meanDiff(kept, await grey(video, String(n + 1), "next.pgm"));
    expect(same).toBeLessThan(next / 3);
  }, 120_000);
});

describe("training commands", () => {
  it("has Brush export about every twentieth of the run, ending on the last step", () => {
    expect([7000, 15000, 30000, 1234].map(exportStep)).toEqual([350, 750, 1500, 617]);
    for (const n of [7000, 15000, 30000, 1234, 997]) expect(n % exportStep(n)).toBe(0);
  });
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

describe("surveyed ground control points", () => {
  // A small rotation matrix and its quaternion (w, x, y, z), as COLMAP stores camera poses.
  const lookAt = (c: V3, target: V3): number[][] => {
    const z = target.map((v, i) => v - c[i]!);
    const n = Math.hypot(...z);
    const zz = z.map((v) => v / n);
    let x = [zz[1]! * 1 - zz[2]! * 0, zz[2]! * 0 - zz[0]! * 1, 0];
    const xn = Math.hypot(...x);
    x = x.map((v) => v / xn);
    const y = [zz[1]! * x[2]! - zz[2]! * x[1]!, zz[2]! * x[0]! - zz[0]! * x[2]!, zz[0]! * x[1]! - zz[1]! * x[0]!];
    return [x, y, zz];
  };
  const quat = (R: number[][]): number[] => {
    const w = Math.sqrt(Math.max(0, 1 + R[0]![0]! + R[1]![1]! + R[2]![2]!)) / 2;
    return [w, (R[2]![1]! - R[1]![2]!) / (4 * w), (R[0]![2]! - R[2]![0]!) / (4 * w), (R[1]![0]! - R[0]![1]!) / (4 * w)];
  };
  // An OPENCV camera with real lens distortion: fx, fy, cx, cy, k1, k2, p1, p2.
  const cam = { model: 4, width: 4000, height: 3000, params: [3000, 3010, 2001, 1498, -0.12, 0.05, 0.001, -0.0007] };
  const project = (R: number[][], c: V3, X: V3): [number, number] => {
    const d = [X[0] - c[0], X[1] - c[1], X[2] - c[2]];
    const p = R.map((r) => r[0]! * d[0]! + r[1]! * d[1]! + r[2]! * d[2]!);
    const u = p[0]! / p[2]!;
    const v = p[1]! / p[2]!;
    const [fx, fy, cx, cy, k1, k2, p1, p2] = cam.params as [number, number, number, number, number, number, number, number];
    const r2 = u * u + v * v;
    const rad = 1 + k1 * r2 + k2 * r2 * r2;
    const ud = u * rad + 2 * p1 * u * v + p2 * (r2 + 2 * u * u);
    const vd = v * rad + 2 * p2 * u * v + p1 * (r2 + 2 * v * v);
    return [fx * ud + cx, fy * vd + cy];
  };

  it("undoes the lens distortion of a pixel", () => {
    const [px, py] = project([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], [0.31, -0.22, 1]);
    const ray = pixelRay(cam, px, py)!;
    expect(ray[0]).toBeCloseTo(0.31, 9);
    expect(ray[1]).toBeCloseTo(-0.22, 9);
  });

  it("places a model from points surveyed on the ground, with leave-one-out checks", () => {
    // The model's frame: the ground turned, shrunk to a third and moved, as pose software leaves it.
    const truth: Sim = { s: 3, R: [[0, -1, 0], [0.6, 0, -0.8], [0.8, 0, 0.6]], t: [12, -4, 30] };
    const origin = { lat: 31.77, lon: 35.21, height: 760 };
    const enuPts: V3[] = [[-20, -15, 0.4], [25, -18, 1.2], [22, 20, -0.3], [-18, 24, 2.1], [2, 3, 6.5]];
    // Model coordinates of a ground point: the inverse of the truth.
    const inv = (y: V3): V3 => {
      const d = [y[0] - truth.t[0], y[1] - truth.t[1], y[2] - truth.t[2]];
      return [0, 1, 2].map((i) => (truth.R[0]![i]! * d[0]! + truth.R[1]![i]! * d[1]! + truth.R[2]![i]! * d[2]!) / truth.s) as V3;
    };
    const ground = enuPts;
    // Survey positions of the points, from their east-north-up offsets around the origin.
    const surveyed = ground.map((e) => {
      const o = toEcef(origin.lat, origin.lon, origin.height);
      const p = (origin.lat * Math.PI) / 180;
      const l = (origin.lon * Math.PI) / 180;
      const ecef: V3 = [
        o[0] - Math.sin(l) * e[0] - Math.sin(p) * Math.cos(l) * e[1] + Math.cos(p) * Math.cos(l) * e[2],
        o[1] + Math.cos(l) * e[0] - Math.sin(p) * Math.sin(l) * e[1] + Math.cos(p) * Math.sin(l) * e[2],
        o[2] + Math.cos(p) * e[1] + Math.sin(p) * e[2],
      ];
      return toGeodetic(ecef);
    });
    const centres: V3[] = [0, 1, 2, 3, 4, 5].map((k) => {
      const a = (2 * Math.PI * k) / 6;
      return inv([40 * Math.cos(a), 40 * Math.sin(a), 25]);
    });
    const middle = inv([0, 0, 0]);
    const images = centres.map((c, k) => {
      const R = lookAt(c, middle);
      return { name: `IMG_${k}.JPG`, q: quat(R), centre: c, cameraId: 1, R };
    });
    const points = surveyed.map((g, j) => ({
      name: `gcp${j}`,
      lat: g.lat,
      lon: g.lon,
      height: g.height,
      observations: images.map((im) => {
        const [x, y] = project(im.R, im.centre, inv(ground[j]!));
        return { image: im.name, x, y };
      }),
    }));
    const got = controlPlacement(images, new Map([[1, cam]]), { crs: "EPSG:2039", points });
    if ("reason" in got) throw new Error(got.reason);
    expect(got.georef.source).toBe("surveyed ground control points (5)");
    expect(got.georef.metresPerModelUnit).toBeCloseTo(3, 4);
    expect(got.georef.controls.horizontalRms).toBeLessThan(0.002);
    expect(got.georef.checks!.count).toBe(5);
    expect(got.georef.checks!.horizontalRms).toBeLessThan(0.002);
    // A model point goes to where it was surveyed.
    const back = applySim(got.T, inv(ground[2]!));
    const want = toEnu(got.georef.origin, surveyed[2]!.lat, surveyed[2]!.lon, surveyed[2]!.height);
    expect(Math.hypot(back[0] - want[0], back[1] - want[1], back[2] - want[2])).toBeLessThan(0.002);
  });

  it("says why when too few points are seen twice", () => {
    const got = controlPlacement([], new Map(), { crs: "EPSG:4326", points: [{ name: "a", lat: 0, lon: 0, height: 0, observations: [{ image: "x.jpg", x: 1, y: 1 }] }] });
    expect("reason" in got && got.reason).toMatch(/Only 0 ground control points/);
  });
});

describe("checking a capture before building", () => {
  // A textured grey picture, moved by (dx, dy) pixels.
  const tex = (w: number, h: number, dx = 0, dy = 0) => {
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (Math.sin((x - dx) * 0.9) * Math.cos((y - dy) * 0.7) * 60 + ((((x - dx) * 7919) ^ ((y - dy) * 104729)) & 63) + 100) & 255;
    return g;
  };
  const shiftAll = (dx: number, dy = 0) => Array.from({ length: 40 }, (_, i) => ({ x: (i % 8) * 16 + 14, y: Math.floor(i / 8) * 16 + 14, dx, dy }));
  const sample = (t: number, o: Partial<{ sharp: number; mean: number; black: number; white: number; shifts: ReturnType<typeof shiftAll> }> = {}) => ({ t, sharp: 100, mean: 120, black: 0, white: 0, shifts: shiftAll(3, 0).map((v, i) => ({ ...v, dx: 2 + (i % 5) })), ...o });
  const meta = { duration: 60, width: 1920, height: 1080 };

  it("finds how far a picture moved", () => {
    const a = tex(160, 90);
    const b = tex(160, 90, 4, -2);
    const s = blockShifts(a, b, 160, 90, 16, 10);
    expect(s.length).toBeGreaterThan(10);
    const med = s.map((v) => v.dx).sort((p, q) => p - q)[s.length >> 1];
    expect(med).toBe(4);
    expect(s.map((v) => v.dy).sort((p, q) => p - q)[s.length >> 1]).toBe(-2);
  });

  it("scores a sharp picture above a blurred one", () => {
    const a = tex(64, 64);
    const blur = a.map((_, i) => (a[i]! + a[Math.min(a.length - 1, i + 1)]! + a[Math.max(0, i - 1)]! + a[Math.min(a.length - 1, i + 64)]! + a[Math.max(0, i - 64)]!) / 5);
    expect(sharpness(a, 64, 64)).toBeGreaterThan(3 * sharpness(Uint8Array.from(blur), 64, 64));
  });

  it("says nothing about a good walk around", () => {
    const items = judgeVideo(Array.from({ length: 120 }, (_, i) => sample(i / 2)), meta);
    expect(items).toEqual([]);
    expect(verdictOf(items)).toBe("good");
  });

  it("names blur, darkness, standing still and a part that never moves, with times", () => {
    const s = Array.from({ length: 120 }, (_, i) =>
      sample(i / 2, {
        sharp: i >= 20 && i < 60 ? 20 : 100,
        mean: i >= 80 ? 30 : 120,
        // The bottom rows never move (a dashboard), the rest does.
        shifts: shiftAll(3).map((v) => (v.y > 60 ? { ...v, dx: 0 } : { ...v, dx: 2 + (v.x % 3) })),
      }),
    );
    const items = judgeVideo(s, meta);
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.blurry).toMatchObject({ severity: "warning", params: { share: 33, when: "0:10–0:29" } });
    expect(by.dark).toMatchObject({ severity: "warning", params: { when: "0:40–0:59" } });
    expect(by.partBlocked).toMatchObject({ params: { where: "bottom" } });
    expect(verdictOf(items)).toBe("fair");
    const still = judgeVideo(Array.from({ length: 40 }, (_, i) => sample(i / 2, { shifts: shiftAll(0) })), meta);
    expect(still.find((i) => i.key === "standingStill")).toMatchObject({ severity: "error" });
  });

  it("notices turning on the spot: everything moves the same way", () => {
    const items = judgeVideo(Array.from({ length: 40 }, (_, i) => sample(i / 2, { shifts: shiftAll(4, 1) })), meta);
    expect(items.map((i) => i.key)).toContain("turningInPlace");
  });

  it("says when too few pictures got a pose, and when the camera only went forward", () => {
    // Cameras looking down +z (identity rotation) and moving along it: a drive straight ahead.
    const ahead = Array.from({ length: 20 }, (_, i) => ({ q: [1, 0, 0, 0], centre: [0.02 * Math.sin(i), 0, i] as V3 }));
    const items = judgePoses(ahead, 25);
    expect(items.map((i) => i.key)).toEqual(["posesGood", "forwardOnly"]);
    const sideways = Array.from({ length: 20 }, (_, i) => ({ q: [1, 0, 0, 0], centre: [i, 0, 0] as V3 }));
    expect(judgePoses(sideways, 20).map((i) => i.key)).toEqual(["posesGood"]);
    expect(judgePoses(sideways.slice(0, 5), 20)[0]).toMatchObject({ key: "posesFailed", severity: "error" });
  });

  it("reads a video's size and length from ffmpeg", () => {
    const text = "Input #0, mov,mp4\n  Duration: 00:02:05.43, start: 0.000000, bitrate: 15000 kb/s\n  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 3840x2160, 14000 kb/s, 29.97 fps, 29.97 tbr\n";
    expect(parseMediaInfo(text)).toEqual({ duration: 125.43, width: 3840, height: 2160, fps: 29.97 });
    // A gap of one sample is joined; a longer one splits the range.
    expect(timeRanges([{ t: 0 }, { t: 0.5 }, { t: 1 }, { t: 70 }], (x) => x.t !== 1)).toBe("0:00–1:10");
    expect(timeRanges([{ t: 0 }, { t: 0.5 }, { t: 1 }, { t: 1.5 }, { t: 70 }], (x) => x.t < 1 || x.t > 2)).toBe("0:00, 1:10");
  });
});
