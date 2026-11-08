"""The line-of-sight reference (WP 2.8, ANL-01/02), with GDAL's command-line tools.

Writes a synthetic DEM (scripts/fixtures/sight-dem.tif: 10 m cells, 4 x 4 km in UTM 36N near
Jerusalem, two ridges, a hill and a valley) and, for 20 observer / target pairs on it,
scripts/fixtures/sight-reference.json with:
  - the profile the viewer should find: heights from the DEM's own cells (bilinear between
    pixel centres), at the same geodesic samples the viewer uses (pyproj.Geod), the
    sight line with earth curvature and refraction k = 0.13, the first sample where the ground
    rises 5 cm above the line, and the worst deficit;
  - gdal_viewshed's own answer (Wang et al.) for whether the target is seen, which is computed
    independently on cell centres.

Run: python3 scripts/sight-reference.py
"""
import json
import math
import os
import random
import subprocess
import tempfile

import numpy as np
import pyproj

HERE = os.path.dirname(os.path.abspath(__file__))
DEM = os.path.join(HERE, "fixtures", "sight-dem.tif")
OUT = os.path.join(HERE, "fixtures", "sight-reference.json")
EPSG = 32636
X0, Y0 = 708000.0, 3518000.0  # north-west corner
CELL, N = 10.0, 400
K = 0.13
R = 6371000.0
A_H = B_H = 1.8

# ---- The DEM ----
xs = X0 + (np.arange(N) + 0.5) * CELL
ys = Y0 - (np.arange(N) + 0.5) * CELL
X, Y = np.meshgrid(xs - X0, Y0 - ys)  # metres east and south of the corner
z = 700.0
z = z + 80.0 * np.exp(-(((X - 1500.0) / 180.0) ** 2))  # a north-south ridge
z = z + 55.0 * np.exp(-(((Y - 2600.0 + 0.25 * X) / 150.0) ** 2))  # a slanting ridge
z = z + 120.0 * np.exp(-(((X - 2900.0) ** 2 + (Y - 1100.0) ** 2) / 350.0**2))  # a hill
z = z - 35.0 * np.exp(-(((X - 600.0) / 220.0) ** 2)) * (0.5 + 0.5 * np.sin(Y / 400.0))  # a valley
z = z + 1.5 * np.sin(X / 37.0) * np.cos(Y / 53.0)  # small relief
z = z.astype(np.float32)

# Written as an ESRI ASCII grid, then made a GeoTIFF by gdal_translate.
with tempfile.TemporaryDirectory() as tmp:
    asc = os.path.join(tmp, "dem.asc")
    with open(asc, "w") as f:
        f.write(f"ncols {N}\nnrows {N}\nxllcorner {X0}\nyllcorner {Y0 - N * CELL}\ncellsize {CELL}\n")
        for row in z:
            f.write(" ".join(repr(float(v)) for v in row) + "\n")
    subprocess.run(["gdal_translate", "-q", "-ot", "Float32", "-a_srs", f"EPSG:{EPSG}", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", "-co", "TILED=YES", asc, DEM], check=True)
band = z.astype(np.float64)
gt = (X0, CELL, 0.0, Y0, 0.0, -CELL)
GDAL_VERSION = subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True).stdout.strip()
to_utm = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{EPSG}", always_xy=True)
to_geo = pyproj.Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)


def height(lon, lat):
    x, y = to_utm.transform(lon, lat)
    fx = (x - gt[0]) / gt[1] - 0.5
    fy = (y - gt[3]) / gt[5] - 0.5
    fx = min(max(fx, 0.0), N - 1.0)
    fy = min(max(fy, 0.0), N - 1.0)
    ix, iy = min(int(math.floor(fx)), N - 2), min(int(math.floor(fy)), N - 2)
    tx, ty = fx - ix, fy - iy
    return (band[iy, ix] * (1 - tx) + band[iy, ix + 1] * tx) * (1 - ty) + (band[iy + 1, ix] * (1 - tx) + band[iy + 1, ix + 1] * tx) * ty


geod = pyproj.Geod(ellps="WGS84")
rng = random.Random(7)
pairs = []
while len(pairs) < 20:
    ax, ay = X0 + rng.uniform(300, 3700), Y0 - rng.uniform(300, 3700)
    bx, by = X0 + rng.uniform(300, 3700), Y0 - rng.uniform(300, 3700)
    if not 300 <= math.hypot(bx - ax, by - ay) <= 3200:
        continue
    alon, alat = to_geo.transform(ax, ay)
    blon, blat = to_geo.transform(bx, by)
    _, _, D = geod.inv(alon, alat, blon, blat)
    n = max(32, min(300, round(D)))
    pts = [(alon, alat)] + geod.npts(alon, alat, blon, blat, n - 1) + [(blon, blat)]
    ah, bh = height(alon, alat), height(blon, blat)
    hA, hB = ah + A_H, bh + B_H
    block = None
    worst = -math.inf
    for i, (lon, lat) in enumerate(pts):
        d = D * i / n
        if d < 1 or d > D - 1:
            continue
        sight = hA + (hB - hA) * d / D - (1 - K) * d * (D - d) / (2 * R)
        deficit = height(lon, lat) - sight
        worst = max(worst, deficit)
        if block is None and deficit > 0.05:
            block = {"i": i, "d": d}
    # Ten seen, ten blocked.
    if sum(1 for q in pairs if q["visible"] == (block is None)) >= 10:
        continue
    pairs.append({"a": {"lon": alon, "lat": alat, "h": ah, "x": ax, "y": ay}, "b": {"lon": blon, "lat": blat, "h": bh, "x": bx, "y": by}, "distance": D, "samples": n, "visible": block is None, "block": block, "worstDeficit": worst})

# ---- gdal_viewshed, from each observer ----
with tempfile.TemporaryDirectory() as tmp:
    for k, p in enumerate(pairs):
        out = os.path.join(tmp, f"v{k}.tif")
        subprocess.run(["gdal_viewshed", "-q", "-ox", str(p["a"]["x"]), "-oy", str(p["a"]["y"]), "-oz", str(A_H), "-tz", str(B_H), "-cc", str(1 - K), "-md", "6000", "-vv", "255", "-iv", "0", "-ov", "0", DEM, out], check=True)
        info = subprocess.run(["gdallocationinfo", "-valonly", "-geoloc", out, str(p["b"]["x"]), str(p["b"]["y"])], capture_output=True, text=True, check=True).stdout.strip()
        p["gdalVisible"] = float(info) == 255

json.dump({"gdal": GDAL_VERSION, "epsg": EPSG, "cell": CELL, "k": K, "aHeight": A_H, "bHeight": B_H, "pairs": pairs}, open(OUT, "w"), indent=1)
vis = sum(p["visible"] for p in pairs)
agree = sum(p["visible"] == p["gdalVisible"] for p in pairs)
print(f"{len(pairs)} pairs, {vis} visible; gdal_viewshed agrees on {agree}")
for p in pairs:
    if p["visible"] != p["gdalVisible"]:
        print(f"  differs: {p['distance']:.0f} m, worst deficit {p['worstDeficit']:.2f} m")
