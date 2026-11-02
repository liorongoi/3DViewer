# VIEWER — Open Test Data and Base Map Sources

**Purpose:** public data we can use to build, test and demo VIEWER before (and alongside) the 3D production unit's real models.
**Checked:** 1 Nov 2026. Licence column shows **verified** when the licence was read on the publisher's page, and **to confirm** when the page did not state it. Confirm every licence again before data is transferred to the internal network.
**Companion:** [Implementation plan](./IMPLEMENTATION_PLAN.md), WP 0.8 "Test data kit".

> All of this data is downloaded on the internet side and moved into the internal network through the organisation's approved transfer process. VIEWER itself never fetches anything from the internet (C-1, NFR-12).

---

## 1. Photorealistic 3D Tiles cities (textured façades)

These are photogrammetry meshes made from oblique aerial photos, so building fronts carry real photo texture. They are the best stand-ins for intelligence-grade urban models and the main test data for 3D Tiles streaming, VRAM budget and measurement.

| # | Dataset | Format | Detail | Licence | Access | Use in VIEWER testing |
|---|---|---|---|---|---|---|
| 1 | **Strasbourg photomesh 2018 / 2022** (Eurométropole de Strasbourg, Od@CiT) | **3D Tiles** and OBJ; ~6,000 tiles of 250 × 250 m, ~2 TB | 5 cm source photos, ~10 cm absolute accuracy | **Licence Ouverte / Etalab — verified** (credit Ville et Eurométropole de Strasbourg) | Live tileset: `https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json`; metadata sheet on sig.strasbourg.eu | Headline demo; 50 GB-class streaming test (take a subset); measurement on façades |
| 2 | **Auvergne-Rhône-Alpes photomesh 2021** (CRAIG) — 14 cities incl. Clermont-Ferrand, Saint-Étienne, Vichy, Valence | **3D Tiles**, OBJ, I3S/SLPK, 3DML | 3–5 cm source photos (oblique at Vichy and Saint-Étienne) | **To confirm** (data.gouv.fr lists "not specified"; CRAIG site is Licence Ouverte 2.0) | Live Clermont tileset: `https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json`; other zones on request from CRAIG | Second city, different producer; I3S copy useful for FMT-07 later |
| 3 | **Lille Métropole 3D model 2016** (MEL) | **3D Tiles** (live), photomesh from 2016 aerial photos | 10 cm | **Licence Ouverte 2.0 — verified** on data.gouv.fr | Live tileset: `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json`. **Geo-blocked** (Nov 2026): the server answers "indisponible depuis votre localisation" outside France, so we use the Lyon photomesh (#7) instead | Whole-metropolis scale; LOD and memory tests |
| 4 | **Helsinki 3D Mesh** (City of Helsinki), incl. Kalasatama reality mesh | OBJ and 3MX (**not** 3D Tiles) | City-wide reality mesh | **CC BY 4.0 — verified** | kartta.hel.fi map download, `3d.hel.ninja/data/mesh/`, Stadi3D tool via hri.fi | **Pipeline test**: convert OBJ → 3D Tiles with our tiler (WP 0.5, 3.4) |
| 5 | **PLATEAU** (Japan MLIT) — 200+ cities | CityGML, **3D Tiles**, **FBX**, OBJ, GeoPackage | LOD1–LOD2 buildings, many with textured LOD2 | **CC BY 4.0 / ODbL / ODC-BY multi-licence — verified** (OSM wiki; terms linked from PLATEAU site policy) | geospatial.jp CKAN, dataset `plateau` | **Real FBX test files** with georeference + 3D Tiles of the same area, so we can compare our FBX conversion against the publisher's tiles |
| 6 | **Lyon Metropolis 3D Tiles** (LIRIS / VCity, from Grand Lyon open data) | **3D Tiles** (incl. temporal 2009 / 2012 / 2015 vintages) | Building models by borough | **Etalab Open Licence 2.0 — verified** (README) | `dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/` | Many medium tilesets; layer-per-tileset tests (LYR) |
| 7 | **Photomaillage 3D de la Métropole de Lyon** (2023 aerial survey) | **3D Tiles 1.0** (b3dm with glTF 1.0), 9-level pyramid over 34,812 blocks of ~140 × 210 m, each with its own 5-level tree | 5.5 cm source photos | **Licence Ouverte 2.0 — verified** on data.grandlyon.com | Live tileset: `https://data.grandlyon.com/files/grandlyon/2023/mesh/tileset.json` | Photo-textured city sample: `scripts/fetch-lyon-photomesh.mjs` takes one district (Fourvière) with its LOD |

### 1.1 Photorealistic sources we cannot use on the internal network

| Source | Why not |
|---|---|
| **Google Photorealistic 3D Tiles** (Map Tiles API) | Highest quality worldwide, but Google's Map Tiles API policies forbid pre-fetching, storing or caching content and list offline use as prohibited. Fine as a UX reference on an internet-connected design machine only. |
| **Cesium ion content** (e.g. Aerometrex city meshes, Cesium OSM Buildings, Bing imagery) | Streamed from Cesium's cloud under ion terms; not for offline redistribution. |

---

## 2. Format conformance and rendering reference

| Dataset | Format | Licence | Use |
|---|---|---|---|
| **Khronos glTF Sample Assets** (`KhronosGroup/glTF-Sample-Assets`) | glTF, GLB, Draco, meshopt, KTX2 variants | **Per model — verified**: each model's README states its licence (many CC BY 4.0 or CC0). Avoid the five models the repo flags as uncertain (Antique Camera, Box Textured, Box Textured not 2^N, Cesium Man, Cesium Milk Truck). Also note: DamagedHelmet is CC BY-NC 4.0 and Sponza is under the Cryengine Limited License, so keep them out of the kit. | AC-03 / NFR-08 visual check vs Khronos Sample Viewer; FMT-02, FMT-04 |
| **CesiumGS 3d-tiles-samples** | 3D Tiles 1.0 and 1.1 (implicit tiling, metadata, multiple contents, i3dm, discrete LOD) | **To confirm** (check the repo LICENSE file) | FMT-03 conformance for every tile type |
| **bertt/cesium_3dtiles_samples** (Utrecht 3D, Delaware 1.1, Grenoble trees) | 3D Tiles 1.0/1.1 | **To confirm** | Extra real-world 1.1 tilesets |
| **3DBAG** (TU Delft) — all buildings in the Netherlands | CityJSON / OBJ / GPKG on 3dbag.nl; GeoParquet + PMTiles mirror on Source Cooperative | **CC BY 4.0 — verified** | Untextured LOD2 at country scale; tiler stress test; layer naming |
| **Helsinki CityGML model** | CityGML | **CC BY 4.0 — verified** | Semantic layers (buildings, terrain) → layer proposal tests |
| Corrupt / edge-case files (made by us) | Truncated GLB, glTF with missing texture, FBX with bad header, tileset with missing tiles, zip-bomb, path traversal ZIP | Ours | AC-02, UPL-02, NFR-14 |
| Real producer files (from the 3D production unit) | FBX, glTF/GLB, 3D Tiles | Internal | Phase 0 bake-offs, AC-01, AC-06 with surveyed distances |

---

## 3. Base map data (terrain and imagery)

The real deployment uses the organisation's own DEM and orthophotos (SRS 5.2). These open sources let us build and test the **base map package** pipeline and give a worldwide fallback.

| Dataset | Type | Resolution | Licence | Use |
|---|---|---|---|---|
| **Copernicus DEM GLO-30** | Elevation (DSM) | 30 m, global | **Free, with attribution — verified** (Copernicus DEM licence) | Global terrain fallback → quantized-mesh via cesium-terrain-builder |
| **SRTM 1 arc-second** (NASA/USGS) | Elevation | ~30 m, 60°N–56°S | Public domain | Second terrain source for comparison |
| **Sentinel-2 cloudless 2016** (EOX) | Imagery | 10 m | **CC BY-SA 4.0 — verified** ("Contains modified Copernicus Sentinel data 2016") | Global imagery layer for tests. Later vintages are under a non-commercial licence: check before use. |
| **NASA Blue Marble** | Imagery | 500 m | Public domain | Low-zoom globe imagery |
| **Natural Earth** | Vector + raster | 1:10 m – 1:110 m | Public domain | Library globe view background, borders, coastlines |
| Organisation DEM (GeoTIFF / DTED) and orthophotos | Elevation + imagery | High | Internal | Production base map package (RND-08 to RND-11) |

---

## 4. Tools for preparing test data (all run on the internet side or the build server)

| Tool | Licence | What for |
|---|---|---|
| mago 3DTiler (Gaia3D) | MPL-2.0 — verified | OBJ / FBX / glTF / CityGML / IFC / LAS → 3D Tiles 1.1 |
| 3d-tiles-tools (CesiumGS) | Apache-2.0 | Merge, upgrade 1.0 → 1.1, convert b3dm ↔ glb, pack/unpack |
| 3d-tiles-validator (CesiumGS) | Apache-2.0 | Validate every tileset in the kit |
| glTF-Transform | MIT | Make meshopt / Draco / KTX2 variants of test models |
| GDAL | MIT/X | Reproject, mosaic, tile imagery and DEMs |
| cesium-terrain-builder | Apache-2.0 | DEM → quantized-mesh terrain |
| py3dtiles | Apache-2.0 | Point clouds (LAS/LAZ) → `pnts` 3D Tiles |

**Excluded:** Obj2Tiles (AGPL-3.0), MinIO (AGPL-3.0) — unlikely to pass licence review (C-2).

---

## 5. Proposed test data kit (WP 0.8)

| Kit item | Source | Covers |
|---|---|---|
| 1 FBX building (with surveyed distances) | 3D production unit; PLATEAU FBX as open stand-in | AC-01, AC-06, FMT-01, RND-02 |
| 1 glTF/GLB urban block | Khronos-style test block made from PLATEAU or 3DBAG + producer file | AC-01, FMT-02 |
| 1 3D Tiles city with realistic façades (subset, ~20–50 GB) | Strasbourg photomesh | AC-01, FMT-03, RND-06, NFR-02/04 |
| 1 3D Tiles terrain/city from our own tiler | Helsinki mesh → mago 3DTiler | FMT-06, AD-04 |
| Khronos sample set: SciFiHelmet, WaterBottle, BoomBox, Lantern, Corset (CC0), MetalRoughSpheres (CC BY 4.0). All use core metallic-roughness only, with no extensions (checked 2 Nov 2026) | Khronos glTF Sample Assets | AC-03, NFR-08 |
| 3D Tiles conformance set | CesiumGS 3d-tiles-samples | FMT-03 every tile type |
| Corrupt / hostile files | Made by us | AC-02, NFR-14 |
| Base map package (test) | Copernicus DEM + Sentinel-2 cloudless 2016 over the test cities | RND-08 to RND-11 |

## 6. Data now in the prototype (added 2 Nov 2026)

Everything below is downloaded by `scripts/fetch-samples.sh`, `scripts/build-demo-basemaps.py` and `scripts/build-user-data-samples.py`, and works with no network once built. Each item shows one format the viewer must handle, georeferenced, with a real LOD structure where the format has one.

| Item | Format and LOD | Where it is | Source and licence | Shows |
|---|---|---|---|---|
| Lyon 1st district, textured buildings | 3D Tiles 1.0, b3dm, 3-level LOD tree, ECEF (EPSG:4978) | `samples/3dtiles/lyon1` | Data Grand Lyon via iTowns sample data; **Licence Ouverte 2.0** | City on terrain, height-datum fit (+80 m), line of sight and viewshed against buildings |
| Lyon Fourvière photomesh | 3D Tiles 1.0, b3dm (glTF 2.0, Draco, unlit), 7 LOD levels (4 pyramid + 3 per block), 16 blocks | `samples/3dtiles/lyon-photomesh` | Data Grand Lyon photomesh 2023; **Licence Ouverte 2.0** | Photo-textured city on terrain, street-level ground fit, LOD streaming |
| Tarn gorges lidar | 3D Tiles 1.0, pnts, 11-level octree, 4,318 tiles, ECEF | `samples/3dtiles/tarn-lidar` | IGN Lidar HD via iTowns sample data; **Licence Ouverte 2.0** | LOD inspector, point clouds on terrain |
| Discrete LOD and request volume tilesets | 3D Tiles 1.0 | `samples/3dtiles/TilesetWith*` | CesiumGS 3d-tiles-samples; Apache 2.0 | Format conformance, LOD switching |
| Sentinel-2 L2A true colour, summer 2025 | XYZ JPEG tiles z10–15 for Jerusalem, Lyon, Tarn | `samples/imagery/s2` | Copernicus Sentinel-2 via AWS Open Data (`sentinel-cogs`); **Copernicus open licence**, "Contains modified Copernicus Sentinel data 2025" | Offline base map |
| Terrain Tiles | Terrarium PNG z0–3 world, z6–14 for the three areas | `samples/terrain` | AWS Open Data Terrain Tiles (SRTM, GMTED, ETOPO1 and others); attribution per the dataset's notice | Offline terrain; the same code reads the full online set |
| Rivers near Lyon | **Shapefile** (.shp .dbf .prj .cpg) in **Lambert-93, EPSG:2154** | `samples/user-data/lyon-rivers-l93.*` | Natural Earth 1:10 m; **public domain** | User shapefile reprojected on the fly, draped on terrain |
| Towns of France and Israel | **Shapefile**, WGS 84 | `samples/user-data/places-fr-il.*` | Natural Earth 1:10 m; public domain | Point layer with labels |
| Lyon Sentinel-2 | **GeoTIFF**, tiled with overviews (COG layout), **UTM 31N, EPSG:32631**, 10 m | `samples/user-data/lyon-s2-utm31.tif` | Copernicus Sentinel-2; Copernicus open licence | User GeoTIFF as overlay or as base map, read window by window |
| Tarn elevation | **GeoTIFF**, one float band, WGS 84, 30 m | `samples/user-data/tarn-dem.tif` | **Copernicus DEM GLO-30** via AWS Open Data; free licence with attribution | Elevation drawn as shaded relief |
| Offline WMTS | **WMTS 1.0 GetCapabilities** (RESTful, GoogleMapsCompatible) over the Sentinel-2 tiles | `samples/user-data/wmts/WMTSCapabilities.xml` | Made by us | User WMTS, used as the base map |

Online sources the viewer can use when a network is present (development and demonstrations only; the internal network uses internal mirrors, WP 3.9): AWS Terrain Tiles (world, z15), Esri World Imagery, EOX Sentinel-2 cloudless 2016 (CC BY 4.0), OpenStreetMap tiles, and any COG over HTTP range requests (for example the Sentinel-2 and Copernicus DEM buckets on AWS).

Formats still to add to the kit: FBX and OBJ (derived from the Lyon tiles, WP 0.8), KML/KMZ and GeoJSON examples (the loaders are in place), and a quantized-mesh terrain from our own tiler (WP 3.9).

---

## Sources

- Strasbourg photomesh metadata: https://www.sig.strasbourg.eu/datastrasbourg/3d_fiches_metadonnees_pdf/Photomaillage%203D%202018.pdf
- Sample 3D Tiles / photomesh list (Iconem 3DTiled docs): https://docs.3dtiled.iconem.com/docs/guide/planning/sample-data
- CRAIG photomesh 2021: https://www.data.gouv.fr/datasets/photomaillage-3d-auvergne-rhone-alpes-2021/informations
- Lille MEL 3D model 2016: https://www.data.gouv.fr/datasets/maquette-3d-mel-2016-1/informations
- Helsinki 3D: https://hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d
- PLATEAU (OSM wiki summary): https://wiki.openstreetmap.org/wiki/MLIT_PLATEAU · portal: https://www.mlit.go.jp/plateau/open-data
- Lyon 3D Tiles (LIRIS): https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/README.txt
- Lyon photomesh: https://www.data.gouv.fr/datasets/6752312729bbdda4ba8f637f
- 3DBAG on Source Cooperative: https://data.source.coop/cholmes/portolan-nl/tudelft/3dbag/AGENTS.md
- Khronos glTF Sample Assets: https://github.com/KhronosGroup/glTF-Sample-Assets
- CesiumGS 3d-tiles-samples: https://github.com/CesiumGS/3d-tiles-samples
- Google Map Tiles API policies: https://developers.google.com/maps/documentation/tile/policies
- Copernicus DEM licence: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf
- Sentinel-2 cloudless 2016: https://eox.at/2017/03/sentinel-2-cloudless-original-tiles-available/
- mago 3DTiler: https://github.com/Gaia3D/mago-3d-tiler
- iTowns sample data (Lyon, Tarn): https://github.com/iTowns/iTowns2-sample-data
- Sentinel-2 COGs on AWS: https://registry.opendata.aws/sentinel-2-l2a-cogs/
- Terrain Tiles on AWS: https://registry.opendata.aws/terrain-tiles/
- Copernicus DEM on AWS: https://registry.opendata.aws/copernicus-dem/
- Natural Earth: https://www.naturalearthdata.com/about/terms-of-use/
