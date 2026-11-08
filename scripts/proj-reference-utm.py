"""Reference coordinates from PROJ (pyproj), for packages/core/src/geo/utm-reference.test.ts (WP 2.6, MSR-08).

Run: python3 scripts/proj-reference-utm.py > packages/core/src/geo/fixtures/proj-utm-reference.json
"""
import json
import pyproj

# Places that matter here, zone edges, both hemispheres, the Norway and Svalbard exceptions,
# and points shown in a neighbouring zone (a model across a zone line keeps one zone).
POINTS = [
    ("Jerusalem", 31.7767, 35.2345, 812.4, None),
    ("Tel Aviv", 32.0853, 34.7818, 5.0, None),
    ("Eilat", 29.5577, 34.9519, 12.0, None),
    ("Haifa", 32.794, 34.9896, 250.0, None),
    ("East of 36°E, in its own zone 37", 33.0, 36.1, 900.0, None),
    ("The same point shown in zone 36", 33.0, 36.1, 900.0, 36),
    ("Lyon", 45.764, 4.8357, 170.0, None),
    ("Bergen (Norway exception, zone 32)", 60.3913, 5.3221, 20.0, None),
    ("Svalbard (zone 33)", 78.2232, 15.6267, 10.0, None),
    ("Cape Town (south)", -33.9249, 18.4241, 30.0, None),
    ("Sydney (south)", -33.8688, 151.2093, 40.0, None),
    ("Quito (just south of the equator)", -0.1807, -78.4678, 2850.0, None),
    ("Just north of the equator", 0.0001, 33.0, 0.0, None),
    ("Central meridian of zone 36", 10.0, 33.0, 0.0, None),
    ("Zone 36 edge at 30°E", 31.0, 30.0001, 0.0, None),
    ("Zone 1 near the antimeridian", 51.0, -179.9, 0.0, None),
    ("Zone 60 near the antimeridian", -40.0, 179.9, 0.0, None),
    ("Dead Sea (below sea level)", 31.5, 35.5, -430.0, None),
]


def zone_for(lat, lon):
    z = int((lon + 180) // 6) + 1
    if z > 60:
        z = 60
    if 56 <= lat < 64 and 3 <= lon < 12:
        z = 32
    if 72 <= lat < 84:
        if 0 <= lon < 9:
            z = 31
        elif 9 <= lon < 21:
            z = 33
        elif 21 <= lon < 33:
            z = 35
        elif 33 <= lon < 42:
            z = 37
    return z


out = {"proj": pyproj.proj_version_str, "pyproj": pyproj.__version__, "utm": [], "ecef": []}
to_ecef = pyproj.Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
for name, lat, lon, h, forced in POINTS:
    zone = forced or zone_for(lat, lon)
    south = lat < 0
    epsg = (32700 if south else 32600) + zone
    t = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    e, n = t.transform(lon, lat)
    out["utm"].append({"name": name, "lat": lat, "lon": lon, "zone": zone, "forced": forced is not None, "hemisphere": "S" if south else "N", "easting": round(e, 4), "northing": round(n, 4)})
    x, y, z = to_ecef.transform(lon, lat, h)
    out["ecef"].append({"name": name, "lat": lat, "lon": lon, "height": h, "x": round(x, 4), "y": round(y, 4), "z": round(z, 4)})
print(json.dumps(out, indent=2))
