#!/usr/bin/env python3
# Usage: python3 scripts/build-demo-basemaps.py apps/web/public/samples
# Needs: pip install rasterio mercantile pillow numpy. Reads Sentinel-2 L2A COGs and AWS Terrain Tiles.
# Builds offline demo tiles: Sentinel-2 true colour (XYZ, Web Mercator) and Terrarium terrain.
import sys, os, io, json, math, urllib.request
import numpy as np, mercantile, rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from PIL import Image
OUT = sys.argv[1]
REGIONS = {
  "jerusalem": dict(bbox=(35.12, 31.70, 35.30, 31.84), s2="https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/36/S/YA/2025/8/S2A_36SYA_20250819_1_L2A/TCI.tif"),
  "lyon": dict(bbox=(4.79, 45.745, 4.87, 45.795), s2="https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/31/T/FL/2025/8/S2A_31TFL_20250811_1_L2A/TCI.tif"),
  "tarn": dict(bbox=(3.33, 44.30, 3.44, 44.37), s2="https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/31/T/EK/2025/8/S2A_31TEK_20250811_0_L2A/TCI.tif"),
}
IMG_Z = range(10, 16)
TER_Z = range(6, 15)
env = rasterio.Env(GDAL_HTTP_PROXY=os.environ.get("HTTPS_PROXY", "").replace("http://", ""), CURL_CA_BUNDLE="/root/.ccr/ca-bundle.crt", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif")
n_img = n_ter = 0
with env:
  for name, r in REGIONS.items():
    with rasterio.open("/vsicurl/" + r["s2"]) as src, WarpedVRT(src, crs="EPSG:3857", resampling=Resampling.bilinear) as vrt:
      for z in IMG_Z:
        for t in mercantile.tiles(*r["bbox"], zooms=z):
          b = mercantile.xy_bounds(t)
          vb = vrt.bounds
          l, bo, r_, to = max(b.left, vb.left), max(b.bottom, vb.bottom), min(b.right, vb.right), min(b.top, vb.top)
          if l >= r_ or bo >= to: continue
          px = lambda v, a0, a1: int(round((v - a0) / (a1 - a0) * 256))
          c0, c1 = px(l, b.left, b.right), px(r_, b.left, b.right)
          r0, r1 = px(b.top - to, 0, b.top - b.bottom), px(b.top - bo, 0, b.top - b.bottom)
          if c1 <= c0 or r1 <= r0: continue
          part = vrt.read(window=vrt.window(l, bo, r_, to), out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.bilinear)
          a = np.zeros((3, 256, 256), dtype=np.uint8); a[:, r0:r1, c0:c1] = part
          img = np.transpose(a, (1, 2, 0)).astype(np.uint8)
          mask = (img.sum(axis=2) > 0)
          if not mask.any(): continue
          # Gentle contrast/gamma lift: L2A true colour is dark.
          f = np.clip((img.astype(np.float32) / 255.0) ** 0.8 * 1.15, 0, 1)
          img = (f * 255).astype(np.uint8)
          p = f"{OUT}/imagery/s2/{z}/{t.x}"; os.makedirs(p, exist_ok=True)
          buf = io.BytesIO()
          if mask.all(): Image.fromarray(img).save(buf, "JPEG", quality=82)
          else: Image.fromarray(np.dstack([img, (mask * 255).astype(np.uint8)])).save(buf, "PNG", optimize=True)
          open(f"{p}/{t.y}.jpg", "wb").write(buf.getvalue()); n_img += 1
    for z in TER_Z:
      for t in mercantile.tiles(*r["bbox"], zooms=z):
        p = f"{OUT}/terrain/{z}/{t.x}"; f = f"{p}/{t.y}.png"
        if os.path.exists(f): continue
        os.makedirs(p, exist_ok=True)
        urllib.request.urlretrieve(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{t.x}/{t.y}.png", f); n_ter += 1
  for z in range(0, 4):
    for x in range(2 ** z):
      for y in range(2 ** z):
        p = f"{OUT}/terrain/{z}/{x}"; f = f"{p}/{y}.png"
        if os.path.exists(f): continue
        os.makedirs(p, exist_ok=True)
        urllib.request.urlretrieve(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", f); n_ter += 1
print("imagery", n_img, "terrain", n_ter)
