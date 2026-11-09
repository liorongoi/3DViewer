"""Trims the preview build to the artifact host's file budget (511 files per version).

- Sentinel-2 demo imagery: Lyon only, zoom <= 14 (Sentinel-2 is 10 m; z15 only oversamples).
- Terrain: Lyon and Tarn tiles plus their low-zoom parents.
- Tarn lidar: the first levels of the LOD tree only (the full set is 4,300 files).
- Font files the UI never loads (.woff next to .woff2, Vietnamese, Cyrillic, Greek).
Run on apps/web/dist-preview after the build. The full data stays in public/samples.
"""
import json, math, os, shutil, sys

OUT = sys.argv[1]
S = os.path.join(OUT, "samples")
LYON = (4.6, 45.6, 5.0, 45.9)
TARN = (3.2, 44.2, 3.6, 44.5)

def centre(z, x, y):
    lon = (x + 0.5) / 2**z * 360 - 180
    n = math.pi - 2 * math.pi * (y + 0.5) / 2**z
    return lon, math.degrees(math.atan(math.sinh(n)))

def tile_covers(z, x, y, box):
    w = x / 2**z * 360 - 180; e = (x + 1) / 2**z * 360 - 180
    lat = lambda yy: math.degrees(math.atan(math.sinh(math.pi - 2 * math.pi * yy / 2**z)))
    n, s = lat(y), lat(y + 1)
    return not (e < box[0] or w > box[2] or n < box[1] or s > box[3])

def prune_xyz(base, keep):
    removed = 0
    for root, _, files in os.walk(base):
        for f in files:
            p = os.path.join(root, f).split(os.sep)
            z, x, y = int(p[-3]), int(p[-2]), int(p[-1].split(".")[0])
            if not keep(z, x, y):
                os.remove(os.path.join(root, f)); removed += 1
    return removed

print("imagery removed", prune_xyz(os.path.join(S, "imagery/s2"), lambda z, x, y: z <= 14 and tile_covers(z, x, y, LYON)))
print("terrain removed", prune_xyz(os.path.join(S, "terrain"), lambda z, x, y: z >= 6 and (tile_covers(z, x, y, LYON) or tile_covers(z, x, y, TARN))))

tarn = os.path.join(S, "3dtiles/tarn-lidar")
if os.path.isdir(tarn):
    t = json.load(open(os.path.join(tarn, "tileset.json")))
    keep = {"tileset.json"}
    def cut(n, d):
        c = n.get("content", {})
        uri = c.get("uri") or c.get("url")
        if uri and uri.endswith(".json"):  # external tileset: becomes an empty leaf
            n.pop("content", None); n.pop("children", None); return
        if uri: keep.add(uri)
        if d >= 3: n.pop("children", None)
        for k in n.get("children", []): cut(k, d + 1)
    cut(t["root"], 0)
    json.dump(t, open(os.path.join(tarn, "tileset.json"), "w"))
    gone = 0
    for f in os.listdir(tarn):
        if f not in keep: os.remove(os.path.join(tarn, f)); gone += 1
    print("tarn kept", len(keep), "removed", gone)

# Fonts: .woff2 only, and only the subsets the UI shows (Latin, Latin-ext, Hebrew).
A = os.path.join(OUT, "assets")
for f in os.listdir(A):
    if f.endswith(".woff") or any(k in f for k in ("vietnamese", "cyrillic", "greek")):
        os.remove(os.path.join(A, f))

# The flat copy of the Lyon tileset is only a reference for rebuilding the LOD pyramid.
flat = os.path.join(S, "3dtiles/lyon1/tileset-flat.json")
if os.path.exists(flat): os.remove(flat)

# Cesium files for features the app never turns on: Google Earth Enterprise, the lens flare,
# and the Bing and Google credits. The IAU 2006 tables stay: they are read.
C = os.path.join(OUT, "cesium")
for f in ("ThirdParty/google-earth-dbroot-parser.js", "Workers/decodeGoogleEarthEnterprisePacket.js",
          "Workers/createVerticesFromGoogleEarthEnterpriseBuffer.js",
          "Assets/Images/bing_maps_credit.png", "Assets/Images/google_earth_credit.png"):
    if os.path.exists(os.path.join(C, f)): os.remove(os.path.join(C, f))
shutil.rmtree(os.path.join(C, "Assets/Textures/LensFlare"), ignore_errors=True)
# FBX samples are for the server's converter; the browser never reads them.
shutil.rmtree(os.path.join(S, "fbx"), ignore_errors=True)
