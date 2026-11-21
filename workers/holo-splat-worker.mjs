#!/usr/bin/env node
// HOLO splat training worker (docs/GAUSSIAN_SPLATS.md, "Installing a method"; SRS GS-03, GS-08).
//
// One program for every ground-capture method. HOLO's server starts it with discrete arguments
// (apps/server/src/reconstruct.ts, worker contract); it
//   1. takes frames from a video by how far the view moved (dense when the camera moves fast,
//      sparse when slow, the sharpest near each point) or uses the photos as they are,
//   2. recovers camera poses with COLMAP (or GLOMAP for the global step, or pycolmap),
//   3. when the capture carries camera positions (photo EXIF GPS, a drone .SRT, or
//      camera-gnss.csv beside a video), fits the reconstruction to them and moves it into a local
//      east-north-up frame in metres, holding every fifth camera back as an independent check,
//   4. runs the method's trainer (gsplat, gsplat 2DGS, Brush or OpenSplat) with the preset HOLO
//      chose, and
//   5. writes out/splats.ply, out/provenance.json and, when placed, out/georef.json.
// It installs nothing. Where each program is comes from holo-worker.json next to this file
// (see holo-worker.example.json); `--check` reports what is missing.
//
// Exit 0: done. Exit 2: the capture cannot be used (said on stderr in plain words). Exit 1: a tool
// failed; HOLO retries once.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Configuration

/** Defaults; holo-worker.json overrides any of them. Templates use {name} for the values below. */
export const DEFAULTS = {
  ffmpeg: "ffmpeg",
  /**
   * A video frame is kept once the view has moved this share of the image width. Driving forward
   * barely shifts the image, so this is small: on a 40 km/h car clip 3% kept 67 of 592 frames,
   * about 1% kept 159 and 0.4% kept 251 (one per 1-8 frames), which posed as one model.
   */
  frameStep: 0.01,
  /** "colmap" (the colmap program), "glomap" (colmap for features, glomap for the global mapper), or "pycolmap" (python with pycolmap). */
  sfm: "colmap",
  colmap: "colmap",
  glomap: "glomap",
  python: "python3",
  /** Use the GPU for SIFT features and matching (COLMAP built with CUDA). */
  sfmGpu: true,
  /** Above this many photos, matching uses a vocabulary tree instead of every pair. */
  exhaustiveUpTo: 250,
  vocabTree: "",
  methods: {
    gsplat: {
      repo: "",
      revision: "",
      train: ["{python}", "{repo}/examples/simple_trainer.py", "mcmc", "--data_dir", "{data}", "--data_factor", "1", "--result_dir", "{train}", "--max_steps", "{iterations}", "--strategy.cap-max", "{maxSplats}", "--sh_degree", "{shDegree}", "--save_ply", "--ply_steps", "{iterations}", "--disable_viewer"],
      check: ["{python}", "-c", "import gsplat, torch; print(gsplat.__version__); assert torch.cuda.is_available(), 'PyTorch cannot see a CUDA GPU'"],
    },
    "gsplat-2dgs": {
      repo: "",
      revision: "",
      train: ["{python}", "{repo}/examples/simple_trainer_2dgs.py", "--data_dir", "{data}", "--data_factor", "1", "--result_dir", "{train}", "--max_steps", "{iterations}", "--sh_degree", "{shDegree}", "--disable_viewer"],
      check: ["{python}", "-c", "import gsplat, torch; print(gsplat.__version__); assert torch.cuda.is_available(), 'PyTorch cannot see a CUDA GPU'"],
    },
    brush: {
      program: "brush_app",
      revision: "",
      train: ["{program}", "{data}", "--total-steps", "{iterations}", "--max-splats", "{maxSplats}", "--sh-degree", "{shDegree}", "--max-resolution", "{resolution}", "--export-every", "{iterations}", "--export-path", "{train}", "--export-name", "splats.ply"],
      check: ["{program}", "--version"],
    },
    // EOGS++ for satellite views, through workers/eogs/holo_eogs.py: it cuts the views to the area
    // they share, runs EOGS++ and moves the splats to metres east-north-up with georef.json. {data}
    // is the capture folder with the images and their RPC files, already checked by HOLO
    // (apps/server/src/satellite.ts). "python" here is the EOGS++ environment's Python.
    "eogs-plus": {
      repo: "",
      revision: "",
      train: ["{python}", "{here}/eogs/holo_eogs.py", "run", "--eogs", "{repo}", "--data", "{data}", "--train", "{train}", "--iterations", "{iterations}", "--max-size", "{resolution}"],
      check: ["{python}", "{here}/eogs/holo_eogs.py", "check", "--eogs", "{repo}"],
    },
    opensplat: {
      program: "opensplat",
      revision: "",
      train: ["{program}", "{data}", "-n", "{iterations}", "--sh-degree", "{shDegree}", "-o", "{train}/splats.ply"],
      check: ["{program}", "--version"],
    },
  },
};

export function loadConfig(file = path.join(HERE, "holo-worker.json")) {
  const user = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const methods = { ...DEFAULTS.methods };
  for (const [k, v] of Object.entries(user.methods ?? {})) methods[k] = { ...(methods[k] ?? {}), ...v };
  return { ...DEFAULTS, ...user, methods };
}

/** Fills {name} in each argument ({here} is this program's folder); an argument is never split or passed to a shell. */
export const fill = (argv, values) => argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k === "here" && values.here === undefined ? HERE : values[k] !== undefined ? String(values[k]) : m)));

// ---------------------------------------------------------------------------------------------
// Geometry: WGS 84, local east-north-up, and a similarity fit (Horn's quaternion method)

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const D2R = Math.PI / 180;

export function toEcef(lat, lon, h) {
  const p = lat * D2R;
  const l = lon * D2R;
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}

export function toGeodetic([x, y, z]) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: lat / D2R, lon: lon / D2R, height: h };
}

/** East-north-up coordinates of a point, in metres, at an origin. */
export function toEnu(origin, lat, lon, h) {
  const o = toEcef(origin.lat, origin.lon, origin.height);
  const q = toEcef(lat, lon, h);
  const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
  const p = origin.lat * D2R;
  const l = origin.lon * D2R;
  return [
    -Math.sin(l) * d[0] + Math.cos(l) * d[1],
    -Math.sin(p) * Math.cos(l) * d[0] - Math.sin(p) * Math.sin(l) * d[1] + Math.cos(p) * d[2],
    Math.cos(p) * Math.cos(l) * d[0] + Math.cos(p) * Math.sin(l) * d[1] + Math.sin(p) * d[2],
  ];
}

function jacobiEigen(m) {
  const n = m.length;
  const a = m.map((r) => [...r]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

/**
 * The similarity y = s R x + t that best fits point pairs (least squares, Horn 1987).
 * Returns null when the points are too few or nearly on one line, where rotation is not fixed.
 */
export function fitSimilarity(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mean = (ps) => [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / n);
  const mx = mean(xs);
  const my = mean(ys);
  const X = xs.map((p) => [p[0] - mx[0], p[1] - mx[1], p[2] - mx[2]]);
  const Y = ys.map((p) => [p[0] - my[0], p[1] - my[1], p[2] - my[2]]);
  // Spread of the model points: the second-largest axis must not vanish (collinear).
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, p) => s + p[i] * p[j], 0) / n));
  const spread = jacobiEigen(cov).values.sort((a, b) => b - a);
  if (!(spread[0] > 0) || spread[1] / spread[0] < 1e-6) return null;
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, p, k) => s + p[i] * Y[k][j], 0)));
  const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = S;
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const e = jacobiEigen(N);
  const best = e.values.indexOf(Math.max(...e.values));
  const [w, x, y, z] = e.vectors.map((r) => r[best]);
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const rx = X.map((p) => mulMV(R, p));
  const s = rx.reduce((acc, p, k) => acc + p[0] * Y[k][0] + p[1] * Y[k][1] + p[2] * Y[k][2], 0) / X.reduce((acc, p) => acc + p[0] ** 2 + p[1] ** 2 + p[2] ** 2, 0);
  const rm = mulMV(R, mx);
  const t = [my[0] - s * rm[0], my[1] - s * rm[1], my[2] - s * rm[2]];
  return { s, R, t };
}

const mulMV = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
export const applySim = (T, p) => {
  const r = mulMV(T.R, p);
  return [T.s * r[0] + T.t[0], T.s * r[1] + T.t[1], T.s * r[2] + T.t[2]];
};

/** Horizontal and vertical RMS of fitted positions against their references, in metres. */
export function residuals(T, xs, ys) {
  if (!xs.length) return null;
  let h = 0;
  let v = 0;
  let worst = 0;
  xs.forEach((x, i) => {
    const p = applySim(T, x);
    const dh2 = (p[0] - ys[i][0]) ** 2 + (p[1] - ys[i][1]) ** 2;
    const dv = p[2] - ys[i][2];
    h += dh2;
    v += dv * dv;
    worst = Math.max(worst, Math.sqrt(dh2 + dv * dv));
  });
  const r = (x) => Math.round(Math.sqrt(x / xs.length) * 1000) / 1000;
  return { count: xs.length, horizontalRms: r(h), verticalRms: r(v), max: Math.round(worst * 1000) / 1000 };
}

// ---------------------------------------------------------------------------------------------
// Camera positions: photo EXIF GPS, drone .SRT, camera-gnss.csv

/** Latitude, longitude and altitude from a JPEG's EXIF GPS block, or null. */
export function exifGps(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 < buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    if (marker === 0xe1 && buf.toString("latin1", o + 4, o + 10) === "Exif\0\0") return tiffGps(buf.subarray(o + 10, o + 2 + len));
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function tiffGps(t) {
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (i) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i));
  const u32 = (i) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const entries = (ifd) => {
    if (ifd + 2 > t.length) return [];
    const n = u16(ifd);
    const out = [];
    for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= t.length; k++) {
      const e = ifd + 2 + k * 12;
      out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const gpsPtr = entries(u32(4)).find((e) => e.tag === 0x8825);
  if (!gpsPtr) return null;
  const g = new Map(entries(u32(gpsPtr.at)).map((e) => [e.tag, e]));
  const rational = (e, k) => {
    const off = u32(e.at) + k * 8;
    if (off + 8 > t.length) return NaN;
    return u32(off) / u32(off + 4);
  };
  const ascii = (e) => String.fromCharCode(t[e.at]);
  const dms = (e) => (e && e.type === 5 && e.count >= 3 ? rational(e, 0) + rational(e, 1) / 60 + rational(e, 2) / 3600 : NaN);
  let lat = dms(g.get(2));
  let lon = dms(g.get(4));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (g.get(1) && ascii(g.get(1)) === "S") lat = -lat;
  if (g.get(3) && ascii(g.get(3)) === "W") lon = -lon;
  const altE = g.get(6);
  let alt = altE && altE.type === 5 ? rational(altE, 0) : NaN;
  if (Number.isFinite(alt) && g.get(5) && t[g.get(5).at] === 1) alt = -alt;
  return { lat, lon, height: Number.isFinite(alt) ? alt : null };
}

/** Per-frame positions from a DJI-style .SRT: times in seconds and WGS 84 positions. */
export function parseSrt(text) {
  const out = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const time = /(\d\d):(\d\d):(\d\d)[,.](\d{3})\s*-->/.exec(block);
    if (!time) continue;
    const t = +time[1] * 3600 + +time[2] * 60 + +time[3] + +time[4] / 1000;
    const lat = /latitude\s*:\s*(-?[\d.]+)/i.exec(block)?.[1];
    const lon = /longitude\s*:\s*(-?[\d.]+)/i.exec(block)?.[1];
    const alt = /abs_alt\s*:\s*(-?[\d.]+)/i.exec(block)?.[1];
    const gps = /GPS\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i.exec(block);
    if (lat && lon) out.push({ t, lat: +lat, lon: +lon, height: alt !== undefined ? +alt : null });
    else if (gps) out.push({ t, lon: +gps[1], lat: +gps[2], height: +gps[3] });
  }
  return out.filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0));
}

/** camera-gnss.csv: time_s,longitude,latitude,ellipsoidal_height_m, times increasing. */
export function parseGnssCsv(text) {
  const rows = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const head = rows.shift()?.toLowerCase().split(",").map((s) => s.trim()) ?? [];
  const col = (n) => head.indexOf(n);
  const [ti, lo, la, h] = [col("time_s"), col("longitude"), col("latitude"), col("ellipsoidal_height_m")];
  if ([ti, lo, la, h].some((i) => i < 0)) throw new Error("camera-gnss.csv needs the header time_s,longitude,latitude,ellipsoidal_height_m.");
  const out = rows.map((r) => r.split(",").map(Number)).map((c) => ({ t: c[ti], lon: c[lo], lat: c[la], height: c[h] }));
  if (out.some((p, i) => ![p.t, p.lon, p.lat, p.height].every(Number.isFinite) || (i > 0 && p.t <= out[i - 1].t))) throw new Error("camera-gnss.csv has a row that is not four numbers, or times that do not increase.");
  return out;
}

/** The position at a time, interpolated between the two fixes around it; null outside the track. */
export function positionAt(track, t) {
  if (!track.length || t < track[0].t || t > track[track.length - 1].t) return null;
  let i = 1;
  while (i < track.length && track[i].t < t) i++;
  const a = track[Math.max(0, i - 1)];
  const b = track[Math.min(track.length - 1, i)];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  if (a.height === null || b.height === null) return null;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, height: a.height + (b.height - a.height) * f };
}

// ---------------------------------------------------------------------------------------------
// COLMAP binary model: read camera centres, and move the whole model by a similarity

/** Quaternion (w, x, y, z) to a rotation matrix. */
const quatToR = ([w, x, y, z]) => [
  [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
  [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
  [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
];
function rToQuat(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (R[2][1] - R[1][2]) / s;
    y = (R[0][2] - R[2][0]) / s;
    z = (R[1][0] - R[0][1]) / s;
  } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    w = (R[2][1] - R[1][2]) / s;
    x = s / 4;
    y = (R[0][1] + R[1][0]) / s;
    z = (R[0][2] + R[2][0]) / s;
  } else if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    w = (R[0][2] - R[2][0]) / s;
    x = (R[0][1] + R[1][0]) / s;
    y = s / 4;
    z = (R[1][2] + R[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    w = (R[1][0] - R[0][1]) / s;
    x = (R[0][2] + R[2][0]) / s;
    y = (R[1][2] + R[2][1]) / s;
    z = s / 4;
  }
  return [w, x, y, z];
}
const transpose = (M) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[j][i]));
const mulMM = (P, Q) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => P[i][0] * Q[0][j] + P[i][1] * Q[1][j] + P[i][2] * Q[2][j]));

/** Each registered image of a COLMAP images.bin: name, pose, centre, and where its record sits. */
export function readImages(buf) {
  const out = [];
  let o = 8;
  const n = Number(buf.readBigUInt64LE(0));
  for (let k = 0; k < n; k++) {
    const at = o;
    const q = [0, 1, 2, 3].map((i) => buf.readDoubleLE(o + 4 + i * 8));
    const t = [0, 1, 2].map((i) => buf.readDoubleLE(o + 36 + i * 8));
    let e = o + 64;
    while (buf[e] !== 0) e++;
    const name = buf.toString("utf8", o + 64, e);
    const pts = Number(buf.readBigUInt64LE(e + 1));
    o = e + 9 + pts * 24;
    const R = quatToR(q);
    const c = mulMV(transpose(R), t).map((v) => -v);
    out.push({ at, name, q, t, centre: c });
  }
  return out;
}

/** Moves a COLMAP binary model (images.bin and points3D.bin in a folder) by y = s R x + t, in place. */
export function transformModel(dir, T) {
  const imgPath = path.join(dir, "images.bin");
  const ib = readFileSync(imgPath);
  const Rt = transpose(T.R);
  for (const im of readImages(ib)) {
    // Camera from world: x_c = Rc X + tc. With X = R^T (Y - t) / s and the camera frame scaled by s:
    // Rc' = Rc R^T and tc' = s tc - Rc' t.
    const Rc = mulMM(quatToR(im.q), Rt);
    const Rct = mulMV(Rc, T.t);
    const tc = [0, 1, 2].map((i) => T.s * im.t[i] - Rct[i]);
    rToQuat(Rc).forEach((v, i) => ib.writeDoubleLE(v, im.at + 4 + i * 8));
    tc.forEach((v, i) => ib.writeDoubleLE(v, im.at + 36 + i * 8));
  }
  writeFileSync(imgPath, ib);
  const ptPath = path.join(dir, "points3D.bin");
  const pb = readFileSync(ptPath);
  const n = Number(pb.readBigUInt64LE(0));
  let o = 8;
  for (let k = 0; k < n; k++) {
    const p = applySim(T, [0, 1, 2].map((i) => pb.readDoubleLE(o + 8 + i * 8)));
    p.forEach((v, i) => pb.writeDoubleLE(v, o + 8 + i * 8));
    const track = Number(pb.readBigUInt64LE(o + 43));
    o += 51 + track * 8;
  }
  writeFileSync(ptPath, pb);
}

/**
 * Levels a model that has no positions to place it by, so that up is up in the viewer.
 *
 * Pose software leaves the world turned any way, and the view then rolls as you orbit. People hold
 * a camera with its picture level: the cameras' right-hand (x) axes are close to horizontal, so
 * "up" is the direction most nearly at right angles to all of them (the smallest axis of their
 * spread, as COLMAP's model_orientation_aligner assumes). Its sign comes from the pictures' "up"
 * (the cameras' −y), or from the view direction when the cameras look straight down.
 *
 * Returns the turn (and a shift to the cameras' mean centre) that brings up to COLMAP's −y, the
 * viewer's up, with the least turn so the heading is kept; or a reason when up is not clear.
 */
export function levelTransform(cams) {
  if (cams.length < 3) return { reason: "Too few cameras to tell which way is up." };
  const axes = cams.map((c) => quatToR(c.q));
  const sum = (f) => axes.reduce((acc, R) => f(R).map((v, i) => acc[i] + v), [0, 0, 0]);
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => axes.reduce((acc, R) => acc + R[0][i] * R[0][j], 0) / axes.length));
  const e = jacobiEigen(S);
  const order = e.values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  // The right-hand axes must lie in a plane: a clear gap from the second-smallest spread.
  if (!(order[1][0] > 4 * order[0][0] && order[1][0] > 0.02)) return { reason: "The cameras were turned too many ways to tell which way is up." };
  let up = [0, 1, 2].map((k) => e.vectors[k][order[0][1]]);
  const unit = (v) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const picUp = unit(sum((R) => [-R[1][0], -R[1][1], -R[1][2]]));
  const look = unit(sum((R) => R[2]));
  const d = up[0] * picUp[0] + up[1] * picUp[1] + up[2] * picUp[2];
  const dl = up[0] * look[0] + up[1] * look[1] + up[2] * look[2];
  const flip = Math.abs(d) > 0.2 ? d < 0 : dl > 0;
  if (flip) up = up.map((v) => -v);
  // Least turn taking up to (0, −1, 0) (Rodrigues).
  const target = [0, -1, 0];
  const ax = [up[1] * target[2] - up[2] * target[1], up[2] * target[0] - up[0] * target[2], up[0] * target[1] - up[1] * target[0]];
  const sin = Math.hypot(...ax);
  const cos = up[0] * target[0] + up[1] * target[1] + up[2] * target[2];
  let R;
  if (sin < 1e-9) R = cos > 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  else {
    const [x, y, z] = ax.map((v) => v / sin);
    const C = 1 - cos;
    R = [
      [cos + x * x * C, x * y * C - z * sin, x * z * C + y * sin],
      [y * x * C + z * sin, cos + y * y * C, y * z * C - x * sin],
      [z * x * C - y * sin, z * y * C + x * sin, cos + z * z * C],
    ];
  }
  const mean = [0, 1, 2].map((k) => cams.reduce((acc, c) => acc + c.centre[k], 0) / cams.length);
  const rm = mulMV(R, mean);
  return { T: { s: 1, R, t: rm.map((v) => -v) }, tiltDeg: Math.round((Math.atan2(sin, cos) * 180) / Math.PI * 10) / 10 };
}

/**
 * Fits the model to camera positions. Every fifth camera is held back as a check when there are
 * at least ten; the rest fix the transform. The local frame's origin is the cameras' mean position.
 */
export function georeference(cameras, fixes, source) {
  const pairs = cameras.map((c) => ({ c, f: fixes.get(c.name) })).filter((p) => p.f && p.f.height !== null);
  if (pairs.length < 3) return { reason: `Only ${pairs.length} camera${pairs.length === 1 ? "" : "s"} with a pose also had a position; at least 3 are needed.` };
  const mean = (k) => pairs.reduce((s, p) => s + p.f[k], 0) / pairs.length;
  const origin = { lat: mean("lat"), lon: mean("lon"), height: mean("height") };
  const enu = pairs.map((p) => toEnu(origin, p.f.lat, p.f.lon, p.f.height));
  const holdOut = pairs.length >= 10;
  const ctl = pairs.map((_, i) => i).filter((i) => !holdOut || i % 5 !== 2);
  const chk = holdOut ? pairs.map((_, i) => i).filter((i) => i % 5 === 2) : [];
  const T = fitSimilarity(ctl.map((i) => pairs[i].c.centre), ctl.map((i) => enu[i]));
  if (!T) return { reason: "The camera positions lie nearly on one line, so the model's turn cannot be fixed from them." };
  return {
    T,
    georef: {
      frame: "enu",
      origin,
      source,
      horizontalCrs: "EPSG:4326",
      verticalDatum: source === "camera-gnss.csv" ? "WGS 84 ellipsoid (as camera-gnss.csv declares)" : "as recorded by the camera (EXIF and drone logs usually give height above sea level)",
      metresPerModelUnit: Math.round(T.s * 1e6) / 1e6,
      controls: residuals(T, ctl.map((i) => pairs[i].c.centre), ctl.map((i) => enu[i])),
      checks: chk.length ? residuals(T, chk.map((i) => pairs[i].c.centre), chk.map((i) => enu[i])) : null,
      note: "Camera positions, not surveyed ground points: accuracy follows the GPS used.",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Running the steps

class InputError extends Error {}

/** One line on stderr for HOLO's training log (redacted by the server before it is kept). */
const say = (t) => process.stderr.write(`${new Date().toISOString()} ${t}\n`);

function run(argv, opts = {}) {
  const what = `${path.basename(argv[0])}${argv[1] && !argv[1].startsWith("-") && !argv[1].includes("/") ? ` ${argv[1]}` : ""}`;
  const t0 = Date.now();
  say(`step ${what}: start`);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const onData = (chunk) => {
      const s = String(chunk);
      tail = (tail + s).slice(-4000);
      if (opts.onLine) for (const line of s.split(/\r?\n|\r/)) opts.onLine(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    // HOLO stops a cancelled training with SIGTERM: pass it on to the tool.
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    child.on("error", (e) => reject(new Error(`${path.basename(argv[0])} did not start: ${e.message}`)));
    child.on("close", (code) => {
      process.off("SIGTERM", stop);
      say(`step ${what}: exit ${code} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (code !== 0) say(`step ${what}: last output:\n${tail.trim().split("\n").slice(-25).join("\n")}`);
      if (code === 0) resolve(tail);
      // A helper of this worker (sfm_pycolmap.py) says "this capture cannot be used" with exit 2.
      else if (code === 2 && opts.inputErrors) reject(new InputError(tail.trim().split("\n").slice(-1)[0] ?? "The capture cannot be used."));
      else reject(new Error(`${path.basename(argv[0])} ${argv[1] ?? ""} stopped (exit ${code}): ${tail.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`));
    });
  });
}

const progress = (f, stage) => console.log(`progress ${f.toFixed(3)} ${stage}`);
const listFiles = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
const VIDEO = /\.(mp4|mov|m4v|lrv|ts|mts|avi|mkv|webm)$/i;
const PHOTO = /\.(jpe?g|png|tiff?|webp)$/i;

/**
 * Frames from a video, picked by how far the view has moved, not by a fixed clock: a walk at
 * 1 m/s and a car at 40 km/h need very different rates. Every frame is looked at small; a frame is
 * kept once the image has moved `frameStep` of its width since the last kept one (or after
 * 1/videoFps seconds at most), and of the frames around that point the sharpest is kept, by
 * ffmpeg's blurdetect (lower is sharper). Then only the kept frames are written, at full size.
 */
export async function videoFrames(cfg, video, dir, o) {
  mkdirSync(dir, { recursive: true });
  const work = path.join(dir, "..", "candidates");
  mkdirSync(work, { recursive: true });
  const scores = path.join(work, "blur.txt");
  const W = 192;
  const H = 108;
  // Pass 1: blur score of every frame at 640 px, and a 192×108 grey copy for motion. Motion is
  // measured from the last frame that moved enough, not frame to frame, so slow steady motion adds up.
  const stepPx = (cfg.frameStep ?? 0.01) * W;
  const triggers = [];
  let ref = null;
  let count = 0;
  await new Promise((resolve, reject) => {
    const child = spawn(cfg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", video, "-an", "-vf", `scale=640:-2,blurdetect,metadata=mode=print:key=lavfi.blurdetect.blur:file=${scores.replace(/([\\:'])/g, "\\$1")},scale=${W}:${H},format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    let buf = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= W * H) {
        const f = new Uint8Array(buf.subarray(0, W * H));
        buf = buf.subarray(W * H);
        if (!ref || frameMotion(ref, f, W, H) >= stepPx) {
          triggers.push(count);
          ref = f;
        }
        count++;
      }
    });
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGTERM", stop);
      code === 0 ? resolve() : reject(new Error(`ffmpeg stopped (exit ${code}): ${err.trim().slice(-300)}`));
    });
  });
  const { blur, times } = parseFrameScores(existsSync(scores) ? readFileSync(scores, "utf8") : "");
  const fps = times.length > 1 ? (times.length - 1) / (times[times.length - 1] - times[0] || 1) : 30;
  const keep = selectFrames(triggers, count, blur, { maxGap: Math.max(1, Math.round(fps / Math.max(0.5, o.videoFps))) });
  // Pass 2: every frame as JPEG on a pipe at the training size, keeping only the picked ones. A
  // select expression naming hundreds of frames breaks ffmpeg's expression parser, so none is used.
  const scale = `scale='if(gt(iw,ih),min(${o.resolution},iw),-2)':'if(gt(iw,ih),-2,min(${o.resolution},ih))'`;
  const wanted = new Set(keep);
  const out = [];
  await new Promise((resolve, reject) => {
    const child = spawn(cfg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", video, "-an", "-vf", scale, "-fps_mode", "passthrough", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    const split = jpegSplitter((jpg, n) => {
      if (!wanted.has(n)) return;
      const name = `frame_${String(n).padStart(6, "0")}.jpg`;
      writeFileSync(path.join(dir, name), jpg);
      out.push({ name, time: times[n] ?? n / fps });
    });
    let err = "";
    child.stdout.on("data", split);
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGTERM", stop);
      code === 0 ? resolve() : reject(new Error(`ffmpeg stopped (exit ${code}): ${err.trim().slice(-300)}`));
    });
  });
  if (out.length !== keep.length) throw new Error(`ffmpeg gave ${out.length} of the ${keep.length} frames picked.`);
  return out;
}

/**
 * Cuts a stream of concatenated JPEGs (ffmpeg's image2pipe) into whole pictures, numbered from 0.
 * A JPEG ends at FF D9; inside the coded data every FF byte is followed by 00, so that pair cannot
 * appear early. Markers before the image data (FF D8 of a thumbnail) are skipped by counting SOIs.
 */
export function jpegSplitter(onImage) {
  let parts = [];
  let size = 0;
  let n = 0;
  let prevFF = false;
  let depth = 0;
  return (chunk) => {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (prevFF && b === 0xd8) depth++;
      else if (prevFF && b === 0xd9 && depth > 0 && --depth === 0) {
        parts.push(chunk.subarray(start, i + 1));
        size += i + 1 - start;
        onImage(Buffer.concat(parts, size), n++);
        parts = [];
        size = 0;
        start = i + 1;
      }
      prevFF = b === 0xff;
    }
    if (start < chunk.length) {
      parts.push(Buffer.from(chunk.subarray(start)));
      size += chunk.length - start;
    }
  };
}

/**
 * How far the view moved between two small grey frames, in pixels: block matching on a grid,
 * textured blocks only (a dashboard or a blank wall says nothing), and the 75th percentile of the
 * block shifts, so that forward motion (which spreads outwards) counts as well as a pan.
 */
export function frameMotion(a, b, w, h, block = 16, search = 6) {
  const shifts = [];
  for (let by = search; by + block + search <= h; by += block)
    for (let bx = search; bx + block + search <= w; bx += block) {
      let s = 0;
      let s2 = 0;
      for (let y = 0; y < block; y++)
        for (let x = 0; x < block; x++) {
          const v = a[(by + y) * w + bx + x];
          s += v;
          s2 += v * v;
        }
      const n = block * block;
      if (s2 / n - (s / n) ** 2 < 40) continue;
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let dy = -search; dy <= search; dy++)
        for (let dx = -search; dx <= search; dx++) {
          let sad = 0;
          // Stop early once this shift is already worse than the best one (ties still count).
          for (let y = 0; y < block && sad <= best; y++) {
            const ra = (by + y) * w + bx;
            const rb = (by + y + dy) * w + bx + dx;
            for (let x = 0; x < block; x++) sad += Math.abs(a[ra + x] - b[rb + x]);
          }
          if (sad < best || (sad === best && dx * dx + dy * dy < bdx * bdx + bdy * bdy)) {
            best = sad;
            bdx = dx;
            bdy = dy;
          }
        }
      shifts.push(Math.hypot(bdx, bdy));
    }
  if (shifts.length < 4) return 0;
  shifts.sort((x, y) => x - y);
  return shifts[Math.floor(shifts.length * 0.75)];
}

/**
 * Which frames to keep, from the frames where the view had moved enough (`triggers`): around each
 * (±window) the sharpest frame wins, and a gap longer than `maxGap` frames gets frames added, so a
 * camera standing still still gives a few.
 */
export function selectFrames(triggers, n, blur, { maxGap, window = 2 }) {
  if (!n) return [];
  const points = [];
  const ts = [...new Set(triggers.filter((t) => t >= 0 && t < n))].sort((a, b) => a - b);
  if (!ts.length || ts[0] !== 0) ts.unshift(0);
  for (let k = 0; k < ts.length; k++) {
    points.push(ts[k]);
    const next = k + 1 < ts.length ? ts[k + 1] : n - 1 + maxGap;
    for (let t = ts[k] + maxGap; t < next && t < n; t += maxGap) points.push(t);
  }
  const keep = [];
  for (const at of points) {
    const lo = Math.max(keep.length ? keep[keep.length - 1] + 1 : 0, at - window);
    const hi = Math.min(n - 1, at + window);
    if (lo > hi) continue;
    let best = Math.min(hi, Math.max(lo, at));
    for (let j = lo; j <= hi; j++) {
      const d = (blur.get(j) ?? Infinity) - (blur.get(best) ?? Infinity);
      if (d < 0 || (d === 0 && Math.abs(j - at) < Math.abs(best - at))) best = j;
    }
    keep.push(best);
  }
  return keep;
}

/** blurdetect scores and times by frame number, from ffmpeg's metadata print ("frame:N ... pts_time:T" then "lavfi.blurdetect.blur=X"). */
export function parseFrameScores(text) {
  const blur = new Map();
  const times = [];
  let n = -1;
  for (const line of text.split(/\r?\n/)) {
    const m = /^frame:(\d+)\s.*pts_time:([\d.]+)/.exec(line);
    if (m) {
      n = Number(m[1]);
      times[n] = Number(m[2]);
    }
    const b = /lavfi\.blurdetect\.blur=([\d.]+)/.exec(line);
    if (b && n >= 0) blur.set(n, Number(b[1]));
  }
  return { blur, times };
}

async function sfm(cfg, images, work, o, video) {
  const db = path.join(work, "colmap.db");
  const sparse = path.join(work, "sparse");
  const undist = path.join(work, "data");
  mkdirSync(sparse, { recursive: true });
  const count = readdirSync(images).length;
  if (cfg.sfm === "pycolmap") {
    await run([cfg.python, path.join(HERE, "sfm_pycolmap.py"), "--images", images, "--work", work, "--matcher", video ? "sequential" : count <= cfg.exhaustiveUpTo ? "exhaustive" : "vocabtree", "--vocab-tree", cfg.vocabTree || "", "--threads", String(o.threads)], { inputErrors: true, onLine: (l) => /progress/.test(l) && console.log(l) });
  } else {
    const gpu = cfg.sfmGpu ? "1" : "0";
    await run([cfg.colmap, "feature_extractor", "--database_path", db, "--image_path", images, "--ImageReader.camera_model", "OPENCV", "--ImageReader.single_camera", video ? "1" : "0", "--SiftExtraction.use_gpu", gpu, "--SiftExtraction.num_threads", String(o.threads)]);
    progress(0.12, "features");
    if (video) await run([cfg.colmap, "sequential_matcher", "--database_path", db, "--SiftMatching.use_gpu", gpu, "--SequentialMatching.overlap", "15", "--SequentialMatching.loop_detection", cfg.vocabTree ? "1" : "0", ...(cfg.vocabTree ? ["--SequentialMatching.vocab_tree_path", cfg.vocabTree] : [])]);
    else if (count <= cfg.exhaustiveUpTo || !cfg.vocabTree) await run([cfg.colmap, "exhaustive_matcher", "--database_path", db, "--SiftMatching.use_gpu", gpu]);
    else await run([cfg.colmap, "vocab_tree_matcher", "--database_path", db, "--SiftMatching.use_gpu", gpu, "--VocabTreeMatching.vocab_tree_path", cfg.vocabTree]);
    progress(0.2, "matching");
    if (cfg.sfm === "glomap") await run([cfg.glomap, "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse]);
    else await run([cfg.colmap, "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse, "--Mapper.num_threads", String(o.threads)]);
    progress(0.28, "poses");
    const models = existsSync(sparse) ? readdirSync(sparse).filter((d) => existsSync(path.join(sparse, d, "images.bin"))) : [];
    if (!models.length) throw new InputError("No camera poses could be found: the pictures do not overlap enough, or are too blurred or too plain.");
    // The largest model is the one to keep.
    const best = models.map((d) => ({ d, n: readImages(readFileSync(path.join(sparse, d, "images.bin"))).length })).sort((a, b) => b.n - a.n)[0].d;
    await run([cfg.colmap, "image_undistorter", "--image_path", images, "--input_path", path.join(sparse, best), "--output_path", undist, "--output_type", "COLMAP"]);
  }
  const model = path.join(undist, "sparse");
  // Trainers read data/sparse/0; image_undistorter writes data/sparse.
  const zero = path.join(model, "0");
  if (!existsSync(path.join(zero, "images.bin"))) {
    mkdirSync(zero, { recursive: true });
    for (const f of ["cameras.bin", "images.bin", "points3D.bin"]) copyFileSync(path.join(model, f), path.join(zero, f));
  }
  return { data: undist, model: zero, total: count };
}

/**
 * Satellite views go to the trainer as they are: it reads the RPC cameras itself, so there is no
 * pose step. EOGS++ (holo_eogs.py) leaves splats.ply, georef.json and holo-eogs.json in {train}.
 */
async function satellite(cfg, m, o, work) {
  const train = path.join(work, "train");
  mkdirSync(train, { recursive: true });
  progress(0.05, "train");
  await run(fill(m.train, { ...cfg, ...m, data: o.input, train, iterations: o.iterations, maxSplats: o.maxSplats, resolution: o.resolution, shDegree: o.shDegree, threads: o.threads }), {
    cwd: m.repo || work,
    inputErrors: true,
    onLine: (line) => {
      const hit = /(\d+)\s*\/\s*(\d+)/.exec(line);
      if (hit && Number(hit[2]) === o.iterations && Number(hit[1]) <= o.iterations) progress(0.05 + 0.85 * (Number(hit[1]) / o.iterations), "train");
    },
  });
  const direct = path.join(train, "splats.ply");
  const plys = existsSync(direct) ? [direct] : listFiles(train).filter((f) => f.endsWith(".ply")).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!plys.length) throw new Error(`${o.method} finished without writing a PLY in ${train}.`);
  mkdirSync(o.output, { recursive: true });
  copyFileSync(plys[0], path.join(o.output, "splats.ply"));
  if (existsSync(path.join(train, "georef.json"))) copyFileSync(path.join(train, "georef.json"), path.join(o.output, "georef.json"));
  let used = null;
  try {
    used = JSON.parse(readFileSync(path.join(train, "holo-eogs.json"), "utf8"));
  } catch {
    used = null;
  }
  const views = listFiles(o.input).filter((f) => /\.(tiff?|ntf|nitf|jp2)$/i.test(f)).length;
  const georefNote = existsSync(path.join(o.output, "georef.json")) ? undefined : "The trainer did not say where the splats are on the ground.";
  writeFileSync(
    path.join(o.output, "provenance.json"),
    JSON.stringify({ tool: o.method, version: check(cfg, o.method).version, poses: "RPC camera models, refined by the trainer", frames: views, registeredViews: Number.isInteger(used?.views) ? used.views : views, georefNote }),
  );
  progress(1, "done");
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument ${argv[i]}`);
    o[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  for (const k of ["method", "input", "inputKind", "goal", "output", "iterations", "maxSplats", "resolution", "shDegree", "videoFps", "threads"]) if (o[k] === undefined) throw new Error(`Missing --${k}`);
  for (const k of ["iterations", "maxSplats", "resolution", "shDegree", "threads"]) o[k] = Number.parseInt(o[k], 10);
  o.videoFps = Number(o.videoFps);
  return o;
}

/** `--check`: can this method run here? Nothing is installed or changed. */
function check(cfg, method) {
  const m = cfg.methods[method];
  const problems = [];
  const values = { ...cfg, ...m };
  const tryRun = (argv, what) => {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 45_000 });
    if (r.error || r.status !== 0) {
      problems.push(`${what} did not run (${(r.error?.message ?? r.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 160) || `exit ${r.status}`}).`);
      return null;
    }
    return `${r.stdout}${r.stderr}`.trim();
  };
  if (!m) return { ok: false, problems: [`No settings for ${method} in holo-worker.json.`] };
  if (method !== "eogs-plus") {
    tryRun([cfg.ffmpeg, "-version"], "ffmpeg");
    if (cfg.sfm === "pycolmap") tryRun([cfg.python, "-c", "import pycolmap"], "pycolmap");
    else tryRun([cfg.colmap, "help"], "COLMAP");
    if (cfg.sfm === "glomap") tryRun([cfg.glomap, "-h"], "GLOMAP");
  }
  if (!m.train) problems.push(`Set the training command for ${method} in holo-worker.json.`);
  if (m.train?.some((a) => a.includes("{repo}")) && !(m.repo && existsSync(m.repo))) problems.push(`Set "repo" for ${method} in holo-worker.json to its source folder.`);
  const out = m.check ? tryRun(fill(m.check, values), method) : null;
  let revision = m.revision || "";
  if (!revision && m.repo && existsSync(path.join(m.repo, ".git"))) revision = spawnSync("git", ["-C", m.repo, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const version = out ? out.split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 60) : undefined;
  return { ok: problems.length === 0, tool: method, version, revision: revision || undefined, problems };
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  if (argv[0] === "--check") {
    // HOLO asks `--check --method <id>`: one worker program serves several methods.
    const method = argv[1] === "--method" ? argv[2] : undefined;
    console.log(JSON.stringify(method ? check(cfg, method) : { ok: false, problems: ["--check needs --method <id>."] }));
    return;
  }
  const o = parseArgs(argv);
  const m = cfg.methods[o.method];
  if (!m?.train) throw new Error(`No training command for ${o.method} in holo-worker.json.`);
  const work = path.join(path.dirname(o.output), "work");
  const images = path.join(work, "images");
  mkdirSync(images, { recursive: true });
  const all = listFiles(o.input);
  const videos = all.filter((f) => VIDEO.test(f));
  const fixes = new Map();
  let source = null;
  let frames = 0;
  progress(0.01, "frames");
  if (o.inputKind === "satellite") return satellite(cfg, m, o, work);
  if (o.inputKind === "video") {
    if (videos.length !== 1) throw new InputError(videos.length ? "Send one video per capture." : "The capture has no video.");
    const list = await videoFrames(cfg, videos[0], images, o);
    frames = list.length;
    say(`frames: kept ${frames} from the video by movement`);
    if (frames < 8) throw new InputError(`Only ${frames} different frames came out of the video: it is too short or the camera hardly moved.`);
    const csv = all.find((f) => path.basename(f).toLowerCase() === "camera-gnss.csv");
    const srt = all.find((f) => /\.srt$/i.test(f));
    const track = csv ? parseGnssCsv(readFileSync(csv, "utf8")) : srt ? parseSrt(readFileSync(srt, "utf8")) : [];
    if (track.length) {
      source = csv ? "camera-gnss.csv" : "drone .SRT log";
      for (const f of list) {
        const p = positionAt(track, f.time);
        if (p) fixes.set(f.name, p);
      }
    }
  } else {
    const photos = all.filter((f) => PHOTO.test(f));
    if (photos.length < 3) throw new InputError("At least 3 photos are needed, from different places around the subject.");
    const seen = new Set();
    for (const f of photos) {
      let name = path.basename(f);
      while (seen.has(name)) name = `x${name}`;
      seen.add(name);
      copyFileSync(f, path.join(images, name));
      if (/\.jpe?g$/i.test(name)) {
        const gps = exifGps(readFileSync(f));
        if (gps) fixes.set(name, gps);
      }
    }
    frames = photos.length;
    if (fixes.size) source = "photo EXIF GPS";
  }
  progress(0.05, "features");

  const { data, model } = await sfm(cfg, images, work, o, o.inputKind === "video");
  const cams = readImages(readFileSync(path.join(model, "images.bin")));
  if (cams.length < Math.max(3, Math.ceil(frames * 0.2))) throw new InputError(`Only ${cams.length} of ${frames} pictures got a camera pose: they do not overlap enough, or are blurred.`);

  let georef = null;
  let georefNote = null;
  if (source && o.goal !== "satellite") {
    const g = georeference(cams, fixes, source);
    if (g.reason) georefNote = g.reason;
    else {
      transformModel(model, g.T);
      georef = g.georef;
    }
  }
  let levelled = null;
  if (!georef) {
    // No placement: still turn the model so that up is up, and put the cameras' middle at the origin.
    const l = levelTransform(cams);
    if (l.T) {
      transformModel(model, l.T);
      levelled = { tiltDeg: l.tiltDeg };
      say(`level: turned the model by ${l.tiltDeg}° so that up is up`);
    } else say(`level: left as it is (${l.reason})`);
  }
  progress(0.3, "train");

  const train = path.join(work, "train");
  mkdirSync(train, { recursive: true });
  const values = { ...cfg, ...m, data, train, iterations: o.iterations, maxSplats: o.maxSplats, resolution: o.resolution, shDegree: o.shDegree, threads: o.threads };
  await run(fill(m.train, values), {
    cwd: m.repo || work,
    onLine: (line) => {
      // Trainers print "1234/30000" or "step 1234": map that onto the training share of the bar.
      const hit = /(\d+)\s*\/\s*(\d+)/.exec(line) ?? /step[^\d]{0,3}(\d+)/i.exec(line);
      if (!hit) return;
      const done = Number(hit[1]);
      const total = hit[2] ? Number(hit[2]) : o.iterations;
      if (total === o.iterations && done <= total) progress(0.3 + 0.65 * (done / total), "train");
    },
  });
  const plys = listFiles(train).filter((f) => f.endsWith(".ply")).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!plys.length) throw new Error(`${o.method} finished without writing a PLY in ${train}.`);
  mkdirSync(o.output, { recursive: true });
  copyFileSync(plys[0], path.join(o.output, "splats.ply"));
  writeFileSync(
    path.join(o.output, "provenance.json"),
    JSON.stringify({ tool: o.method, version: check(cfg, o.method).version, poses: cfg.sfm === "glomap" ? "COLMAP features, GLOMAP mapper" : cfg.sfm === "pycolmap" ? "pycolmap" : "COLMAP", frames, registeredViews: cams.length, georefNote, levelled }),
  );
  if (georef) writeFileSync(path.join(o.output, "georef.json"), JSON.stringify(georef));
  progress(1, "done");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof InputError ? 2 : 1);
  });
}
