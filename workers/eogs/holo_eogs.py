#!/usr/bin/env python3
"""HOLO's bridge to EOGS++ (docs/GAUSSIAN_SPLATS.md, "Satellite images with EOGS++"; SRS GS-09).

EOGS++ (https://github.com/gardiens/EOGS2) trains Gaussian splats from satellite views with RPC
camera models, but it is written for its benchmark scenes. This script lets HOLO's worker run it
on any capture, in four steps, all inside the worker's own work folder:

  prepare   finds the images and their RPC models, cuts every view to the area all of them see
            (no bigger than the preset's resolution), scales the grey values to 0-255, and writes
            the folder layout EOGS++ reads (images, RPC JSON with sun angles, train/test split).
  to_affine EOGS++'s own step that fits an affine camera to every RPC.
  train     EOGS++'s full_eval_pan.py: training, rendering, DSM and TSDF.
  convert   moves the splats from EOGS++'s normalised UTM frame to metres east, north and up of a
            point on the ground (WGS 84), and writes georef.json so HOLO places the model.

It installs nothing and never changes the capture. EOGS++ needs three small source changes to run
on a scene that is not one of its benchmarks; `patch` makes them once (each one checked against
the exact upstream text first, the original kept beside it as .holo-orig), and `check` says
whether they are in place.

  holo_eogs.py check --eogs REPO
  holo_eogs.py patch --eogs REPO [--undo]
  holo_eogs.py run --eogs REPO --data CAPTURE --train DIR --iterations N [--max-size PX]
                   [--alt-range MIN,MAX] [--keep-dsm DIR]

Exit 0: done. Exit 2: the capture cannot be used (said on stderr in plain words). Exit 1: a tool
failed. Python 3.8 or later (EOGS++ uses 3.9), with the packages EOGS++ itself installs.
"""
import argparse
import datetime as dt
import glob
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys

MARK = "HOLO-EOGS"
IMAGE = re.compile(r"\.(tiff?|ntf|nitf|jp2)$", re.I)


class InputError(Exception):
    """The capture cannot be used; the message says why in plain words."""


def say(text):
    sys.stderr.write("%s %s\n" % (dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), text))
    sys.stderr.flush()


# ---------------------------------------------------------------------------------------------
# Source changes EOGS++ needs for a scene of its own (upstream revision cdd21aeb).

PATCHES = [
    (
        "scripts/dataset_creation/to_affine.py",
        '''    assert scene_name in [
        "JAX_004",
        "JAX_068",
        "JAX_214",
        "JAX_260",
        "IARPA_001",
        "IARPA_002",
        "IARPA_003",
    ], f"scene_name not in the list of available scenes, got {scene_name}"
''',
        '''    # HOLO-EOGS: any scene named with letters, digits and underscores, not only the benchmarks.
    assert __import__("re").fullmatch(r"[A-Za-z0-9_]+", scene_name), f"scene_name must be letters, digits and underscores, got {scene_name}"
''',
    ),
    (
        "src/gaussiansplatting/utils/dsm_utils.py",
        '''    else:
        raise ValueError("Unknown sceneparams,got {}.".format(scene_name))
''',
        '''    else:  # HOLO-EOGS: another scene gives its ground sample distance in HOLO_EOGS_GSD
        resolution = float(__import__("os").environ.get("HOLO_EOGS_GSD", "0.5"))
''',
    ),
    (
        "src/gaussiansplatting/tsdf.py",
        '''        resolution=(0.3 if "IARPA" in scene_name else 0.5),
''',
        '''        resolution=(0.3 if "IARPA" in scene_name else 0.5 if "JAX" in scene_name else float(__import__("os").environ.get("HOLO_EOGS_GSD", "0.5"))),  # HOLO-EOGS
''',
    ),
    (
        "src/gaussiansplatting/eval/eval_dsm.py",
        '''        gt_dsm, water_mask, vis_mask, tree_mask, ulx, uly, lrx, lry = self.preprocess(
            gt_dir, aoi_id, enable_vis_mask, True
        )
''',
        '''        # HOLO-EOGS: a new scene has no reference DSM; then nothing is compared and MAE is NaN.
        self.no_gt = not os.path.exists(os.path.join(gt_dir, "{}_DSM.tif".format(aoi_id)))
        if self.no_gt:
            self.gt_dsm = None
            self.tree_mask = None
            self._gt_dsm_masked = None
            return
        gt_dsm, water_mask, vis_mask, tree_mask, ulx, uly, lrx, lry = self.preprocess(
            gt_dir, aoi_id, enable_vis_mask, True
        )
''',
    ),
    (
        "src/gaussiansplatting/eval/eval_dsm.py",
        '''        with rasterio.open(pred_dsm_path, "r") as f:
            pred_dsm, profile = self.pred_dsm_rasterio(f=f)
''',
        '''        with rasterio.open(pred_dsm_path, "r") as f:
            if getattr(self, "no_gt", False):  # HOLO-EOGS: no reference to crop to
                return f.read(1), f.profile
            pred_dsm, profile = self.pred_dsm_rasterio(f=f)
''',
    ),
    (
        "src/gaussiansplatting/eval/eval_dsm.py",
        '''        pred_dsm, profile = self.load_pred_dsm_from_path(pred_dsm_path)
        gt_dsm = self.get_gt_dsm(force_use_tree_mask=force_use_tree_mask)
''',
        '''        pred_dsm, profile = self.load_pred_dsm_from_path(pred_dsm_path)
        if getattr(self, "no_gt", False):  # HOLO-EOGS
            return float("nan"), np.zeros_like(pred_dsm), pred_dsm, profile, pred_dsm
        gt_dsm = self.get_gt_dsm(force_use_tree_mask=force_use_tree_mask)
''',
    ),
    (
        "src/gaussiansplatting/eval/eval_dsm.py",
        '''        self, pred_dsm, profile, force_use_tree_mask: bool = False
    ):
        gt_dsm = self.get_gt_dsm(force_use_tree_mask=force_use_tree_mask)
''',
        '''        self, pred_dsm, profile, force_use_tree_mask: bool = False
    ):
        if getattr(self, "no_gt", False):  # HOLO-EOGS
            return float("nan"), np.zeros_like(pred_dsm), pred_dsm, profile
        gt_dsm = self.get_gt_dsm(force_use_tree_mask=force_use_tree_mask)
''',
    ),
]


def patch_state(repo):
    """For every change: 'done', 'todo' (upstream text found once) or 'unknown' (neither)."""
    out = []
    for rel, old, new in PATCHES:
        p = os.path.join(repo, rel)
        text = open(p, encoding="utf8").read() if os.path.isfile(p) else ""
        out.append((rel, "done" if new in text else "todo" if text.count(old) == 1 else "unknown"))
    return out


def patch(repo, undo=False):
    files = sorted({rel for rel, _, _ in PATCHES})
    if undo:
        for rel in files:
            p = os.path.join(repo, rel)
            if os.path.isfile(p + ".holo-orig"):
                shutil.copyfile(p + ".holo-orig", p)
                os.remove(p + ".holo-orig")
                say("restored %s" % rel)
        return 0
    state = patch_state(repo)
    bad = [rel for rel, s in state if s == "unknown"]
    if bad:
        # Nothing is written unless every change can be made: a different EOGS++ release needs a look.
        raise SystemExit("These files are not as expected (another EOGS++ revision?), nothing was changed: %s" % ", ".join(sorted(set(bad))))
    texts = {rel: open(os.path.join(repo, rel), encoding="utf8").read() for rel in files}
    for rel, old, new in PATCHES:
        if new not in texts[rel]:
            texts[rel] = texts[rel].replace(old, new, 1)
    for rel in files:
        p = os.path.join(repo, rel)
        if open(p, encoding="utf8").read() == texts[rel]:
            continue
        if not os.path.exists(p + ".holo-orig"):
            shutil.copyfile(p, p + ".holo-orig")
        with open(p, "w", encoding="utf8") as f:
            f.write(texts[rel])
        say("changed %s" % rel)
    return 0


def check(repo):
    problems = []
    if not os.path.isfile(os.path.join(repo, "src/gaussiansplatting/full_eval_pan.py")):
        problems.append("%s is not an EOGS++ source folder (no src/gaussiansplatting/full_eval_pan.py)." % repo)
    else:
        todo = sorted({rel for rel, s in patch_state(repo) if s != "done"})
        if todo:
            problems.append("EOGS++ is not prepared for new scenes yet: run holo_eogs.py patch --eogs %s (files: %s)." % (repo, ", ".join(todo)))
    for mod in ["numpy", "rasterio", "rpcm", "utm", "plyfile", "hydra", "iio", "plyflatten", "diff_gaussian_rasterization", "simple_knn"]:
        try:
            __import__(mod)
        except Exception as e:  # noqa: BLE001 - any import failure is a missing piece
            problems.append("Python module %s is missing or broken (%s)." % (mod, str(e).splitlines()[0][:120] if str(e) else type(e).__name__))
    try:
        import torch

        if not torch.cuda.is_available():
            problems.append("PyTorch cannot see a CUDA GPU.")
    except Exception as e:  # noqa: BLE001
        problems.append("PyTorch is missing or broken (%s)." % str(e).splitlines()[0][:120])
    for p in problems:
        say(p)
    rev = ""
    try:
        rev = subprocess.run(["git", "-C", repo, "rev-parse", "--short=12", "HEAD"], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    print("EOGS++ %s" % (rev or "source"))
    return 1 if problems else 0


# ---------------------------------------------------------------------------------------------
# Geometry: WGS 84 and east-north-up

A_WGS = 6378137.0
F_WGS = 1 / 298.257223563
E2 = F_WGS * (2 - F_WGS)


def ecef(lat, lon, h):
    import numpy as np

    p, l = np.radians(lat), np.radians(lon)
    n = A_WGS / np.sqrt(1 - E2 * np.sin(p) ** 2)
    return np.stack([(n + h) * np.cos(p) * np.cos(l), (n + h) * np.cos(p) * np.sin(l), (n * (1 - E2) + h) * np.sin(p)], axis=-1)


def enu(origin, lat, lon, h):
    """Metres east, north and up of origin (lat, lon, height) for arrays of points."""
    import numpy as np

    o = ecef(origin[0], origin[1], origin[2])
    d = ecef(lat, lon, h) - o
    p, l = math.radians(origin[0]), math.radians(origin[1])
    r = np.array(
        [
            [-math.sin(l), math.cos(l), 0.0],
            [-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p)],
            [math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p)],
        ]
    )
    return d @ r.T


def metres_per_degree(lat):
    """Metres per degree of latitude and of longitude at a latitude (WGS 84)."""
    p = math.radians(lat)
    m = A_WGS * (1 - E2) / (1 - E2 * math.sin(p) ** 2) ** 1.5
    n = A_WGS / math.sqrt(1 - E2 * math.sin(p) ** 2)
    return math.radians(1) * m, math.radians(1) * n * math.cos(p)


def quat_from_matrix(m):
    """(w, x, y, z) of a rotation matrix."""
    t = m[0][0] + m[1][1] + m[2][2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2
        q = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]
    elif m[1][1] > m[2][2]:
        s = math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2
        q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]
    else:
        s = math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2
        q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]
    return q


def quat_mul(a, b):
    """a * b for a single quaternion a and an (N, 4) array b, both (w, x, y, z)."""
    import numpy as np

    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack(
        [
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        ],
        axis=1,
    )


def sun_angles(when, lat, lon):
    """Sun azimuth (from north, clockwise) and elevation in degrees at a UTC time (about 0.1 deg)."""
    n = when.timestamp() / 86400.0 + 2440587.5 - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    ha = math.radians(gmst * 15 + lon) - ra
    p = math.radians(lat)
    el = math.asin(math.sin(p) * math.sin(dec) + math.cos(p) * math.cos(dec) * math.cos(ha))
    az = math.atan2(-math.sin(ha), math.tan(dec) * math.cos(p) - math.sin(p) * math.cos(ha))
    return math.degrees(az) % 360, math.degrees(el)


# ---------------------------------------------------------------------------------------------
# Reading a capture: images, RPC models, sun angles

RPB_KEYS = {
    "lineoffset": "LINE_OFF", "sampoffset": "SAMP_OFF", "latoffset": "LAT_OFF", "longoffset": "LONG_OFF", "heightoffset": "HEIGHT_OFF",
    "linescale": "LINE_SCALE", "sampscale": "SAMP_SCALE", "latscale": "LAT_SCALE", "longscale": "LONG_SCALE", "heightscale": "HEIGHT_SCALE",
    "linenumcoef": "LINE_NUM_COEFF", "linedencoef": "LINE_DEN_COEFF", "sampnumcoef": "SAMP_NUM_COEFF", "sampdencoef": "SAMP_DEN_COEFF",
}


def parse_rpb(text):
    """A Maxar .RPB file as GDAL's RPC metadata dictionary."""
    d = {}
    for k, v in re.findall(r"(\w+)\s*=\s*\(([^)]*)\)", text):
        if k.lower() in RPB_KEYS:
            d[RPB_KEYS[k.lower()]] = " ".join(x.strip() for x in v.replace("\n", " ").split(",") if x.strip())
    for k, v in re.findall(r"(\w+)\s*=\s*([-+0-9.Ee]+)\s*;", text):
        if k.lower() in RPB_KEYS:
            d[RPB_KEYS[k.lower()]] = v
    return d if len(d) == len(RPB_KEYS) else None


def read_rpc(path):
    """The RPC model of an image: inside it or in a sidecar GDAL finds (.RPB, _RPC.TXT), else read here."""
    import rasterio
    import rpcm

    try:
        with rasterio.open(path) as src:
            tags = src.tags(ns="RPC")
        if tags.get("LINE_NUM_COEFF"):
            return rpcm.RPCModel(tags)
    except Exception:  # noqa: BLE001 - an unreadable image is reported by the caller
        pass
    stem = os.path.splitext(path)[0]
    for side in [stem + e for e in (".RPB", ".rpb", "_RPC.TXT", "_rpc.txt", ".RPC", ".rpc", "_RPC.RPB", "_rpc.rpb")]:
        if os.path.isfile(side):
            text = open(side, encoding="utf8", errors="replace").read()
            d = parse_rpb(text) if "lineOffset" in text or "lineNumCoef" in text else None
            if d:
                return rpcm.RPCModel(d)
            return rpcm.rpc_from_rpc_file(side)
    return None


def read_meta(text):
    """Sun azimuth, elevation and acquisition time from Maxar .IMD or .XML, or Airbus DIMAP."""

    def num(*patterns):
        for pat in patterns:
            m = re.search(pat, text, re.I)
            if m:
                return float(m.group(1))
        return None

    az = num(r"meanSunAz\s*=\s*(-?[\d.]+)", r"<MEANSUNAZ>\s*(-?[\d.]+)", r"<SUN_AZIMUTH[^>]*>\s*(-?[\d.]+)")
    el = num(r"meanSunEl\s*=\s*(-?[\d.]+)", r"<MEANSUNEL>\s*(-?[\d.]+)", r"<SUN_ELEVATION[^>]*>\s*(-?[\d.]+)")
    when = None
    m = re.search(r"firstLineTime\s*=\s*([0-9T:.\-]+Z?)", text, re.I) or re.search(r"<FIRSTLINETIME>\s*([0-9T:.\-]+Z?)", text, re.I)
    if m:
        when = m.group(1)
    else:
        d = re.search(r"<IMAGING_DATE>\s*([\d-]+)", text, re.I)
        t = re.search(r"<IMAGING_TIME>\s*([\d:.]+)", text, re.I)
        if d:
            when = d.group(1) + ("T" + t.group(1) if t else "T12:00:00")
    return az, el, parse_time(when)


def parse_time(s):
    if not s:
        return None
    s = s.strip().rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y%m%d%H%M%S", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s[:26], fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def view_meta(path):
    """Sun angles and time for one image from a sidecar with the same name, or the NITF date."""
    stem = os.path.splitext(path)[0]
    for side in [stem + e for e in (".IMD", ".imd", ".XML", ".xml")]:
        if os.path.isfile(side):
            az, el, when = read_meta(open(side, encoding="utf8", errors="replace").read())
            if (az is not None and el is not None) or when:
                return az, el, when
    try:
        import rasterio

        with rasterio.open(path) as src:
            return None, None, parse_time(src.tags().get("NITF_IDATIM", ""))
    except Exception:  # noqa: BLE001
        return None, None, None


def find_views(data):
    files = []
    for root, _, names in os.walk(data):
        for n in names:
            if IMAGE.search(n):
                files.append(os.path.join(root, n))
    return sorted(files)


# ---------------------------------------------------------------------------------------------
# Ground control: surveyed points correct each view's RPC (bias compensation)

def rpc_intersect(sights, h0):
    """Where the views' rays through their pixels meet: (lon, lat, height), by Gauss-Newton on pixel error."""
    import numpy as np

    rpc, col, row = sights[0]
    lon, lat = rpc.localization(col, row, h0)
    x = np.array([float(lon), float(lat), float(h0)])
    steps = np.array([1e-6, 1e-6, 0.5])

    def resid(v):
        out = []
        for r, c, w in sights:
            pc, pr = r.projection(v[0], v[1], v[2])
            out += [float(pc) - c, float(pr) - w]
        return np.array(out)

    for _ in range(15):
        r0 = resid(x)
        J = np.stack([(resid(x + np.eye(3)[k] * steps[k]) - r0) / steps[k] for k in range(3)], axis=1)
        dx, *_ = np.linalg.lstsq(J, -r0, rcond=None)
        x = x + dx
        if abs(dx[0]) < 1e-10 and abs(dx[1]) < 1e-10 and abs(dx[2]) < 1e-4:
            break
    return x


def read_ground_control(path):
    with open(path, encoding="utf8") as f:
        gc = json.load(f)
    return gc.get("crs", "unknown"), [p for p in gc.get("points", []) if p.get("observations")]


def biases(views, points, leave_out=None):
    """Each view's mean pixel offset (observed minus the RPC's projection) over the points it sees."""
    out = {}
    for i, v in enumerate(views):
        d = []
        for k, p in enumerate(points):
            if k == leave_out:
                continue
            for ob in p["observations"]:
                if ob["image"] == os.path.basename(v["file"]):
                    c, r = v["rpc0"].projection(p["lon"], p["lat"], p["height"])
                    d.append((ob["x"] - float(c), ob["y"] - float(r)))
        if d:
            out[i] = (sum(a for a, _ in d) / len(d), sum(b for _, b in d) / len(d))
    return out


def shifted(rpc, shift):
    import copy

    r = copy.deepcopy(rpc)
    if shift:
        r.col_offset = float(r.col_offset) + shift[0]
        r.row_offset = float(r.row_offset) + shift[1]
    return r


def control_residuals(views, points, leave_out_each):
    """Surveyed minus measured position of every point seen in two views or more, in metres (east, north, up)."""
    import numpy as np

    errs = []
    full = biases(views, points)
    for k, p in enumerate(points):
        b = biases(views, points, leave_out=k) if leave_out_each else full
        sights = []
        for i, v in enumerate(views):
            for ob in p["observations"]:
                if ob["image"] == os.path.basename(v["file"]):
                    sights.append((shifted(v["rpc0"], b.get(i)), ob["x"], ob["y"]))
        if len(sights) < 2:
            continue
        lon, lat, h = rpc_intersect(sights, p["height"])
        my, mx = metres_per_degree(p["lat"])
        errs.append(((lon - p["lon"]) * mx, (lat - p["lat"]) * my, h - p["height"]))
    if not errs:
        return None
    e = np.array(errs)
    hz = np.hypot(e[:, 0], e[:, 1])
    return {"count": len(errs), "horizontalRms": round(float(np.sqrt(np.mean(hz**2))), 3), "verticalRms": round(float(np.sqrt(np.mean(e[:, 2] ** 2))), 3), "max": round(float(np.max(np.hypot(hz, e[:, 2]))), 3)}


def apply_ground_control(views, path):
    """Corrects the views' RPCs in place with the surveyed points they see; returns what to report, or None."""
    crs, points = read_ground_control(path)
    for v in views:
        v["rpc0"] = v["rpc"]
    b = biases(views, points)
    names = {os.path.basename(v["file"]) for v in views}
    seen = [p for p in points if any(ob["image"] in names for ob in p["observations"])]
    if not b:
        say("ground control: no point is marked in these satellite views; RPCs used as delivered")
        return None
    for i, v in enumerate(views):
        v["rpc"] = shifted(v["rpc0"], b.get(i))
        if i in b:
            say("ground control: %s moved %.2f px across, %.2f px down" % (os.path.basename(v["file"]), b[i][0], b[i][1]))
    uncorrected = [os.path.basename(v["file"]) for i, v in enumerate(views) if i not in b]
    if uncorrected:
        say("ground control: no point marked in %s; left as delivered" % ", ".join(uncorrected))
    return {
        "crs": crs,
        "points": len(seen),
        "views": len(b),
        "controls": control_residuals(views, seen, False),
        "checks": control_residuals(views, seen, True) if len(seen) >= 2 else None,
    }


# ---------------------------------------------------------------------------------------------
# prepare: the EOGS++ data layout for one capture

def gsd_of(rpc, col, row, h):
    """Ground metres per pixel of a view near a pixel, at a height."""
    lon0, lat0 = rpc.localization(col, row, h)
    lon1, lat1 = rpc.localization(col + 10, row, h)
    lon2, lat2 = rpc.localization(col, row + 10, h)
    my, mx = metres_per_degree(float(lat0))
    ex = ((float(lon1) - float(lon0)) * mx, (float(lat1) - float(lat0)) * my)
    ey = ((float(lon2) - float(lon0)) * mx, (float(lat2) - float(lat0)) * my)
    return math.sqrt(abs(ex[0] * ey[1] - ex[1] * ey[0])) / 10


def prepare(data, work, scene, max_size, alt_range=None, ground_control=None):
    """Writes work/data/... for EOGS++ and returns a summary of what it made."""
    import numpy as np
    import rasterio
    from rasterio.windows import Window

    files = find_views(data)
    if not files:
        raise InputError("The capture has no satellite images (TIFF, NITF or JPEG 2000).")
    views = []
    skipped = []
    for f in files:
        try:
            with rasterio.open(f) as src:
                w, h, bands = src.width, src.height, src.count
        except Exception:  # noqa: BLE001
            skipped.append("%s (cannot be read)" % os.path.basename(f))
            continue
        rpc = read_rpc(f)
        if rpc is None:
            skipped.append("%s (no RPC model)" % os.path.basename(f))
            continue
        views.append({"file": f, "w": w, "h": h, "bands": bands, "rpc": rpc})
    # Panchromatic views when the capture mixes them with multispectral ones.
    if any(v["bands"] == 1 for v in views) and any(v["bands"] > 1 for v in views):
        skipped += ["%s (multispectral; the panchromatic views are used)" % os.path.basename(v["file"]) for v in views if v["bands"] > 1]
        views = [v for v in views if v["bands"] == 1]
    for s in skipped:
        say("view left out: %s" % s)
    if len(views) < 2:
        raise InputError("At least two satellite views with RPC models are needed; %d found." % len(views))
    gcp = apply_ground_control(views, ground_control) if ground_control else None

    h0 = float(np.median([v["rpc"].alt_offset for v in views]))
    lo_alt, hi_alt = alt_range if alt_range else (h0 - 100.0, h0 + 150.0)
    # The ground all views see: the overlap of their footprints at the scene height.
    boxes = []
    for v in views:
        cols = [0, v["w"] - 1, 0, v["w"] - 1]
        rows = [0, 0, v["h"] - 1, v["h"] - 1]
        lon, lat = v["rpc"].localization(cols, rows, [h0] * 4)
        boxes.append((float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat))))
    west, south = max(b[0] for b in boxes), max(b[1] for b in boxes)
    east, north = min(b[2] for b in boxes), min(b[3] for b in boxes)
    if west >= east or south >= north:
        raise InputError("The satellite views do not overlap: they show different places.")
    lon_c, lat_c = (west + east) / 2, (south + north) / 2
    gsd = float(np.median([gsd_of(v["rpc"], v["w"] / 2, v["h"] / 2, h0) for v in views]))
    my, mx = metres_per_degree(lat_c)
    half = min((east - west) / 2 * mx, (north - south) / 2 * my, max_size * gsd / 2)
    say("scene: %d views, ground sample %.2f m, area %.0f x %.0f m, heights %.0f to %.0f m" % (len(views), gsd, 2 * half, 2 * half, lo_alt, hi_alt))

    pan_dir = os.path.join(work, "data", "images", "pan", scene)
    msi_dir = os.path.join(work, "data", "images", "msi", scene)
    rpc_dir = os.path.join(work, "data", "rpcs", "rpc_raw", scene)
    split_dir = os.path.join(work, "data", "train_test_split", scene)
    for d in (pan_dir, msi_dir, rpc_dir, split_dir, os.path.join(work, "data", "Truth")):
        os.makedirs(d, exist_ok=True)

    dlon, dlat = half / mx, half / my
    crops = []
    for i, v in enumerate(views):
        lons = [lon_c - dlon, lon_c + dlon] * 2
        lats = [lat_c - dlat] * 2 + [lat_c + dlat] * 2
        cols, rows = [], []
        for a in (lo_alt, hi_alt):
            c, r = v["rpc"].projection(lons, lats, [a] * 4)
            cols += list(np.atleast_1d(c))
            rows += list(np.atleast_1d(r))
        x0, x1 = max(0, int(math.floor(min(cols)))), min(v["w"], int(math.ceil(max(cols))) + 1)
        y0, y1 = max(0, int(math.floor(min(rows)))), min(v["h"], int(math.ceil(max(rows))) + 1)
        if x1 - x0 < 64 or y1 - y0 < 64:
            say("view left out: %s (the shared area falls outside it)" % os.path.basename(v["file"]))
            continue
        with rasterio.open(v["file"]) as src:
            px = src.read(window=Window(x0, y0, x1 - x0, y1 - y0)).astype("float32")
            nodata = src.nodata
        px = px.mean(axis=0) if px.shape[0] > 1 else px[0]
        crops.append({"view": v, "px": px, "x0": x0, "y0": y0, "nodata": nodata, "name": "view_%02d" % (i + 1)})
    if len(crops) < 2:
        raise InputError("Fewer than two views cover the shared area.")

    # One grey scale for all views (0.5 and 99.5 percentiles), so the same ground looks the same.
    samples = []
    for c in crops:
        p = c["px"][:: max(1, c["px"].shape[0] // 256), :: max(1, c["px"].shape[1] // 256)].ravel()
        p = p[np.isfinite(p) & (p != (c["nodata"] if c["nodata"] is not None else 0))]
        samples.append(p)
    pool = np.concatenate(samples) if samples else np.array([0.0, 1.0])
    lo, hi = np.percentile(pool, [0.5, 99.5]) if pool.size else (0.0, 1.0)
    hi = hi if hi > lo else lo + 1

    names = []
    for c in crops:
        v, name = c["view"], c["name"]
        img = (np.clip((c["px"] - lo) / (hi - lo), 0, 1) * 255).astype("float32")
        hh, ww = img.shape
        with rasterio.open(os.path.join(pan_dir, name + ".tif"), "w", driver="GTiff", width=ww, height=hh, count=1, dtype="float32") as dst:
            dst.write(img, 1)
        link = os.path.join(msi_dir, name + ".tif")
        if not os.path.exists(link):
            # EOGS++'s camera step also opens a multispectral copy; the panchromatic one stands in.
            try:
                os.symlink(os.path.abspath(os.path.join(pan_dir, name + ".tif")), link)
            except OSError:
                shutil.copyfile(os.path.join(pan_dir, name + ".tif"), link)
        rpc = v["rpc"]
        d = dict(rpc.__dict__)
        d["row_offset"] = float(d["row_offset"]) - c["y0"]
        d["col_offset"] = float(d["col_offset"]) - c["x0"]
        az, el, when = view_meta(v["file"])
        if az is None or el is None:
            if not when:
                raise InputError("%s has no sun angles or acquisition time: add its .IMD or .XML metadata file with the same name." % os.path.basename(v["file"]))
            az, el = sun_angles(when, lat_c, lon_c)
        meta = {
            "img": name + ".tif",
            "height": hh,
            "width": ww,
            "sun_elevation": round(el, 4),
            "sun_azimuth": round(az % 360, 4),
            "acquisition_date": when.strftime("%Y%m%d%H%M%S") if when else "",
            "min_alt": lo_alt,
            "max_alt": hi_alt,
            "rpc": d,
        }
        with open(os.path.join(rpc_dir, name + ".json"), "w") as f:
            json.dump(meta, f, indent=1)
        names.append(name)
    # Hold one view back as a check when there are enough; the nadir camera is always a test view.
    test = [names[len(names) // 2]] if len(names) >= 8 else []
    with open(os.path.join(split_dir, "train.txt"), "w") as f:
        f.write("".join(n + ".json\n" for n in names if n not in test))
    with open(os.path.join(split_dir, "test.txt"), "w") as f:
        f.write("".join(n + ".json\n" for n in test))
    return {"scene": scene, "views": len(names), "skipped": len(skipped), "gsd": round(gsd, 3), "areaMetres": round(2 * half), "minAlt": lo_alt, "maxAlt": hi_alt, "centre": [lat_c, lon_c], "groundControl": gcp}


# ---------------------------------------------------------------------------------------------
# convert: EOGS++'s splats to metres east-north-up of a ground point

def read_ply(path):
    """A binary little-endian PLY vertex table as a numpy structured array."""
    import numpy as np

    types = {"float": "f4", "float32": "f4", "double": "f8", "float64": "f8", "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1", "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4"}
    with open(path, "rb") as f:
        raw = f.read()
    end = raw.index(b"end_header") + len(b"end_header")
    end += 2 if raw[end : end + 2] == b"\r\n" else 1
    header = raw[:end].decode("ascii", "replace").splitlines()
    if not any(l.strip() == "format binary_little_endian 1.0" for l in header):
        raise ValueError("%s is not a binary little-endian PLY" % path)
    count, fields, in_vertex = 0, [], False
    for l in header:
        p = l.split()
        if p[:1] == ["element"]:
            in_vertex = p[1] == "vertex"
            if in_vertex:
                count = int(p[2])
        elif p[:1] == ["property"] and in_vertex:
            fields.append((p[2], "<" + types[p[1]]))
    return np.frombuffer(raw, dtype=np.dtype(fields), count=count, offset=end)


def write_ply(path, cols):
    import numpy as np

    names = list(cols)
    n = len(cols[names[0]])
    arr = np.empty(n, dtype=[(k, "<f4") for k in names])
    for k in names:
        arr[k] = cols[k]
    head = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n%send_header\n" % (n, "".join("property float %s\n" % k for k in names))
    with open(path, "wb") as f:
        f.write(head.encode("ascii"))
        f.write(arr.tobytes())


def frame_of(affine_json):
    """EOGS++'s normalisation and the panchromatic views' cameras from its affine_models.json."""
    with open(affine_json) as f:
        j = json.load(f)
    views = [m for m in j.get("pan") or j.get("msi") or [] if not m.get("virtual_camera")]
    if not views:
        raise ValueError("No camera in %s" % affine_json)
    m = views[0]["model"]
    return {"center": [float(x) for x in m["center"]], "scale": float(m["scale"]), "n": int(m["n"]), "l": str(m["l"])}, views


def affine_residuals(views, frame, gsd):
    """How far EOGS++'s affine cameras are from the RPC models they replace, in metres."""
    import numpy as np
    import rpcm
    import utm

    horiz, vert = [], []
    for v in views:
        rpc = rpcm.RPCModel(d=v["rpc"], dict_format="rpcm")
        w, h = v["width"], v["height"]
        u, r, a = np.meshgrid(np.linspace(0, w - 1, 9), np.linspace(0, h - 1, 9), np.linspace(v["min_alt"], v["max_alt"], 5), indexing="ij")
        u, r, a = u.ravel(), r.ravel(), a.ravel()
        lon, lat = rpc.localization(u, r, a)
        x, y, _, _ = utm.from_latlon(np.asarray(lat), np.asarray(lon))
        world = (np.stack([x, y, a], axis=1) - np.array(frame["center"])) / frame["scale"]
        pred = world @ np.array(v["model"]["coef_"]).T + np.array(v["model"]["intercept_"])
        du = (pred[:, 0] - ((u + 0.5) / w * 2 - 1)) * w / 2
        dv = (pred[:, 1] - ((r + 0.5) / h * 2 - 1)) * h / 2
        horiz.append(np.hypot(du, dv) * gsd)
        vert.append(np.abs(pred[:, 2] - a))
    hz, vt = np.concatenate(horiz), np.concatenate(vert)
    return {"count": len(views), "horizontalRms": round(float(np.sqrt(np.mean(hz**2))), 3), "verticalRms": round(float(np.sqrt(np.mean(vt**2))), 3), "max": round(float(hz.max()), 3)}


def convert(ply_in, frame, ply_out):
    """Writes splats in metres east, north and up of a ground point; returns that point (lat, lon, height)."""
    import numpy as np
    import utm

    v = read_ply(ply_in)
    names = v.dtype.names
    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype("f8")
    ok = np.all(np.isfinite(xyz), axis=1)
    v, xyz = v[ok], xyz[ok]
    c, s, zn, zl = np.array(frame["center"]), frame["scale"], frame["n"], frame["l"]
    pts = xyz * s + c  # UTM easting, northing; height above the WGS 84 ellipsoid (RPC heights)
    lat0, lon0 = utm.to_latlon(c[0], c[1], zn, zl, strict=False)
    opaque = 1 / (1 + np.exp(-v["opacity"].astype("f8"))) > 0.5 if "opacity" in names else np.ones(len(v), bool)
    h0 = float(np.median(pts[opaque, 2] if opaque.any() else pts[:, 2]))
    origin = (float(lat0), float(lon0), round(h0, 3))
    lat, lon = utm.to_latlon(pts[:, 0], pts[:, 1], zn, zl, strict=False)
    out_xyz = enu(origin, np.asarray(lat), np.asarray(lon), pts[:, 2])
    # The grid's turn and scale against east-north-up at the origin, for splat shapes.
    probe = np.array([[c[0], c[1], h0], [c[0] + 10, c[1], h0], [c[0], c[1] + 10, h0], [c[0], c[1], h0 + 10]])
    plat, plon = utm.to_latlon(probe[:, 0], probe[:, 1], zn, zl, strict=False)
    pe = enu(origin, np.asarray(plat), np.asarray(plon), probe[:, 2])
    J = (pe[1:] - pe[0]).T / 10
    U, S, Vt = np.linalg.svd(J)
    R = U @ Vt
    k = float(S.mean())
    cols = {"x": out_xyz[:, 0], "y": out_xyz[:, 1], "z": out_xyz[:, 2], "nx": np.zeros(len(v)), "ny": np.zeros(len(v)), "nz": np.zeros(len(v))}
    dc = [k2 for k2 in ("f_dc_0", "f_dc_1", "f_dc_2") if k2 in names]
    for i in range(3):
        cols["f_dc_%d" % i] = v[dc[min(i, len(dc) - 1)]] if dc else np.zeros(len(v))
    for k2 in sorted((n for n in names if n.startswith("f_rest_")), key=lambda n: int(n.split("_")[-1])):
        cols[k2] = v[k2]
    cols["opacity"] = v["opacity"] if "opacity" in names else np.full(len(v), 10.0)
    for i in range(3):
        cols["scale_%d" % i] = v["scale_%d" % i].astype("f8") + math.log(s * k)
    q = np.stack([v["rot_%d" % i] for i in range(4)], axis=1).astype("f8")
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    q = quat_mul(quat_from_matrix(R.tolist()), q)
    for i in range(4):
        cols["rot_%d" % i] = q[:, i]
    write_ply(ply_out, cols)
    return origin, int(len(v)), round(math.degrees(math.atan2(R[1][0], R[0][0])), 4), round(k, 6)


# ---------------------------------------------------------------------------------------------
# run: everything, for HOLO's worker

def newest_iteration(model_dir):
    best = None
    for p in glob.glob(os.path.join(model_dir, "point_cloud", "iteration_*", "point_cloud.ply")):
        m = re.search(r"iteration_(\d+)", p)
        if m and (best is None or int(m.group(1)) > best[0]):
            best = (int(m.group(1)), p)
    return best


def stream(argv, cwd, env):
    say("step %s: start" % " ".join(os.path.basename(a) for a in argv[1:3]))
    t0 = dt.datetime.now()
    r = subprocess.run(argv, cwd=cwd, env=env)
    say("step %s: exit %d after %d s" % (" ".join(os.path.basename(a) for a in argv[1:3]), r.returncode, (dt.datetime.now() - t0).total_seconds()))
    if r.returncode != 0:
        raise RuntimeError("EOGS++ step %s failed (exit %d); its output is above." % (os.path.basename(argv[2] if len(argv) > 2 else argv[1]), r.returncode))


def run(a):
    repo = os.path.abspath(a.eogs)
    train = os.path.abspath(a.train)
    todo = sorted({rel for rel, s in patch_state(repo) if s != "done"})
    if todo:
        raise RuntimeError("EOGS++ is not prepared for new scenes: run holo_eogs.py patch --eogs %s once." % repo)
    work = os.path.join(train, "eogs")
    os.makedirs(work, exist_ok=True)
    scene = "HOLO_" + hashlib.sha1(train.encode()).hexdigest()[:8].upper()
    alt = tuple(float(x) for x in a.alt_range.split(",")) if a.alt_range else None
    info = prepare(os.path.abspath(a.data), work, scene, a.max_size, alt, a.ground_control or None)
    env = dict(os.environ, HOLO_EOGS_GSD=str(info["gsd"]), MPLBACKEND="Agg", HYDRA_FULL_ERROR="1", PROJECT_ROOT=repo)
    py = sys.executable
    stream([py, "-m", "scripts.dataset_creation.to_affine", "scene_name=" + scene, "rpc_type=rpc_raw", "mode=pan", "basepath=" + work], repo, env)
    overrides = ["experiments=eogsplus", "mode=3PAN", "rpc_type=rpc_raw", "scene=" + scene, "numiterations=%d" % a.iterations, "expname=holo", "path.basepath=" + work, "tsdf.vox_size=%g" % info["gsd"]]
    stream([py, "src/gaussiansplatting/full_eval_pan.py"] + overrides, repo, env)

    model_dir = os.path.join(work, "output", "holo")
    found = newest_iteration(model_dir)
    if not found:
        raise RuntimeError("EOGS++ finished without writing point_cloud.ply in %s." % model_dir)
    iteration, ply = found
    frame, views = frame_of(os.path.join(work, "scripts", "dataset_creation", "affine_models", scene + "_pan_rpc_raw", "affine_models.json"))
    origin, count, turn, k = convert(ply, frame, os.path.join(train, "splats.ply"))
    say("splats: %d, placed at the scene centre; UTM zone %d%s, grid turned %.3f deg and scaled %.6f against east-north-up" % (count, frame["n"], frame["l"], turn, k))
    gcp = info.get("groundControl")
    georef = {
        "frame": "enu",
        "origin": {"lat": origin[0], "lon": origin[1], "height": origin[2]},
        "source": "satellite RPC camera models (no ground control)",
        "horizontalCrs": "EPSG:4326",
        "verticalDatum": "WGS 84 ellipsoid (RPC heights)",
        "metresPerModelUnit": 1,
        "controls": affine_residuals(views, frame, info["gsd"]),
        "checks": None,
        "note": "Placed from the satellites' RPC models, which EOGS++ refines while training. Without ground control the absolute position is as good as the RPCs (often a few metres). Controls: how far EOGS++'s affine cameras are from the RPCs.",
    }
    if gcp and gcp["controls"]:
        georef.update(
            source="satellite RPC camera models, corrected with %d surveyed ground control points" % gcp["points"],
            horizontalCrs="EPSG:4326 (surveyed in %s)" % gcp["crs"],
            verticalDatum="as surveyed (%s); RPC heights are above the WGS 84 ellipsoid, so the points' heights should be too" % gcp["crs"],
            controls=gcp["controls"],
            checks=gcp["checks"],
            note="Each view's RPC was moved by the mean pixel offset of the surveyed points it shows. Controls: the points found again with the corrected RPCs. Checks: each point found with RPCs corrected without it. EOGS++ refines the cameras further while training.",
        )
    elif gcp:
        georef["note"] += " Ground control was given, but no point is marked in two views, so it could not be checked."
        georef["source"] = "satellite RPC camera models, corrected with %d surveyed ground control points (not checked)" % gcp["points"]
    with open(os.path.join(train, "georef.json"), "w") as f:
        json.dump(georef, f, indent=1)
    dsm = sorted(glob.glob(os.path.join(model_dir, "test_opNone", "ours_*", "tsdf", "dsm.iio")))
    kept = None
    if dsm and a.keep_dsm:
        os.makedirs(a.keep_dsm, exist_ok=True)
        kept = os.path.join(a.keep_dsm, "%s-%s-dsm.tif" % (scene, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
        shutil.copyfile(dsm[-1], kept)
        say("DSM kept (GeoTIFF in UTM zone %d%s)" % (frame["n"], frame["l"]))
    with open(os.path.join(train, "holo-eogs.json"), "w") as f:
        json.dump(dict(info, iteration=iteration, splats=count, dsmKept=bool(kept)), f)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="HOLO's bridge to EOGS++")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--eogs", required=True)
    pa = sub.add_parser("patch")
    pa.add_argument("--eogs", required=True)
    pa.add_argument("--undo", action="store_true")
    r = sub.add_parser("run")
    r.add_argument("--eogs", required=True)
    r.add_argument("--data", required=True)
    r.add_argument("--train", required=True)
    r.add_argument("--iterations", type=int, required=True)
    r.add_argument("--max-size", type=int, default=2048, help="largest side of the area, in pixels")
    r.add_argument("--alt-range", default="", help="lowest and highest ground height in metres (WGS 84 ellipsoid), as MIN,MAX")
    r.add_argument("--keep-dsm", default="", help="folder to keep the DSM GeoTIFF in")
    r.add_argument("--ground-control", default="", help="ground-control.json from HOLO (surveyed points and where they show in the views)")
    a = p.parse_args(argv)
    if a.cmd == "check":
        return check(a.eogs)
    if a.cmd == "patch":
        return patch(a.eogs, a.undo)
    return run(a)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InputError as e:
        sys.stderr.write("%s\n" % e)
        sys.exit(2)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - one plain line; the traceback goes to the log too
        import traceback

        traceback.print_exc()
        sys.stderr.write("%s\n" % e)
        sys.exit(1)
