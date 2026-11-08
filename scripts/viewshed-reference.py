"""The viewshed reference (WP 2.9, ANL-03): gdal_viewshed on the line-of-sight test DEM.

For four observers on scripts/fixtures/sight-dem.tif (made by scripts/sight-reference.py: 10 m
cells, UTM 36N), runs gdal_viewshed with a 1 km radius, the target on the ground and earth
curvature with refraction k = 0.13, and writes scripts/fixtures/viewshed-reference.json with,
for each observer, its position and eye height, the visible and total area within the radius,
and the visible cells as a bit mask (row by row from the north-west corner of the square
around the observer, 1 = seen) so the viewer can be compared cell by cell.

Run: python3 scripts/viewshed-reference.py
"""
import base64
import json
import math
import os
import subprocess
import tempfile

import numpy as np
import pyproj

HERE = os.path.dirname(os.path.abspath(__file__))
DEM = os.path.join(HERE, "fixtures", "sight-dem.tif")
OUT = os.path.join(HERE, "fixtures", "viewshed-reference.json")
EPSG = 32636
X0, Y0 = 708000.0, 3518000.0  # the DEM's north-west corner
CELL, N = 10.0, 400
K = 0.13
RADIUS = 1000.0
# Cell offsets from the north-west corner (column, row) and eye height above the ground.
OBSERVERS = [
    ("on the north-south ridge", 150, 200, 10.0),
    ("on the hill's flank", 285, 110, 2.0),
    ("in the valley", 100, 240, 10.0),
    ("on the slanting ridge, a mast", 220, 205, 30.0),
]

GDAL_VERSION = subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True).stdout.strip()
to_geo = pyproj.Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)
m = int(RADIUS / CELL)
out = []
with tempfile.TemporaryDirectory() as tmp:
    for name, col, row, eye in OBSERVERS:
        x, y = X0 + (col + 0.5) * CELL, Y0 - (row + 0.5) * CELL
        tif = os.path.join(tmp, "v.tif")
        asc = os.path.join(tmp, "v.asc")
        subprocess.run(["gdal_viewshed", "-q", "-ox", str(x), "-oy", str(y), "-oz", str(eye), "-tz", "0", "-cc", str(1 - K), "-md", str(RADIUS), "-vv", "1", "-iv", "0", "-ov", "0", DEM, tif], check=True)
        subprocess.run(["gdal_translate", "-q", "-of", "AAIGrid", tif, asc], check=True)
        with open(asc) as f:
            head = {k.lower(): float(v) for k, v in (next(f).split() for _ in range(5))}
            rest = f.read().split("\n")
        if rest and rest[0].lower().startswith("nodata_value"):
            rest = rest[1:]
        grid = np.array([[float(v) for v in line.split()] for line in rest if line.strip()])
        # gdal_viewshed crops its output to the radius: place it on the DEM's own grid.
        c0 = round((head["xllcorner"] - X0) / CELL)
        r0 = round((Y0 - (head["yllcorner"] + head["nrows"] * CELL)) / CELL)
        full = np.zeros((N, N))
        full[r0 : r0 + grid.shape[0], c0 : c0 + grid.shape[1]] = grid
        # The square around the observer, and the cells whose centres are within the radius.
        sq = full[row - m : row + m + 1, col - m : col + m + 1]
        jj, ii = np.mgrid[-m : m + 1, -m : m + 1]
        inside = np.hypot(ii * CELL, jj * CELL) <= RADIUS
        seen = (sq == 1) & inside
        bits = np.packbits(seen.astype(np.uint8).ravel())
        lon, lat = to_geo.transform(x, y)
        out.append(
            {
                "name": name,
                "x": x,
                "y": y,
                "lon": lon,
                "lat": lat,
                "eye": eye,
                "size": 2 * m + 1,
                "visibleCells": int(seen.sum()),
                "cells": int(inside.sum()),
                "visibleArea": float(seen.sum() * CELL * CELL),
                "area": float(inside.sum() * CELL * CELL),
                "mask": base64.b64encode(bits.tobytes()).decode(),
            }
        )
        print(f"{name}: {seen.sum() / inside.sum() * 100:.1f} % of {inside.sum()} cells seen")

json.dump({"gdal": GDAL_VERSION, "epsg": EPSG, "cell": CELL, "k": K, "radius": RADIUS, "targetHeight": 0, "observers": out}, open(OUT, "w"), indent=1)
