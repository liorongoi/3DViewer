#!/usr/bin/env python3
"""Checks of holo_eogs.py that need no GPU: run with the EOGS++ environment's Python,

    python test_holo_eogs.py            # data preparation and the splat conversion
    EOGS_REPO=/opt/holo/eogs-plus python test_holo_eogs.py   # also EOGS++'s own camera step

It makes a small synthetic capture (four views with RPCs embedded, in .RPB and in _RPC.TXT, one
with only an acquisition time), prepares it, and checks that splats in EOGS++'s normalised UTM
frame come out in metres east-north-up with the right positions, shapes and turn.
"""
import json
import math
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import numpy as np
    import rasterio
    import rpcm  # noqa: F401
    import utm
except ImportError as e:
    print("skipped: %s (run with the EOGS++ environment's Python)" % e)
    sys.exit(0)

import holo_eogs as h  # noqa: E402

LAT0, LON0, H0 = 32.08, 34.78, 40.0


def coeffs(*lin):
    c = [0.0] * 20
    c[1], c[2], c[3] = lin
    return c


def make_capture(out):
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(1)
    W = H = 1500
    den = [1.0] + [0.0] * 19
    for i, (hx, hy) in enumerate([(0.0, 0.0), (0.12, -0.05), (-0.10, 0.08), (0.05, 0.11)]):
        d = dict(LINE_OFF=750.0 + i * 13, SAMP_OFF=750.0 - i * 9, LAT_OFF=LAT0, LONG_OFF=LON0, HEIGHT_OFF=H0, LINE_SCALE=750.0, SAMP_SCALE=750.0, LAT_SCALE=0.004, LONG_SCALE=0.005, HEIGHT_SCALE=500.0)
        row_num, col_num = coeffs(0.0, -1.0, hy), coeffs(1.0, 0.0, hx)
        name = os.path.join(out, "view%d.tif" % i)
        with rasterio.open(name, "w", driver="GTiff", width=W, height=H, count=1, dtype="uint16") as dst:
            dst.write((rng.random((H, W)) * 1800 + 200).astype("uint16"), 1)
            if i == 0:
                dst.update_tags(ns="RPC", **{k: str(v) for k, v in d.items()}, LINE_NUM_COEFF=" ".join(map(str, row_num)), LINE_DEN_COEFF=" ".join(map(str, den)), SAMP_NUM_COEFF=" ".join(map(str, col_num)), SAMP_DEN_COEFF=" ".join(map(str, den)))
        if i in (1, 3):
            f = lambda c: ",\n".join("\t\t%+.15E" % x for x in c)  # noqa: E731
            txt = "".join("\t%s = %s;\n" % (k, d[v]) for k, v in [("lineOffset", "LINE_OFF"), ("sampOffset", "SAMP_OFF"), ("latOffset", "LAT_OFF"), ("longOffset", "LONG_OFF"), ("heightOffset", "HEIGHT_OFF"), ("lineScale", "LINE_SCALE"), ("sampScale", "SAMP_SCALE"), ("latScale", "LAT_SCALE"), ("longScale", "LONG_SCALE"), ("heightScale", "HEIGHT_SCALE")])
            txt = 'satId = "TEST";\nBEGIN_GROUP = IMAGE\n\terrBias = 1.0;\n' + txt + "\tlineNumCoef = (\n%s);\n\tlineDenCoef = (\n%s);\n\tsampNumCoef = (\n%s);\n\tsampDenCoef = (\n%s);\nEND_GROUP = IMAGE\nEND;\n" % (f(row_num), f(den), f(col_num), f(den))
            open(os.path.join(out, "view%d.RPB" % i), "w").write(txt)
        if i == 2:
            lines = ["%s: %s" % (k, v) for k, v in d.items()]
            for nm, c in (("LINE_NUM_COEFF", row_num), ("LINE_DEN_COEFF", den), ("SAMP_NUM_COEFF", col_num), ("SAMP_DEN_COEFF", den)):
                lines += ["%s_%d: %+.15E" % (nm, k + 1, x) for k, x in enumerate(c)]
            open(os.path.join(out, "view%d_RPC.TXT" % i), "w").write("\n".join(lines) + "\n")
        sun = "" if i == 3 else "\tmeanSunAz = %.1f;\n\tmeanSunEl = %.1f;\n" % (120 + i, 70 - i)
        open(os.path.join(out, "view%d.IMD" % i), "w").write("BEGIN_GROUP = IMAGE_1\n\tfirstLineTime = 2024-06-01T08:%02d:00.000000Z;\n%sEND_GROUP = IMAGE_1\n" % (10 * i, sun))


def test_sun():
    # Tel Aviv, 21 June 2024 at 09:40 UTC (local noon): high in the south, about 81 degrees.
    import datetime as dt

    az, el = h.sun_angles(dt.datetime(2024, 6, 21, 9, 40, tzinfo=dt.timezone.utc), 32.08, 34.78)
    assert 80 < el < 82 and (az > 150 or az < 30), (az, el)


def test_prepare(tmp):
    make_capture(os.path.join(tmp, "cap"))
    work = os.path.join(tmp, "work")
    info = h.prepare(os.path.join(tmp, "cap"), work, "HOLO_TEST", 1024)
    assert info["views"] == 4 and abs(info["gsd"] - 0.61) < 0.05, info
    names = sorted(os.listdir(os.path.join(work, "data", "rpcs", "rpc_raw", "HOLO_TEST")))
    assert names == ["view_01.json", "view_02.json", "view_03.json", "view_04.json"], names
    for n in names:
        m = json.load(open(os.path.join(work, "data", "rpcs", "rpc_raw", "HOLO_TEST", n)))
        rpc = rpcm.RPCModel(m["rpc"], dict_format="rpcm")
        # The cut view's RPC still finds the scene centre inside the cut.
        c, r = rpc.projection(info["centre"][1], info["centre"][0], H0)
        assert 0 < float(c) < m["width"] and 0 < float(r) < m["height"], (n, c, r)
        with rasterio.open(os.path.join(work, "data", "images", "pan", "HOLO_TEST", m["img"])) as src:
            px = src.read(1)
            assert (src.height, src.width) == (m["height"], m["width"]) and 0 <= px.min() and px.max() <= 255
    sun = json.load(open(os.path.join(work, "data", "rpcs", "rpc_raw", "HOLO_TEST", "view_04.json")))
    assert 60 < sun["sun_elevation"] < 80, sun["sun_elevation"]  # worked out from the time
    assert open(os.path.join(work, "data", "train_test_split", "HOLO_TEST", "test.txt")).read() == ""
    return work


def test_convert(tmp, frame):
    n = 5
    rng = np.random.default_rng(0)
    xyz = rng.uniform(-0.5, 0.5, (n, 3))
    xyz[:, 2] = (40 + rng.uniform(-5, 20, n)) / frame["scale"]
    cols = {"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2], "nx": np.zeros(n), "ny": np.zeros(n), "nz": np.zeros(n), "f_dc_0": np.full(n, 0.3), "opacity": np.full(n, 3.0)}
    for i, s in enumerate(np.log([0.001, 0.02, 0.001])):  # long along grid north
        cols["scale_%d" % i] = np.full(n, s)
    cols.update(rot_0=np.ones(n), rot_1=np.zeros(n), rot_2=np.zeros(n), rot_3=np.zeros(n))
    h.write_ply(os.path.join(tmp, "in.ply"), cols)
    origin, count, turn, k = h.convert(os.path.join(tmp, "in.ply"), frame, os.path.join(tmp, "out.ply"))
    o = h.read_ply(os.path.join(tmp, "out.ply"))
    pts = xyz * frame["scale"] + np.array(frame["center"])
    lat, lon = utm.to_latlon(pts[:, 0], pts[:, 1], frame["n"], frame["l"])
    ref = h.enu(origin, lat, lon, pts[:, 2])
    assert np.abs(ref - np.stack([o["x"], o["y"], o["z"]], 1)).max() < 1e-3
    w, x, y, z = (float(o["rot_%d" % i][0]) for i in range(4))
    long_axis = np.array([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)])
    la, lo = utm.to_latlon(np.array([frame["center"][0]] * 2), np.array([frame["center"][1], frame["center"][1] + 50]), frame["n"], frame["l"])
    e = h.enu(origin, la, lo, np.array([origin[2]] * 2))
    grid_north = (e[1] - e[0]) / np.linalg.norm(e[1] - e[0])
    assert math.degrees(math.asin(min(1.0, float(np.linalg.norm(np.cross(long_axis / np.linalg.norm(long_axis), grid_north)))))) < 0.01
    assert abs(math.exp(o["scale_1"][0]) - 0.02 * frame["scale"]) < 0.01
    assert o["f_dc_1"][0] == o["f_dc_0"][0] == np.float32(0.3)
    assert abs(turn) > 0.1 and abs(k - 1) < 0.001, (turn, k)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        test_sun()
        work = test_prepare(tmp)
        repo = os.environ.get("EOGS_REPO")
        if repo:
            env = dict(os.environ, PROJECT_ROOT=repo)
            r = subprocess.run([sys.executable, "-m", "scripts.dataset_creation.to_affine", "scene_name=HOLO_TEST", "rpc_type=rpc_raw", "mode=pan", "basepath=" + work], cwd=repo, env=env)
            assert r.returncode == 0, "EOGS++ to_affine failed"
            frame, views = h.frame_of(os.path.join(work, "scripts", "dataset_creation", "affine_models", "HOLO_TEST_pan_rpc_raw", "affine_models.json"))
            res = h.affine_residuals(views, frame, 0.61)
            assert res["count"] == 4 and res["horizontalRms"] < 0.1, res
        else:
            x, y, zn, zl = utm.from_latlon(LAT0, LON0)
            frame = {"center": [x, y, 0.0], "scale": 509.0, "n": zn, "l": zl}
        test_convert(tmp, frame)
    print("ok")


if __name__ == "__main__":
    main()
