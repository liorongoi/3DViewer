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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      train: ["{program}", "{data}", "--total-steps", "{iterations}", "--max-splats", "{maxSplats}", "--sh-degree", "{shDegree}", "--max-resolution", "{resolution}", "--export-every", "{exportEvery}", "--export-path", "{train}", "--export-name", "export_{iter}.ply"],
      // Brush prints no progress when its output is not a terminal; its numbered exports show it.
      progressFiles: true,
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

/** Settings: holo-worker.json next to this program, or the file HOLO_WORKER_CONFIG names (the install in a home folder keeps it with its settings). */
export function loadConfig(file = process.env.HOLO_WORKER_CONFIG || path.join(HERE, "holo-worker.json")) {
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
    out.push({ at, name, q, t, centre: c, cameraId: buf.readUInt32LE(at + 60) });
  }
  return out;
}

/** Moves a COLMAP binary model (images.bin, frames.bin when there is one, and points3D.bin) by y = s R x + t, in place. */
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
  // COLMAP 3.12 and later keep the poses that count in frames.bin (rig from world), and image
  // poses are derived from them; images.bin's copy is only for older readers. Move both.
  const framesPath = path.join(dir, "frames.bin");
  if (existsSync(framesPath)) {
    const rigsPath = path.join(dir, "rigs.bin");
    if (T.s !== 1 && existsSync(rigsPath)) {
      // A rig's other cameras sit at fixed offsets from its first one; scaling would need those
      // moved too. Every rig HOLO's pose step makes has one camera, so refuse anything else.
      const rb = readFileSync(rigsPath);
      let ro = 8;
      for (let k = 0, n = Number(rb.readBigUInt64LE(0)); k < n; k++) {
        if (rb.readUInt32LE(ro + 4) !== 1) throw new Error("This model has camera rigs with several cameras; it cannot be rescaled to camera positions.");
        ro += 16;
      }
    }
    const fb = readFileSync(framesPath);
    let o = 8;
    for (let k = 0, n = Number(fb.readBigUInt64LE(0)); k < n; k++) {
      const q = [0, 1, 2, 3].map((i) => fb.readDoubleLE(o + 8 + i * 8));
      const t = [0, 1, 2].map((i) => fb.readDoubleLE(o + 40 + i * 8));
      const Rc = mulMM(quatToR(q), Rt);
      const Rct = mulMV(Rc, T.t);
      rToQuat(Rc).forEach((v, i) => fb.writeDoubleLE(v, o + 8 + i * 8));
      [0, 1, 2].map((i) => T.s * t[i] - Rct[i]).forEach((v, i) => fb.writeDoubleLE(v, o + 40 + i * 8));
      o += 68 + fb.readUInt32LE(o + 64) * 16;
    }
    writeFileSync(framesPath, fb);
  }
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
// Surveyed ground control points (ground-control.json from the server, made from gcp_list.txt)

// COLMAP camera models whose distortion this worker can undo: id -> number of parameters.
const CAMERA_PARAMS = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8 };
const CAMERA_SIZES = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12, 11: 3, 12: 4 };

/** The cameras of a COLMAP cameras.bin: id -> { model, width, height, params }. */
export function readCameras(buf) {
  const out = new Map();
  let o = 8;
  const n = Number(buf.readBigUInt64LE(0));
  for (let k = 0; k < n; k++) {
    const id = buf.readUInt32LE(o);
    const model = buf.readInt32LE(o + 4);
    const width = Number(buf.readBigUInt64LE(o + 8));
    const height = Number(buf.readBigUInt64LE(o + 16));
    const np = CAMERA_SIZES[model];
    if (np === undefined) throw new Error(`cameras.bin: unknown camera model ${model}`);
    const params = Array.from({ length: np }, (_, i) => buf.readDoubleLE(o + 24 + i * 8));
    out.set(id, { model, width, height, params });
    o += 24 + np * 8;
  }
  return out;
}

/** A pixel of a picture as an undistorted direction (x, y, 1) in its camera, or null for a model not handled. */
export function pixelRay(cam, px, py) {
  if (CAMERA_PARAMS[cam.model] === undefined) return null;
  const p = cam.params;
  const [fx, fy, cx, cy] = cam.model === 0 || cam.model === 2 || cam.model === 3 ? [p[0], p[0], p[1], p[2]] : [p[0], p[1], p[2], p[3]];
  const du = (px - cx) / fx;
  const dv = (py - cy) / fy;
  // What the lens adds at an undistorted point; inverted by fixed-point steps.
  const shift = (u, v) => {
    const r2 = u * u + v * v;
    if (cam.model === 2) return [p[3] * r2 * u, p[3] * r2 * v];
    if (cam.model === 3) return [(p[3] * r2 + p[4] * r2 * r2) * u, (p[3] * r2 + p[4] * r2 * r2) * v];
    if (cam.model === 4) {
      const [k1, k2, p1, p2] = p.slice(4);
      const rad = k1 * r2 + k2 * r2 * r2;
      return [u * rad + 2 * p1 * u * v + p2 * (r2 + 2 * u * u), v * rad + 2 * p2 * u * v + p1 * (r2 + 2 * v * v)];
    }
    return [0, 0];
  };
  let u = du;
  let v = dv;
  for (let i = 0; i < 50; i++) {
    const [a, b] = shift(u, v);
    const nu = du - a;
    const nv = dv - b;
    const done = Math.abs(nu - u) + Math.abs(nv - v) < 1e-12;
    u = nu;
    v = nv;
    if (done) break;
  }
  return [u, v, 1];
}

/** The point nearest to several rays (origin, unit direction), and the widest angle between them in degrees. */
export function triangulate(rays) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const { o, d } of rays)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i] * d[j];
        A[i][j] += m;
        b[i] += m * o[j];
      }
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    [A[1][1] * A[2][2] - A[1][2] * A[2][1], A[0][2] * A[2][1] - A[0][1] * A[2][2], A[0][1] * A[1][2] - A[0][2] * A[1][1]],
    [A[1][2] * A[2][0] - A[1][0] * A[2][2], A[0][0] * A[2][2] - A[0][2] * A[2][0], A[0][2] * A[1][0] - A[0][0] * A[1][2]],
    [A[1][0] * A[2][1] - A[1][1] * A[2][0], A[0][1] * A[2][0] - A[0][0] * A[2][1], A[0][0] * A[1][1] - A[0][1] * A[1][0]],
  ].map((r) => r.map((v) => v / det));
  let widest = 0;
  for (let i = 0; i < rays.length; i++)
    for (let j = i + 1; j < rays.length; j++) {
      const c = rays[i].d[0] * rays[j].d[0] + rays[i].d[1] * rays[j].d[1] + rays[i].d[2] * rays[j].d[2];
      widest = Math.max(widest, (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI);
    }
  return { point: mulMV(inv, b), widestDeg: widest };
}

/**
 * Places a model from surveyed ground control points: each point seen in at least two posed
 * pictures is found in the model, and the similarity that fits them to their surveyed positions is
 * the placement. With four points or more, each is also checked against a fit made without it
 * (leave one out), so the checks are independent of the point they test.
 */
export function controlPlacement(images, cameras, gc) {
  const byName = new Map(images.map((im) => [im.name, im]));
  const located = [];
  const skipped = [];
  for (const p of gc.points ?? []) {
    const rays = [];
    for (const ob of p.observations ?? []) {
      const im = byName.get(ob.image);
      const cam = im && cameras.get(im.cameraId);
      const dir = cam && pixelRay(cam, ob.x, ob.y);
      if (!dir) continue;
      const w = mulMV(transpose(quatToR(im.q)), dir);
      const len = Math.hypot(w[0], w[1], w[2]);
      rays.push({ o: im.centre, d: w.map((v) => v / len) });
    }
    const t = rays.length >= 2 ? triangulate(rays) : null;
    if (!t || t.widestDeg < 2) {
      skipped.push(`${p.name} (${rays.length < 2 ? `seen in ${rays.length} posed picture${rays.length === 1 ? "" : "s"}, 2 needed` : "the pictures see it from almost the same direction"})`);
      continue;
    }
    located.push({ p, model: t.point });
  }
  if (located.length < 3) return { reason: `Only ${located.length} ground control point${located.length === 1 ? "" : "s"} could be found in the model; at least 3 are needed.${skipped.length ? ` Not used: ${skipped.slice(0, 5).join(", ")}.` : ""}`, skipped };
  const mean = (k) => located.reduce((s, x) => s + x.p[k], 0) / located.length;
  const origin = { lat: mean("lat"), lon: mean("lon"), height: mean("height") };
  const xs = located.map((x) => x.model);
  const ys = located.map((x) => toEnu(origin, x.p.lat, x.p.lon, x.p.height));
  const T = fitSimilarity(xs, ys);
  if (!T) return { reason: "The ground control points lie nearly on one line, so the model's turn cannot be fixed from them.", skipped };
  let checks = null;
  if (located.length >= 4) {
    let h = 0;
    let v = 0;
    let worst = 0;
    for (let i = 0; i < located.length; i++) {
      const Ti = fitSimilarity(xs.filter((_, j) => j !== i), ys.filter((_, j) => j !== i));
      if (!Ti) continue;
      const q = applySim(Ti, xs[i]);
      const dh2 = (q[0] - ys[i][0]) ** 2 + (q[1] - ys[i][1]) ** 2;
      const dv = q[2] - ys[i][2];
      h += dh2;
      v += dv * dv;
      worst = Math.max(worst, Math.sqrt(dh2 + dv * dv));
    }
    const r = (x) => Math.round(Math.sqrt(x / located.length) * 1000) / 1000;
    checks = { count: located.length, horizontalRms: r(h), verticalRms: r(v), max: Math.round(worst * 1000) / 1000 };
  }
  return {
    T,
    skipped,
    georef: {
      frame: "enu",
      origin,
      source: `surveyed ground control points (${located.length})`,
      horizontalCrs: `EPSG:4326 (surveyed in ${gc.crs})`,
      verticalDatum: `as surveyed (${gc.crs})`,
      metresPerModelUnit: Math.round(T.s * 1e6) / 1e6,
      controls: residuals(T, xs, ys),
      checks,
      note: checks ? "Checks: each point against a fit made without it." : "Fewer than 4 points: no independent check.",
    },
  };
}

/** The pose model before undistortion (work/sparse/<n> with the most pictures): pixels there are the pictures' own. */
function rawModel(work) {
  const sparse = path.join(work, "sparse");
  if (!existsSync(sparse)) return null;
  const dirs = readdirSync(sparse).filter((d) => existsSync(path.join(sparse, d, "images.bin")) && existsSync(path.join(sparse, d, "cameras.bin")));
  if (!dirs.length) return null;
  return dirs.map((d) => ({ d: path.join(sparse, d), n: readImages(readFileSync(path.join(sparse, d, "images.bin"))).length })).sort((a, b) => b.n - a.n)[0].d;
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
  const shifts = blockShifts(a, b, w, h, block, search).map((v) => Math.hypot(v.dx, v.dy));
  if (shifts.length < 4) return 0;
  shifts.sort((x, y) => x - y);
  return shifts[Math.floor(shifts.length * 0.75)];
}

/** Each textured block's shift between two grey frames: { x, y } is the block's centre, { dx, dy } where it went. */
export function blockShifts(a, b, w, h, block = 16, search = 6) {
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
      shifts.push({ x: bx + block / 2, y: by + block / 2, dx: bdx, dy: bdy });
    }
  return shifts;
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

/** About a twentieth of the run, dividing it exactly so the last export is the last step. */
export function exportStep(iterations) {
  for (let k = 20; k > 1; k--) if (iterations % k === 0 && iterations / k >= 100) return iterations / k;
  return iterations;
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
    for (const f of ["cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"]) if (existsSync(path.join(model, f))) copyFileSync(path.join(model, f), path.join(zero, f));
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
  const argv = fill(m.train, { ...cfg, ...m, data: o.input, train, iterations: o.iterations, maxSplats: o.maxSplats, resolution: o.resolution, shDegree: o.shDegree, threads: o.threads });
  // holo_eogs.py corrects each view's RPC with the surveyed points it sees.
  if (o.groundControl && argv.some((a) => a.endsWith("holo_eogs.py"))) argv.push("--ground-control", o.groundControl);
  await run(argv, {
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

// ---------------------------------------------------------------------------------------------
// --assess: is this capture good for splats? A quick look at the pictures, then a pose test on a
// sample. Writes <output>/report.json: { verdict, items: [{ key, severity, params }], stats }.
// Keys are translated by the app (splat.check.<key>); params fill them in.

/** Sharpness of a grey picture: variance of its Laplacian. Only compared within one capture. */
export function sharpness(g, w, h) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += l;
      s2 += l * l;
      n++;
    }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/** Mean grey level, and the shares of pixels nearly black and nearly white. */
export function exposure(g) {
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (const v of g) {
    sum += v;
    if (v < 10) lo++;
    else if (v > 245) hi++;
  }
  return { mean: sum / g.length, black: lo / g.length, white: hi / g.length };
}

/** Time ranges ("0:12–0:20") of the samples where `bad` holds, joining gaps of one sample. */
export function timeRanges(samples, bad, max = 4) {
  const out = [];
  let from = null;
  let last = null;
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const range = (a, b) => (fmt(a) === fmt(b) ? fmt(a) : `${fmt(a)}–${fmt(b)}`);
  samples.forEach((s, i) => {
    if (bad(s, i)) {
      if (from === null) from = s.t;
      last = s.t;
    } else if (from !== null && !(i + 1 < samples.length && bad(samples[i + 1], i + 1))) {
      out.push(range(from, last));
      from = null;
    }
  });
  if (from !== null) out.push(range(from, last));
  return out.slice(0, max).join(", ") + (out.length > max ? ", …" : "");
}

const MOTION_W = 160;
const MOTION_H = 90;
const MOTION_SEARCH = 10;

/**
 * The quick part for a video, from samples { t, sharp, mean, black, white, shifts } taken at a
 * steady rate (shifts: block motion from the previous sample, at 160×90). Pure, for tests.
 */
export function judgeVideo(samples, meta) {
  const items = [];
  const add = (key, severity, params = {}) => items.push({ key, severity, params });
  const pct = (x) => Math.round(x * 100);
  if (meta.height && Math.min(meta.width, meta.height) < 720) add("lowResolution", "warning", { size: `${meta.width}×${meta.height}` });
  if (meta.duration < 8) add("tooShort", "error", { seconds: Math.round(meta.duration) });
  else if (meta.duration > 15 * 60) add("veryLong", "warning", { minutes: Math.round(meta.duration / 60) });
  if (samples.length < 4) return items;

  const sharp = samples.map((s) => s.sharp).sort((a, b) => a - b);
  const median = sharp[Math.floor(sharp.length / 2)] || 1;
  const blurred = (s) => s.sharp < 0.4 * median;
  const blurShare = samples.filter(blurred).length / samples.length;
  if (blurShare > 0.25) add("blurry", blurShare > 0.5 ? "error" : "warning", { share: pct(blurShare), when: timeRanges(samples, blurred) });

  const dark = (s) => s.mean < 45 || s.black > 0.5;
  const bright = (s) => s.mean > 215 || s.white > 0.4;
  const darkShare = samples.filter(dark).length / samples.length;
  const brightShare = samples.filter(bright).length / samples.length;
  if (darkShare > 0.2) add("dark", darkShare > 0.6 ? "error" : "warning", { share: pct(darkShare), when: timeRanges(samples, dark) });
  if (brightShare > 0.2) add("bright", "warning", { share: pct(brightShare), when: timeRanges(samples, bright) });
  const jumps = samples.filter((s, i) => i > 0 && Math.abs(s.mean - samples[i - 1].mean) > 45).length;
  if (jumps >= 3) add("exposureJumps", "warning", { count: jumps });

  // Motion between samples: still, followable, too fast (block matching hit its limit).
  const moves = samples.slice(1).map((s) => {
    const m = s.shifts.map((v) => Math.hypot(v.dx, v.dy)).sort((a, b) => a - b);
    return m.length >= 4 ? m[Math.floor(m.length * 0.5)] : null;
  });
  const known = moves.filter((m) => m !== null);
  const still = (s, i) => i > 0 && moves[i - 1] !== null && moves[i - 1] < 0.5;
  const fast = (s, i) => i > 0 && moves[i - 1] !== null && moves[i - 1] >= MOTION_SEARCH - 1;
  const stillShare = known.length ? samples.filter(still).length / known.length : 0;
  const fastShare = known.length ? samples.filter(fast).length / known.length : 0;
  if (stillShare > 0.4) add("standingStill", stillShare > 0.85 ? "error" : "warning", { share: pct(stillShare), when: timeRanges(samples, still) });
  if (fastShare > 0.15) add("tooFast", "warning", { share: pct(fastShare), when: timeRanges(samples, fast) });

  // Turning in place: every block moves the same way (no parallax), so there is no depth.
  let moving = 0;
  let flat = 0;
  samples.slice(1).forEach((s, i) => {
    if (moves[i] === null || moves[i] < 1.5 || moves[i] >= MOTION_SEARCH - 1 || s.shifts.length < 8) return;
    moving++;
    const mx = s.shifts.reduce((a, v) => a + v.dx, 0) / s.shifts.length;
    const my = s.shifts.reduce((a, v) => a + v.dy, 0) / s.shifts.length;
    const spread = Math.sqrt(s.shifts.reduce((a, v) => a + (v.dx - mx) ** 2 + (v.dy - my) ** 2, 0) / s.shifts.length);
    if (spread < 0.2 * Math.hypot(mx, my)) flat++;
  });
  if (moving >= 6 && flat / moving > 0.6) add("turningInPlace", "warning", { share: pct(flat / moving) });

  // Part of the picture that does not move while the rest does: a finger, a dashboard, a mount.
  const cols = Math.floor((MOTION_W - 2 * 6) / 16);
  const rows = Math.floor((MOTION_H - 2 * 6) / 16);
  const stuck = new Map();
  let movingPairs = 0;
  samples.slice(1).forEach((s, i) => {
    if (moves[i] === null || moves[i] < 2) return;
    movingPairs++;
    for (const v of s.shifts) if (Math.hypot(v.dx, v.dy) < 0.5) stuck.set(`${v.x},${v.y}`, (stuck.get(`${v.x},${v.y}`) ?? 0) + 1);
  });
  if (movingPairs >= 6) {
    const blocks = [...stuck].filter(([, n]) => n / movingPairs > 0.7).map(([k]) => k.split(",").map(Number));
    const share = blocks.length / Math.max(1, cols * rows);
    if (share > 0.08) {
      const ys = blocks.map(([, y]) => y / MOTION_H);
      const xs = blocks.map(([x]) => x / MOTION_W);
      const avg = (a) => a.reduce((p, q) => p + q, 0) / a.length;
      const where = avg(ys) > 0.62 ? "bottom" : avg(ys) < 0.38 ? "top" : avg(xs) < 0.38 ? "left" : avg(xs) > 0.62 ? "right" : "middle";
      add("partBlocked", "warning", { share: pct(share), where });
    }
  }
  return items;
}

/**
 * What the pose test says: how many pictures got a pose, and whether the camera only moved
 * forward (along its view), which gives little depth. `cams` in picture order, with poses.
 */
export function judgePoses(cams, total) {
  const items = [];
  const share = total ? cams.length / total : 0;
  const p = { posed: cams.length, total, share: Math.round(share * 100) };
  if (cams.length < 3 || share < 0.4) items.push({ key: "posesFailed", severity: "error", params: p });
  else if (share < 0.8) items.push({ key: "posesSome", severity: "warning", params: p });
  else items.push({ key: "posesGood", severity: "ok", params: p });
  if (cams.length >= 6) {
    const along = [];
    for (let i = 1; i < cams.length; i++) {
      const d = [0, 1, 2].map((k) => cams[i].centre[k] - cams[i - 1].centre[k]);
      const n = Math.hypot(...d);
      if (n < 1e-9) continue;
      const z = quatToR(cams[i - 1].q)[2];
      along.push(Math.abs(d[0] * z[0] + d[1] * z[1] + d[2] * z[2]) / n);
    }
    along.sort((a, b) => a - b);
    const med = along.length ? along[Math.floor(along.length / 2)] : 0;
    if (along.length >= 5 && med > 0.85) items.push({ key: "forwardOnly", severity: "warning", params: { share: Math.round(med * 100) } });
  }
  return items;
}

/** One verdict from the items: any error is poor, any warning is fair, otherwise good. */
export const verdictOf = (items) => (items.some((i) => i.severity === "error") ? "poor" : items.some((i) => i.severity === "warning") ? "fair" : "good");

/** Size and length of a video or picture, from ffmpeg's header lines. */
export function parseMediaInfo(text) {
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  const v = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(text);
  const r = /Stream #[^\n]*Video:[^\n]*?([\d.]+)\s*fps/.exec(text);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    fps: r ? Number(r[1]) : 0,
  };
}

function mediaInfo(cfg, file) {
  const r = spawnSync(cfg.ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8", timeout: 60_000 });
  return parseMediaInfo(`${r.stderr ?? ""}`);
}

/** Grey frames of a video at `fps`, at two sizes: 320×180 for sharpness and light, 160×90 for motion. */
function greyFrames(cfg, file, fps, onFrame) {
  return new Promise((resolve, reject) => {
    const W = 320;
    const H = 180;
    const child = spawn(cfg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", `fps=${fps},scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let n = 0;
    let err = "";
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= W * H) {
        onFrame(new Uint8Array(buf.subarray(0, W * H)), W, H, n++);
        buf = buf.subarray(W * H);
      }
    });
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(n) : reject(new Error(`ffmpeg stopped (exit ${code}): ${err.trim().slice(-300)}`))));
  });
}

/** Halves a grey picture in each direction (box filter). */
function halve(g, w, h) {
  const out = new Uint8Array((w >> 1) * (h >> 1));
  for (let y = 0; y < h >> 1; y++)
    for (let x = 0; x < w >> 1; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * (w >> 1) + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) >> 2;
    }
  return out;
}

async function assess(cfg, o) {
  const items = [];
  const stats = {};
  const all = listFiles(o.input);
  const work = path.join(o.output, "work");
  mkdirSync(work, { recursive: true });
  const images = path.join(work, "images");
  mkdirSync(images, { recursive: true });
  let names = [];
  progress(0.02, "look");
  if (o.inputKind === "video") {
    const videos = all.filter((f) => VIDEO.test(f));
    if (videos.length !== 1) items.push({ key: videos.length ? "manyVideos" : "noVideo", severity: "error", params: { count: videos.length } });
    else {
      const meta = mediaInfo(cfg, videos[0]);
      Object.assign(stats, { duration: Math.round(meta.duration), width: meta.width, height: meta.height, fps: meta.fps });
      const fps = meta.duration > 0 ? Math.min(2, 600 / meta.duration) : 2;
      const samples = [];
      let prev = null;
      await greyFrames(cfg, videos[0], fps, (g, w, h, n) => {
        const small = halve(g, w, h);
        samples.push({ t: n / fps, sharp: sharpness(g, w, h), ...exposure(g), shifts: prev ? blockShifts(prev, small, MOTION_W, MOTION_H, 16, MOTION_SEARCH) : [] });
        prev = small;
        if (meta.duration) progress(0.02 + 0.3 * Math.min(1, n / fps / meta.duration), "look");
      });
      stats.samples = samples.length;
      items.push(...judgeVideo(samples, meta));
      const csv = all.some((f) => path.basename(f).toLowerCase() === "camera-gnss.csv");
      const srt = all.some((f) => /\.srt$/i.test(f));
      items.push(csv || srt ? { key: "positionsFound", severity: "ok", params: { source: csv ? "camera-gnss.csv" : ".SRT" } } : { key: "noPositions", severity: "info", params: {} });
      if (!items.some((i) => i.severity === "error")) {
        progress(0.35, "frames");
        // The pose test: frames picked as for training, at most 100, at 640 px.
        const picked = await videoFrames(cfg, videos[0], images, { resolution: 640, videoFps: 2 });
        const keep = new Set(picked.filter((_, i) => i % Math.ceil(picked.length / 100) === 0).map((f) => f.name));
        for (const f of picked) if (!keep.has(f.name)) rmSync(path.join(images, f.name), { force: true });
        names = [...keep];
      }
    }
  } else if (o.inputKind === "photos") {
    const photos = all.filter((f) => PHOTO.test(f));
    stats.photos = photos.length;
    if (photos.length < 3) items.push({ key: "fewPhotos", severity: "error", params: { count: photos.length } });
    else {
      if (photos.length < 20) items.push({ key: "somePhotos", severity: "warning", params: { count: photos.length } });
      let gps = 0;
      let small = 0;
      const sharp = [];
      const light = [];
      const step = Math.max(1, Math.ceil(photos.length / 200));
      for (const [i, f] of photos.entries()) {
        if (/\.jpe?g$/i.test(f) && exifGps(readFileSync(f))) gps++;
        if (i % step) continue;
        const meta = mediaInfo(cfg, f);
        if (meta.height && Math.min(meta.width, meta.height) < 720) small++;
        const r = spawnSync(cfg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale=320:180,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 20, timeout: 60_000 });
        if (r.status === 0 && r.stdout?.length === 320 * 180) {
          const g = new Uint8Array(r.stdout);
          sharp.push({ name: path.basename(f), v: sharpness(g, 320, 180) });
          light.push(exposure(g));
        }
        progress(0.02 + 0.3 * (i / photos.length), "look");
      }
      const sorted = sharp.map((x) => x.v).sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)] || 1;
      const blurred = sharp.filter((x) => x.v < 0.4 * med);
      if (sharp.length >= 4 && blurred.length / sharp.length > 0.2) items.push({ key: "blurryPhotos", severity: "warning", params: { count: blurred.length, examples: blurred.slice(0, 3).map((x) => x.name).join(", ") } });
      const dark = light.filter((l) => l.mean < 45 || l.black > 0.5).length;
      if (light.length && dark / light.length > 0.2) items.push({ key: "darkPhotos", severity: "warning", params: { count: dark } });
      if (small) items.push({ key: "smallPhotos", severity: "warning", params: { count: small } });
      items.push(gps >= 3 ? { key: "photoGps", severity: "ok", params: { count: gps } } : { key: "noPositions", severity: "info", params: {} });
      // The pose test: at most 80 photos, made smaller.
      const pick = photos.filter((_, i) => i % Math.max(1, Math.ceil(photos.length / 80)) === 0);
      for (const f of pick) {
        let name = path.basename(f).replace(/\.[^.]+$/, ".jpg");
        while (names.includes(name)) name = `x${name}`;
        const r = spawnSync(cfg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-y", path.join(images, name)], { timeout: 120_000 });
        if (r.status === 0) names.push(name);
      }
    }
  }
  if (o.groundControl) {
    const gc = JSON.parse(readFileSync(o.groundControl, "utf8"));
    const have = new Set(all.map((f) => path.basename(f)));
    const seen = gc.points.filter((p) => p.observations.filter((ob) => have.has(ob.image)).length >= 2).length;
    items.push(
      o.inputKind === "video"
        ? { key: "gcpVideo", severity: "info", params: { count: gc.points.length } }
        : seen >= 3
          ? { key: "gcpGood", severity: "ok", params: { count: seen, total: gc.points.length } }
          : { key: "gcpFew", severity: "warning", params: { count: seen, total: gc.points.length } },
    );
  }

  if (names.length >= 3) {
    progress(0.45, "poses");
    try {
      const { model } = await sfm(cfg, images, work, { ...o, threads: o.threads }, o.inputKind === "video");
      const cams = readImages(readFileSync(path.join(model, "images.bin"))).sort((a, b) => (a.name < b.name ? -1 : 1));
      items.push(...judgePoses(cams, names.length));
      stats.posed = cams.length;
      stats.tested = names.length;
    } catch (e) {
      say(`pose test: ${e instanceof Error ? e.message : String(e)}`);
      items.push({ key: "posesFailed", severity: "error", params: { posed: 0, total: names.length, share: 0 } });
    }
  }
  const order = { error: 0, warning: 1, info: 2, ok: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  const report = { verdict: verdictOf(items), items, stats };
  rmSync(work, { recursive: true, force: true });
  writeFileSync(path.join(o.output, "report.json"), JSON.stringify(report));
  progress(1, "done");
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
  if (argv[0] === "--assess") {
    const o = {};
    for (let i = 1; i < argv.length; i += 2) o[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
    for (const k of ["input", "inputKind", "output"]) if (!o[k]) throw new Error(`Missing --${k}`);
    o.threads = Number.parseInt(o.threads ?? "4", 10);
    return assess(cfg, o);
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
  if (o.groundControl) {
    // Surveyed points come first: they measure the ground, not the camera.
    const raw = rawModel(work);
    const gc = JSON.parse(readFileSync(o.groundControl, "utf8"));
    const g = raw ? controlPlacement(readImages(readFileSync(path.join(raw, "images.bin"))), readCameras(readFileSync(path.join(raw, "cameras.bin"))), gc) : { reason: "The pose step left no model to find the ground control points in.", skipped: [] };
    if (g.skipped?.length) say(`ground control: not used ${g.skipped.join("; ")}`);
    if (g.reason) {
      georefNote = `Ground control not used: ${g.reason}`;
      say(georefNote);
    } else {
      transformModel(model, g.T);
      georef = g.georef;
      say(`ground control: placed from ${g.georef.source}, controls ${g.georef.controls.horizontalRms} m across, ${g.georef.controls.verticalRms} m up`);
    }
  }
  if (!georef && source && o.goal !== "satellite") {
    const g = georeference(cams, fixes, source);
    if (g.reason) georefNote = georefNote ? `${georefNote} ${g.reason}` : g.reason;
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
  const values = { ...cfg, ...m, data, train, iterations: o.iterations, exportEvery: exportStep(o.iterations), maxSplats: o.maxSplats, resolution: o.resolution, shDegree: o.shDegree, threads: o.threads, iter: "{iter}" };
  // A trainer that only writes numbered exports (export_<step>.ply): read progress from them, and
  // keep only the newest two so a long run does not fill the disk.
  const watch = m.progressFiles
    ? setInterval(() => {
        const steps = listFiles(train)
          .map((f) => ({ f, n: Number(/_(\d+)\.ply$/.exec(f)?.[1]) }))
          .filter((x) => Number.isFinite(x.n))
          .sort((a, b) => b.n - a.n);
        if (!steps.length) return;
        if (steps[0].n <= o.iterations) progress(0.3 + 0.65 * (steps[0].n / o.iterations), "train");
        // The newest may still be being written; older ones are finished and no longer needed.
        for (const x of steps.slice(2)) rmSync(x.f, { force: true });
      }, 10_000)
    : null;
  try {
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
  } finally {
    if (watch) clearInterval(watch);
  }
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

// Run as a program (also through a symlinked folder, as the home-folder install's "current" is).
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof InputError ? 2 : 1);
  });
}
