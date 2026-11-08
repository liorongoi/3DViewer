"""The survey for the accuracy harness (WP 2.7, NFR-07), computed with PROJ through pyproj.

A building surveyed in the Israeli Transverse Mercator grid (EPSG:2039), as a producer's file
would be: corner points as easting, northing and ellipsoidal height. PROJ gives each corner's
Earth-centred position; the distances between them are the truth the viewer is held to.

Run: python3 scripts/survey-reference.py > scripts/fixtures/survey-reference.json
"""
import json
import math
import pyproj

EPSG = 2039
# The building's survey origin (its south-west ground corner before the turn), in ITM metres.
E0, N0, H0 = 222300.0, 631550.0, 800.0
# A 24 x 14 m block, 9 m high, turned 30 degrees clockwise from grid north.
W, D, H, TURN = 24.0, 14.0, 9.0, 30.0

c, s = math.cos(math.radians(TURN)), math.sin(math.radians(TURN))
corners = {}
for name, (x, y) in {"SW": (0, 0), "SE": (W, 0), "NE": (W, D), "NW": (0, D)}.items():
    # Clockwise turn: east goes to east*cos - north*... in grid terms.
    e = E0 + x * c + y * s
    n = N0 - x * s + y * c
    corners[f"{name}-ground"] = (e, n, H0)
    corners[f"{name}-roof"] = (e, n, H0 + H)

to_geo = pyproj.Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)
to_ecef = pyproj.Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
points = []
for name, (e, n, h) in corners.items():
    lon, lat = to_geo.transform(e, n)
    x, y, z = to_ecef.transform(lon, lat, h)
    points.append({"name": name, "grid": [round(e, 4), round(n, 4), h], "lat": lat, "lon": lon, "height": h, "ecef": [x, y, z]})

print(json.dumps({"proj": pyproj.proj_version_str, "epsg": EPSG, "origin": [E0, N0, H0], "size": [W, D, H], "turnDeg": TURN, "points": points}, indent=1))
