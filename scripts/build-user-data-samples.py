"""Builds the "your own data" demo files (plan WP 1.9) from public sources.

Outputs to apps/web/public/samples/user-data/:
  lyon-rivers-l93.*    Natural Earth Europe rivers around Lyon, reprojected to Lambert-93
                       (EPSG:2154), so the viewer must read the .prj and reproject.
  places-fr-il.*       Natural Earth populated places in France and Israel (WGS 84).
  lyon-s2-utm31.tif    Sentinel-2 true colour around Lyon, UTM 31N (EPSG:32631), tiled with
                       overviews (a Cloud Optimised GeoTIFF layout).
  tarn-dem.tif         Copernicus DEM GLO-30 over the Tarn gorges, one float band, WGS 84.
  wmts/WMTSCapabilities.xml   a WMTS document that serves the offline Sentinel-2 tiles.
Natural Earth: public domain. Sentinel-2: Copernicus open licence. Copernicus DEM: free licence (ESA/EU).
"""
import os, sys, shapefile
from pyproj import Transformer
import numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds

NE = sys.argv[1]  # natural-earth-vector checkout
OUT = os.path.join(os.path.dirname(__file__), "..", "apps/web/public/samples/user-data")
os.makedirs(OUT, exist_ok=True)

L93_WKT = 'PROJCS["RGF93_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]'

def rivers():
    t = Transformer.from_crs(4326, 2154, always_xy=True)
    w = shapefile.Writer(os.path.join(OUT, "lyon-rivers-l93"), shapeType=shapefile.POLYLINE)
    w.field("name", "C", 60); w.field("scalerank", "N", 4)
    n = 0
    for src in ("10m_physical/ne_10m_rivers_lake_centerlines", "10m_physical/ne_10m_rivers_europe"):
      r = shapefile.Reader(os.path.join(NE, src))
      names = [f[0] for f in r.fields[1:]]
      for sr in r.iterShapeRecords():
          x0, y0, x1, y1 = sr.shape.bbox
          if x1 < 4.0 or x0 > 5.8 or y1 < 45.0 or y0 > 46.6: continue
          rec = dict(zip(names, sr.record))
          parts = list(sr.shape.parts) + [len(sr.shape.points)]
          lines = [[list(t.transform(*p)) for p in sr.shape.points[parts[i]:parts[i + 1]]] for i in range(len(parts) - 1)]
          w.line(lines); w.record({"Sane": "Saône"}.get(rec.get("name"), rec.get("name") or ""), rec.get("scalerank") or 0); n += 1
    w.close()
    open(os.path.join(OUT, "lyon-rivers-l93.prj"), "w").write(L93_WKT)
    open(os.path.join(OUT, "lyon-rivers-l93.cpg"), "w").write("UTF-8")
    print("rivers", n)

def places():
    r = shapefile.Reader(os.path.join(NE, "10m_cultural/ne_10m_populated_places_simple"), encoding="utf-8")
    w = shapefile.Writer(os.path.join(OUT, "places-fr-il"), shapeType=shapefile.POINT, encoding="utf-8")
    w.field("name", "C", 60); w.field("country", "C", 40); w.field("pop_max", "N", 12)
    names = [f[0] for f in r.fields[1:]]
    n = 0
    for sr in r.iterShapeRecords():
        rec = dict(zip(names, sr.record))
        if rec.get("adm0name") not in ("France", "Israel"): continue
        x, y = sr.shape.points[0]
        if rec.get("adm0name") == "France" and not (-5.5 < x < 10 and 41 < y < 51.5): continue  # mainland and Corsica
        w.point(x, y); w.record(rec["name"], rec["adm0name"], int(rec.get("pop_max") or 0)); n += 1
    w.close()
    open(os.path.join(OUT, "places-fr-il.prj"), "w").write(open(os.path.join(NE, "10m_cultural/ne_10m_populated_places_simple.prj")).read())
    open(os.path.join(OUT, "places-fr-il.cpg"), "w").write("UTF-8")
    print("places", n)

PROFILE = dict(driver="GTiff", tiled=True, blockxsize=256, blockysize=256, compress="deflate")

def s2():
    url = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/31/T/FL/2025/8/S2A_31TFL_20250811_1_L2A/TCI.tif"
    with rasterio.open(url) as src:
        b = transform_bounds(4326, src.crs, 4.76, 45.725, 4.92, 45.815)
        win = from_bounds(*b, src.transform).round_offsets().round_lengths()
        data = src.read(window=win)
        prof = src.profile.copy(); prof.update(PROFILE, width=data.shape[2], height=data.shape[1], transform=src.window_transform(win), photometric="RGB", nodata=0)
    p = os.path.join(OUT, "lyon-s2-utm31.tif")
    with rasterio.open(p, "w", **prof) as dst:
        dst.write(data)
        dst.build_overviews([2, 4, 8, 16], Resampling.average)
    print("s2", data.shape, os.path.getsize(p))

def dem():
    url = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N44_00_E003_00_DEM/Copernicus_DSM_COG_10_N44_00_E003_00_DEM.tif"
    with rasterio.open(url) as src:
        win = from_bounds(3.20, 44.22, 3.55, 44.45, src.transform).round_offsets().round_lengths()
        data = src.read(1, window=win)
        prof = src.profile.copy(); prof.update(PROFILE, width=data.shape[1], height=data.shape[0], transform=src.window_transform(win), predictor=3)
    p = os.path.join(OUT, "tarn-dem.tif")
    with rasterio.open(p, "w", **prof) as dst:
        dst.write(data, 1)
        dst.build_overviews([2, 4, 8], Resampling.average)
    print("dem", data.shape, os.path.getsize(p))

def wmts():
    os.makedirs(os.path.join(OUT, "wmts"), exist_ok=True)
    mats = []
    for z in range(0, 17):
        scale = 559082264.0287178 / 2 ** z
        mats.append(f"""      <TileMatrix><ows:Identifier>{z}</ows:Identifier><ScaleDenominator>{scale}</ScaleDenominator><TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>{2**z}</MatrixWidth><MatrixHeight>{2**z}</MatrixHeight></TileMatrix>""")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
  <ows:ServiceIdentification><ows:Title>Viewer demo WMTS (offline Sentinel-2 tiles)</ows:Title><ows:ServiceType>OGC WMTS</ows:ServiceType><ows:ServiceTypeVersion>1.0.0</ows:ServiceTypeVersion></ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>Sentinel-2 summer 2025 (demo areas)</ows:Title>
      <ows:WGS84BoundingBox><ows:LowerCorner>-180 -85.05</ows:LowerCorner><ows:UpperCorner>180 85.05</ows:UpperCorner></ows:WGS84BoundingBox>
      <ows:Identifier>s2-2025</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <Format>image/jpeg</Format>
      <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/jpeg" resourceType="tile" template="../../imagery/s2/{{TileMatrix}}/{{TileCol}}/{{TileRow}}.jpg"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>GoogleMapsCompatible</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <WellKnownScaleSet>urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible</WellKnownScaleSet>
{chr(10).join(mats)}
    </TileMatrixSet>
  </Contents>
</Capabilities>
"""
    open(os.path.join(OUT, "wmts/WMTSCapabilities.xml"), "w").write(xml)

if __name__ == "__main__":
    rivers(); places(); wmts(); s2(); dem()
