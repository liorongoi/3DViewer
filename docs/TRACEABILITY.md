# VIEWER — Requirements Traceability

Every requirement in the SRS mapped to the work package (WP) that builds it and the test that proves it. WP numbers refer to section 5.3 of the [implementation plan](./IMPLEMENTATION_PLAN.md). T = threshold (Release 1), O = objective (later).

## Functional requirements

| ID | P | Summary | Built in | Verified by |
|---|---|---|---|---|
| VWR-FMT-01 | T | Open FBX (binary/ASCII, 2014+) with meshes, hierarchy, materials, textures | 0.4, 3.4, 5.2 | AC-01; converter regression set |
| VWR-FMT-02 | T | Open glTF 2.0 and GLB | 1.2 | AC-01; Khronos samples |
| VWR-FMT-03 | T | Open 3D Tiles 1.0/1.1 (b3dm, i3dm, pnts, cmpt, glTF), stream by LOD | 1.2, 1.5, 5.3 | AC-01; 3d-tiles-samples conformance |
| VWR-FMT-04 | T | Draco, meshopt, KTX2/Basis | 1.2, 3.4 | Compressed variants of Khronos samples |
| VWR-FMT-05 | T | Reject bad files with clear message, no crash | 1.2, 3.3 | AC-02 |
| VWR-FMT-06 | T | Convert FBX → GLB, very large → 3D Tiles; keep original | 3.4 | AC-07 |
| VWR-FMT-07 | O | OBJ, photogrammetry 3D Tiles, I3S | Seam: `LoaderPlugin` (plan 4.4) | — |
| VWR-FMT-08 | T | Read georeference, place on Earth; hold uploads without one | 1.3, 3.4, 4.2 | Placement test (≤ 10 cm); upload without georef is held |
| VWR-RND-01 | T | glTF metallic-roughness PBR, all maps | 1.4 | AC-03 |
| VWR-RND-02 | T | Map FBX Phong/Lambert/Stingray to PBR | 0.4, 3.4 | Visual regression on producer files |
| VWR-RND-03 | T | IBL from bundled HDRs + sun with soft shadows (toggle) | 1.4 | AC-03; visual tests |
| VWR-RND-04 | T | Tone mapping and anti-aliasing | 1.4 | AC-03 |
| VWR-RND-05 | T | Shaded, shaded + edges, wireframe, unlit | 1.4 | Visual tests per mode |
| VWR-RND-06 | T | 3D Tiles SSE LOD and memory cap | 1.5 | NFR-02/04 perf runs |
| VWR-RND-07 | O | Sun by date and time | Seam: sun driven by `JulianDate` | — |
| VWR-RND-08 | T | Terrain + imagery base layers, aligned, served internally | 1.6, 5.6 | Base map test sites |
| VWR-RND-09 | T | Toggle base layers, choose imagery source | 1.6 | UI test |
| VWR-RND-10 | T | Model on top of terrain, no flicker or poke-through | 1.6 | Visual tests at 3 sites |
| VWR-RND-11 | T | Base map installed separately; offline package and/or WMTS; works with none | 1.6, 3.9, 5.6 | Install test; viewer with no base map |
| VWR-NAV-01 | T | Zoom by wheel, pinch, +/− toward cursor | 1.7 | AC-04 |
| VWR-NAV-02 | T | Orbit with left-drag around double-click pivot | 1.7 | AC-04 |
| VWR-NAV-03 | T | Pan with right/middle-drag and arrow keys | 1.7 | AC-04 |
| VWR-NAV-04 | T | View cube / compass presets, north arrow | 1.7 | AC-04 |
| VWR-NAV-05 | T | Home and Focus selection | 1.7 | AC-04 |
| VWR-NAV-06 | O | Walk mode | Seam: camera modes, R reserved | — |
| VWR-NAV-07 | T | `?` help overlay | 1.7 | UI test |
| VWR-NAV-08 | O | Saved camera views | Seam: share-view state (4.6) | — |
| VWR-LYR-01 | T | Layers tree mirroring hierarchy | 2.1, 2.2 | AC-05 |
| VWR-LYR-02 | T | Toggle single layer and parent with children | 2.1, 2.2 | AC-05 |
| VWR-LYR-03 | T | Show all / hide all | 2.2 | AC-05 |
| VWR-LYR-04 | T | Search layers by name | 2.2 | AC-05 |
| VWR-LYR-05 | T | Isolate and undo | 2.2 | AC-05 |
| VWR-LYR-06 | O | Layer transparency | Seam: `opacity` in layer model | — |
| VWR-LYR-07 | O | Section plane / box | Seam: clipping planes in core; disabled dock slot | — |
| VWR-MSR-01 | T | Two-point distance | 2.4, 2.5 | AC-06 |
| VWR-MSR-02 | T | Path with segments and total | 2.4, 2.5 | AC-06 |
| VWR-MSR-03 | T | Snap to vertices/edges within 10 px, indicator | 2.3 | Snap hit-rate test |
| VWR-MSR-04 | T | Sidebar: label, 3D, horizontal, height diff, units | 2.5 | AC-06 |
| VWR-MSR-05 | T | m/ft, rename, hide, delete, copy | 2.5 | AC-06 |
| VWR-MSR-06 | T | Warn when no reliable scale; "model units" | 2.4 | Test model without units |
| VWR-MSR-07 | O | Area, height above ground | Seam: `ToolPlugin`, polygon type | — |
| VWR-MSR-08 | T | Coordinates in WGS84 or UTM, remembered, copyable | 2.6 | proj reference comparison (1 mm) |
| VWR-UPL-01 | T | Upload FBX, glTF (folder/ZIP), GLB, 3D Tiles (ZIP/folder) from web and EXE | 3.2, 4.2, 5.1 | AC-07 |
| VWR-UPL-02 | T | Validate and report every problem | 3.3, 4.2 | AC-02 |
| VWR-UPL-03 | T | Progress and resume > 100 MB | 3.2, 4.2 | AC-07 |
| VWR-UPL-04 | T | Edit metadata (4 fields + description + classification) | 3.6, 4.2, 4.4 | AC-08 |
| VWR-UPL-05 | T | Status list with last-change date | 3.6, 4.4 | AC-08 |
| VWR-UPL-06 | T | Library cards + filters | 4.1 | Library UI tests |
| VWR-UPL-07 | T | New versions, old ones openable | 3.6, 4.4 | AC-08 |
| VWR-UPL-08 | T | Automatic thumbnail | 3.5 | AC-07 |
| VWR-UPL-09 | T | Layer editor at upload, carried to next version | 3.4, 3.6, 4.3 | Manifest round-trip test |
| VWR-UPL-10 | T | Classification per model, audited, banner everywhere incl. exports | 3.5, 3.6, 4.5 | Screenshot/export tests; audit check |
| VWR-ADM-01 | T | No login; admin page and permanent delete need password | 3.9 | AC-09 |
| VWR-ADM-02 | T | Admin: classification list, delete, quotas | 3.9 | AC-09 |
| VWR-ADM-03 | T | EXE opens local files offline and library when online | 5.1–5.4 | AC-01 (EXE) |

## Non-functional requirements

| ID | Target | Built in | Verified by |
|---|---|---|---|
| NFR-01 | 200 MB GLB first frame ≤ 5 s | 1.2, 3.4, 6.3 | Perf run on A4000 |
| NFR-02 | 3D Tiles first view ≤ 3 s | 1.5, 6.3 | Perf run |
| NFR-03 | ≥ 60 fps average, never < 30 | 1.5, 6.3 | AC-04; perf HUD export |
| NFR-04 | VRAM budget 10 GB default, no crash | 1.5 | Budget overflow test |
| NFR-05 | 20 concurrent users | 3.7, 6.3 | k6 load test |
| NFR-06 | ≥ 10 TB, ≥ 5,000 versions | 3.1, 6.3 | Synthetic storage test |
| NFR-07 | Error ≤ 0.1% or 1 cm | 2.4, 2.7 | AC-06 |
| NFR-08 | Matches Khronos reference viewer | 1.4 | AC-03 |
| NFR-09 | ≥ 99.5% availability in working hours | 5.6, 6.6 | Monitoring + runbook; pilot |
| NFR-10 | No data loss on failed upload/conversion | 3.2, 3.4 | Kill-worker and cut-network tests |
| NFR-11 | Every action logged with workstation, IP, time; ≥ 1 year | 3.8 | AC-08 audit check |
| NFR-12 | Zero outbound connections | 4.3 (plan), 6.4 | AC-10; `--network=none` CI job |
| NFR-13 | TLS 1.2+ with org certificates | 3.7, 5.6 | TLS scan |
| NFR-14 | AV scan + sandboxed parsing | 3.3, 3.4 | Hostile file tests; pen test |
| NFR-15 | 4 of 5 new users finish core task ≤ 5 min | 0.7, 6.5 | Usability test |
| NFR-16 | Hebrew (RTL) and English, live switch, remembered | 1.8, 6.1 | Native-speaker review; RTL visual tests |
| NFR-17 | Dark default, light option, ≥ 4.5:1 | 1.8, 6.2 | Contrast tests (tokens pre-checked in UI spec) |
| NFR-18 | One core; same measurement to 1 mm | 2.3 (plan), 2.7 | Web vs EXE harness |
| NFR-19 | Formats as plug-ins | 1.1 | Dummy plug-in test |
| NFR-20 | Offline server install ≤ 2 h | 5.6, 6.6 | Timed clean install |

## Constraints and acceptance scenarios

| Item | Covered by |
|---|---|
| C-1 No internet | Plan 4.3; offline mirror (0.1); bundled fonts/HDRs; AC-10 |
| C-2 Licences reviewed | WP 0.2; licence column in plan section 3; SBOM per release |
| C-3 FBX proprietary | WP 0.4 bake-off without Autodesk SDK |
| C-4 EXE = web features | Same build (AD-01/02); parity checklist in 5.1 |
| AC-01 … AC-10 | Gates G1–G6 (plan 5.2); final run in WP 6.7 |

## Added by the product owner, 2 Nov 2026

| ID | Type | Requirement | Work packages | Verification |
|---|---|---|---|---|
| VWR-GEO-01 | T | Online base map and terrain around models; internal equivalents | 1.6, 1.9, 3.9 | Terrain under 3 test models, no poke-through; online / internal switch |
| VWR-GEO-02 | T | User vector layers: Shapefile, GeoJSON, KML | 1.9 | 10 reference shapefiles within 1 m |
| VWR-GEO-03 | T | User base maps: GeoTIFF / COG, WMTS, WMS, XYZ | 1.9 | 2 GB COG streams; 3 public WMTS load from capabilities |
| VWR-ANL-01 | T | Line of sight for many point pairs | 2.8 | Matches GDAL reference on test DEM |
| VWR-ANL-02 | T | Height profile per pair | 2.8 | Profile heights within 1 sample of reference |
| VWR-ANL-03 | T | 360° viewshed, observer moved horizontally and vertically, live update | 2.9 | Within 2% of `gdal_viewshed`; ≥ 30 fps while dragging |
| VWR-LOD-01 | T | LOD inspector and detail control | 1.5, 2.10 | Values match Cesium statistics |
| VWR-DAT-01 | T | Public georeferenced test data in every format | 0.8 | Kit in DATA_SOURCES opens end to end |
