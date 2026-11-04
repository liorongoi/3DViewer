"""Reference coordinates for the georeference tests (WP 1.3), computed with PROJ through pyproj.

PROJ is the reference implementation of the EPSG transformations, written independently of
proj4js, which the viewer uses. Run: python3 scripts/proj-reference.py > packages/core/src/geo/fixtures/proj-reference.json
"""
import json, math
import pyproj

SITES = {
    # name: (lat, lon) of a model origin
    "Jerusalem": (31.7767, 35.2345),
    "Tel Aviv": (32.0853, 34.7818),
    "Haifa": (32.7940, 34.9896),
    "Eilat": (29.5577, 34.9519),
    "Mount Hermon": (33.4163, 35.8572),
    "Be'er Sheva": (31.2520, 34.7915),
}
CODES = [2039, 6991, 32636]
OTHER = {3035: (48.8566, 2.3522), 2154: (45.764, 4.8357), 25832: (50.1109, 8.6821), 32736: (-1.2921, 36.8219), 32633: (59.3293, 18.0686)}

def forward(code, lat, lon):
    return pyproj.Transformer.from_crs(4326, code, always_xy=True).transform(lon, lat)

out = {"proj": pyproj.proj_version_str, "points": [], "surveys": []}
for code in CODES:
    for name, (lat, lon) in SITES.items():
        x, y = forward(code, lat, lon)
        f = pyproj.Proj(pyproj.CRS(code)).get_factors(lon, lat)
        out["points"].append({"epsg": code, "site": name, "lat": lat, "lon": lon, "x": x, "y": y, "convergenceDeg": f.meridian_convergence, "scale": f.meridional_scale})
for code, (lat, lon) in OTHER.items():
    x, y = forward(code, lat, lon)
    f = pyproj.Proj(pyproj.CRS(code)).get_factors(lon, lat)
    out["points"].append({"epsg": code, "site": f"EPSG:{code}", "lat": lat, "lon": lon, "x": x, "y": y, "convergenceDeg": f.meridian_convergence, "scale": f.meridional_scale})

# Surveyed corners of a building site, 400 m by 300 m, 25 m of relief, in each Israeli grid:
# grid easting, northing and ellipsoidal height, with the WGS 84 position PROJ gives for each.
back = {code: pyproj.Transformer.from_crs(code, 4326, always_xy=True) for code in CODES}
for code in CODES:
    for name, (lat, lon) in SITES.items():
        x0, y0 = forward(code, lat, lon)
        x0, y0 = round(x0, 3), round(y0, 3)
        h0 = 800.0 if name == "Jerusalem" else 50.0
        pts = []
        for dx, dy, dh in [(0, 0, 0), (200, 0, 5), (-200, 150, 12), (200, -150, -8), (-200, -150, 25), (0, 150, 3), (137.25, 88.5, 17.4)]:
            lo, la = back[code].transform(x0 + dx, y0 + dy)
            pts.append({"x": x0 + dx, "y": y0 + dy, "h": h0 + dh, "lat": la, "lon": lo})
        out["surveys"].append({"epsg": code, "site": name, "origin": {"x": x0, "y": y0, "h": h0}, "points": pts})
print(json.dumps(out, indent=1))
