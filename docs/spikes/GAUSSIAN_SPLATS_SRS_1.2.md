> **Input document, kept as received (20 November 2026).** This SRS was drafted for another codebase: the file names, environment variables, test counts and evidence it cites (for example `SPZ-IMPORT.md`, `VIEWER_SPLATFACTO_COMMAND`, "214 tests", the Mac runs) describe that system, not HOLO. How HOLO meets each requirement, and what is still open, is in [GAUSSIAN_SPLATS.md](../GAUSSIAN_SPLATS.md).

# Geo Splatian Viewer Integration SRS

Document revision: 1.2 · Updated: 20 November 2026 · Product baseline: VIEWER 0.6.0.

Status: requirements baseline completed; implementation and deployment acceptance remain separate. “Shall” expresses a required outcome, not a claim that it has passed. This revision incorporates finished SPZ import, capture reconstruction, geospatial placement, analysis boundaries, quality acceptance and delivery requirements. It preserves the specialist worker contracts below.

## Purpose, users and scope

The operator shall be able to open an existing Gaussian model or reconstruct one from overlapping captures, review it interactively, place it in the model library, and retain the source and processing history. Administrators configure reconstruction workers and storage. Survey reviewers assess spatial accuracy independently of appearance.

Two workflows shall remain explicit: **finished model import** requires no training; **capture reconstruction** requires a configured, compatible worker. A source video, reconstructed interactive scene and exported presentation movie are separate artifacts. Importing SPZ shall not imply that reconstruction, survey validation or movie export has occurred.

The release shall preserve existing mesh models, GIS layers, offline maps and terrain. Gaussian support shall use the existing library, full-screen navigation, placement and model lifecycle. No claim of survey-grade geometry, satellite reconstruction or large-area production readiness follows from a successfully rendered example.

## Finished Gaussian model import

| ID | Requirement | Acceptance |
|---|---|---|
| GS-11 | Browser/server uploads shall accept standalone `.spz` and a supported single-model ZIP. Desktop local-open shall accept `.spz` and prepare a derived cache without modifying the source. | Import, reopen after restart, remove the library reference, and confirm the original bytes remain unchanged. |
| GS-12 | The adapter shall identify SPZ v2 and v3 gzip data and v4 NGSP/Zstandard data from their headers. The current direct-import contract supports SH degrees 0–3, at most 2,000,000 splats, and 160 MiB input/decompressed data. | Exercise each version plus corrupt headers, inconsistent stream sizes, truncation, trailing data, excessive counts and decompression limits. Reject before publication with a useful reason. |
| GS-13 | Unsupported v1, SH degree 4, extension payloads and coordinate overrides shall be rejected explicitly. Default RUB coordinates shall be converted consistently into the viewer frame. | Unsupported inputs cannot silently appear as a valid but misoriented model. Test supported orientation using known coordinates. |
| GS-14 | The current renderer adapter shall retain validated v2 compressed bytes unchanged. V3/v4 conversion shall preserve position, scale, opacity, color and SH attribute streams and declare reduced quaternion precision when converting rotations to v2. | Verify exact v2 bytes, preserved attribute streams and known rotation fixtures. Properties records source/render version, count, SH degree and conversion. |
| GS-15 | Gaussian scenes shall remain visible after asynchronous decoding and sorting, and initial framing shall tolerate background outliers without deleting content. | Open the real reference sample, stop camera input, rotate and zoom. Inspect both the dense scene and complete bounds. Current implementation limits drawing to 30 fps; this is a cap, not a minimum-performance guarantee. |
| GS-16 | Import shall retain original data and attribution, apply quota checks, isolate derived assets, and prevent dependencies escaping the model root. | Failed jobs publish no partial model; quota rejection precedes output publication; source retention and contained dependency checks pass. |

SPZ is a compressed Gaussian representation. Its upstream specification includes capabilities beyond this bounded adapter; upstream format support must not be confused with VIEWER support. The v4 compatibility fixture used here was transcoded from a v2 sample and is not evidence of a native v4 capture pipeline. See [the compatibility and implementation notes](SPZ-IMPORT.md) and [Niantic's format reference](https://github.com/nianticlabs/spz/tree/d5abdee9b37c426a0b66b961c3d43b5857a24f4f).

The 3D Viewer shall accept overlapping ground, drone, airborne, or satellite captures and reconstruct static scenes as Gaussian splats. Operators choose a source family and goal. The worker selects a compatible reconstruction profile, publishes Cesium-compatible 3D Tiles, and opens the result through the existing model library. A rendered splat and a measured bare-earth terrain model are distinct deliverables with separate acceptance criteria.

## Phase 1 Video and image capture import

| ID | Requirement | Acceptance |
|---|---|---|
| GS-01 | The model upload dialog shall accept individual videos, images, folders, and ZIP bundles in Gaussian capture mode. Video formats are MP4, MOV, LRV, and TS. Image formats are JPG, PNG, and TIFF. | A folder and its equivalent ZIP select the same profile. The upload uses existing chunk resume and processing jobs. |
| GS-02 | The dialog shall request a capture family and output goal. The server shall resolve and persist the selected profile with the job. | Ground, drone, and airborne captures support the built-in viewer profile. Surface, large-area, and satellite profiles require their designated worker. |
| GS-03 | The built-in worker shall sample frames, preserve view diversity, recover poses with COLMAP, train with Splatfacto, export PLY, and package SPZ v2 in Cesium 3D Tiles. | A configured CUDA worker yields a valid 3D Tiles asset. The viewer opens it as a Gaussian splat using the existing scene loader. |
| GS-04 | An operator-supplied anchor shall place the local result as a preview. The model shall identify scale as unverified unless a worker supplies a validated georeference. | A local preview retains manual placement and unverified scale. A native georeference overrides the preview placement. |
| GS-05 | Processing shall reuse existing quarantine, retention, quota, progress, error and retry behavior. Tool commands shall receive discrete arguments. | Missing workers, invalid archives, and failed training publish no model. A retry can reuse the original upload. |

## Phase 2 Survey geometry and large areas

| ID | Requirement | Acceptance |
|---|---|---|
| GS-06 | A surface profile shall use 2DGS and pair it with an independently checked DSM or DTM when measurements are requested. | The result opens in Cesium and reports independent vertical error in metres. Ground-only elevations require a bare-earth reference. |
| GS-07 | A large-area profile shall use CityGaussianV2 or a hierarchical large-scene implementation with partitioning and view-dependent detail. | A representative multi-flight dataset opens without exceeding the agreed viewing memory budget. Check block seams and camera continuity. |
| GS-08 | Survey placement shall support synchronized camera GNSS or ground control, and record horizontal CRS, vertical datum, scale, and accuracy provenance. | Independent checkpoints confirm absolute horizontal and vertical error. The project shall set numeric thresholds before production acceptance. |

### Surface reconstruction and elevation comparison

Configure `VIEWER_SPLAT_SURFACE_COMMAND` with `scripts/surface-2dgs-worker.py` to use the bundled adapter. Set `VIEWER_2DGS_REPO` to the upstream checkout and `VIEWER_2DGS_PYTHON` to its configured Python environment. The adapter stages imagery, estimates and undistorts camera poses with COLMAP, fits 2DGS, and encodes a Cesium-compatible SPZ v2 preview. The preview approximates each planar Gaussian by adding a normal axis one hundredth the smaller in-plane scale.

The reference implementation requires licensor consent for commercial use. The service can use another surface implementation through the same worker contract. [Reference 2DGS license](https://github.com/hbb1/2d-gaussian-splatting/blob/main/LICENSE.md)

For built-in DSM export, install Rasterio alongside NumPy and plyfile in the configured worker Python environment, and include `terrain-grid.json` with the capture. The grid declares a projected horizontal EPSG code, `west` and `north` grid edges, `cellSize` in metres, `width` and `height` in cells, and `verticalDatum`. Its `modelToProjected` is a row-major 3×4 affine transform from the reconstructed COLMAP mesh frame to projected easting, northing, and elevation in metres. Supply a surveyed transform for that reconstruction. This grid georeferences the elevation raster. The preview uses the viewer's existing placement workflow.

To have the worker calculate the transform, replace `modelToProjected` with `controlPoints`. Each point is an object with `model: [x, y, z]` in the reconstructed mesh frame and `projected: [easting, northing, height]` in the declared CRS and vertical datum. Use at least three non-collinear points. The worker fits a 3D rotation, translation, and uniform scale. Optional `checkpoints` use the same format and are excluded from the fit. The viewer and capture lineage record the horizontal EPSG code, scale in metres per model unit, and separate horizontal and vertical RMS for controls and checkpoints. Project acceptance still uses agreed tolerances and independent field observations.

The bundled exporter samples triangle heights at cell centres, retains the highest intersection, and records no-data outside the mesh. It supports WGS 84 UTM, Israeli TM and Web Mercator. The viewer offers the exported GeoTIFF for download even without a reference comparison.

Set `VIEWER_2DGS_ELEVATION_COMMAND` to use a project-specific exporter, including ground classification for a DTM. The executable receives mesh PLY, undistorted COLMAP dataset, staged capture directory, and publish directory, in that order. It writes `elevation.tif` and `elevation.json` in the publish directory.

For elevation comparison, include `reference-elevation.tif` and `terrain-reference.json` with the capture. Both raster metadata files declare `kind` (`DSM` or `DTM`), `verticalDatum`, and `units` (`m`). The viewer holds the reference files outside the input directory passed to the worker. It compares valid reference pixel centres with the containing cells in the reconstructed surface, transforming horizontal coordinates between supported CRSs. The rasters must already share a vertical datum. The report records the sampling stride, sample counts, signed mean difference, vertical RMS, maximum absolute difference, and SHA-256 digests. The model panel shows the comparison and links to the output GeoTIFF. A surface job can also publish a preview before a reference is available.

The viewer communicates whether comparison is requested through `VIEWER_SURFACE_ELEVATION_REQUIRED` (`1` or `0`) and provides the expected raster type through `VIEWER_SURFACE_ELEVATION_KIND`. The bundled adapter checks the chosen export path before staging frames.

The Mac acceptance run submitted the real ground video and a synthetic reference DSM through the viewer API with the bundled adapter. FFmpeg and COLMAP registered and undistorted 100 frames. Simulated fitting supplied planar splats and a test mesh. The production SPZ encoder and Cesium decoder accepted the two-splat fixture. The built-in exporter rasterized the test mesh, and the viewer published the comparison with the expected bias of −0.5 m, RMS of 3.5355 m, and maximum absolute difference of 4 m for two valid samples. It retained the original upload and kept the reference raster out of the published model. Actual 2DGS fitting and field comparisons remain deployment acceptance requirements.

Manual placement supports independently measured WGS 84 checkpoints with ellipsoidal heights. The viewer reports and saves the checkpoint count, horizontal and vertical RMS, and maximum errors in metres. It fits the transform using the control points alone. Checkpoint results remain with the model version and carry through metadata edits that preserve placement. The model retains unverified scale until survey acceptance. The current validation uses known offsets on the ground-video tileset. Field-measured checkpoints and project-specific acceptance thresholds remain open.

### Synchronized video GNSS

For a ground, drone, or airborne preview, select one video with a file named `camera-gnss.csv` or upload a ZIP containing both. The CSV header is `time_s,longitude,latitude,ellipsoidal_height_m`. Times are seconds from the first video frame and must increase. Coordinates use WGS 84 longitude and latitude in degrees and ellipsoidal height in metres. The track must describe camera centres in the video timebase. Convert orthometric or relative heights and account for antenna-to-camera offsets before submission.

Configure the OpenSplat CPU worker for this capture profile. The worker records the presentation timestamps of selected source frames, joins the registered camera centres to exact or bracketing GNSS samples within a two-second gap, and submits at least six pairs for a similarity fit. OpenSplat exports centres in the splat coordinate frame. The viewer records the match count and residuals and marks the scale unverified. Embedded tileset placement takes precedence when present. Manual control points can replace the camera-GNSS fit. Captures without this sidecar can use manual placement. A supplied sidecar with invalid coordinates, too few matches, or degenerate geometry fails the job with the input retained.

The ground-video upload completed end to end with simulated telemetry generated from a known transform. The fit used 50 matched camera positions, reported 0.0008 m RMS, and published a Cesium-decodable 60,144-splat model. These results verify synchronization and placement against the simulated reference. Flight telemetry and field-measured accuracy remain to be validated on representative data.

### Large-area packaging

Set `VIEWER_SPLAT_LARGE_AREA_COMMAND` to `scripts/large-area-worker.py` and configure `VIEWER_LARGE_AREA_TRAINER` with an installed backend. The backend receives the staged capture directory, private work directory, output Gaussian PLY path, and source family. It supplies a fitted PLY in its local scene frame with floating-point Gaussian attributes. Set `VIEWER_LARGE_AREA_PYTHON` to an environment with NumPy and plyfile, and configure the SPZ v2 encoder. An existing fitted PLY can also be packaged directly with `package-large-gaussian-tiles.py INPUT_PLY WORK_DIR OUTPUT_DIR`.

The packager splits the cloud along the longest axis at its median, uses tile-local coordinates for SPZ encoding, and writes a 3D Tiles hierarchy with replacement refinement. Leaves keep every original splat, capped at 32,768 per tile by default. Parent tiles use deterministic subsamples where their spans fit SPZ positions. Branches with wider spans retain their child hierarchy and omit overview content. Parent error uses the centre-bound diagonal as a refinement heuristic. Verify visual continuity and memory on representative scenes before choosing production level-of-detail settings. [OGC 3D Tiles standard](https://www.ogc.org/standards/3DTiles/)

The Mac upload smoke test called the bundled worker with a trainer fixture that returned the previously fitted ground-video PLY. The API served the 8,192-splat overview and both leaf tiles with 59,199 splats in total. A separate 5,000-unit separation fixture verified the split, nested translations, and Cesium SPZ decoding. Multi-flight fitting, visual seams, camera continuity, and browser memory acceptance remain open.

## Phase 3 Satellite reconstruction

| ID | Requirement | Acceptance |
|---|---|---|
| GS-09 | Satellite jobs shall use a worker that understands the sensor model and required sidecars. The worker may use EOGS or a verified geometry-oriented successor and shall preserve calibration metadata. | A calibrated multi-view fixture yields a georeferenced splat and produces elevation comparison results against a reference DSM or stereo baseline. |
| GS-10 | A satellite video worker shall establish camera metadata per selected view and adequate baseline for the requested goal before reconstruction. | A suitable capture produces a result. A clip without calibration or view separation fails with an actionable reason. |

### Satellite calibration and preflight

Upload the calibrated media with exactly one `satellite-calibration.json`. Version 1 uses `version: 1`, `mode: "images"` or `"video"`, `target: { longitude, latitude, ellipsoidalHeight }` in WGS 84 degrees and metres, and a project-chosen `minimumConvergenceDegrees` for the requested goal. File paths are relative to the manifest directory. Provide two to 300 views.

- Still views declare `file`, `width`, `height`, and `positionEcef` in metres, plus `rpc` in GDAL RPC00B order. Provide numeric offsets and scales and four arrays of 20 coefficients. The viewer projects the target into the declared image bounds. [GDAL RPC metadata](https://gdal.org/en/stable/user/raster_data_model.html#rpc-domain)
- Video declares one `file` and shared rectified pinhole `intrinsics: { width, height, fx, fy, cx, cy }` in pixels. Each view supplies `timeSeconds`, `positionEcef`, and the unit `cameraToEcef` quaternion in `[x, y, z, w]` order. The camera frame uses X right, Y down, and Z forward. Pixel coordinates refer to the decoded raster before any display rotation. Times are presentation timestamps relative to the first decoded frame. FFprobe checks that each timestamp matches a frame and that its decoded dimensions match the intrinsics.

The viewer computes maximum pairwise convergence from the camera positions about the target and checks the capture's declared minimum. This checks the supplied geometry. The reconstruction backend still verifies overlap and feature support across the scene. Set `VIEWER_SPLAT_SATELLITE_COMMAND` to a calibrated backend. It receives the unchanged staged manifest and imagery through the worker contract and must publish SPZ v2 3D Tiles with embedded WGS 84 placement. Satellite surface jobs can include independent elevation reference files through the existing terrain comparison contract.

The still-image API tests exercised synthetic RPC metadata and rejected out-of-frame targets and inadequate convergence. The video API smoke test used the real ground clip with two simulated satellite camera poses and a fixture worker. FFprobe verified its frame timestamps and dimensions. The job published the embedded placement and an 18.27° convergence summary without changing the source video. Actual satellite reconstruction and elevation accuracy remain unverified.

## Phase 4 Release acceptance

Run a real GPU job for each supported profile, including one drone video with telemetry and one ground video. Verify file and folder import, failure and retry, Cesium rendering, alignment, and renderer memory on the shipped browser and desktop builds. Compare conventional surface outputs separately from the splat preview. Record tool versions and the accepted datasets. Keep the feature opt-in until the deployed worker is configured.

## Worker contract

The server selects a profile from source family and goal and supplies an input directory and a private working directory. The output directory shall hold a root `tileset.json` declaring the Cesium-supported Gaussian glTF and SPZ v2 compression extensions. Dependencies shall be local and contained under that directory. Workers shall leave intermediates outside the publish directory and stop on cancellation or hard timeout. A worker should verify overlaps and camera registration, respect operator data retention policy, and run with restricted filesystem and network access.

## Implementation evidence

The staged Viewer includes Phase 1 capture import, worker routing, processing, georeferencing, and SPZ v2 packaging. The current Mac production build and all 214 tests passed; five dedicated SPZ tests extend the earlier 209-test suite. A real ground MP4 completed the Viewer upload and processing job using FFmpeg, COLMAP 4.2.1, OpenSplat 1.2.2, and the SPZ v2 packager. Cesium 1.146 loaded the published tileset and decoded all 60,464 splats. The retained original and the source MP4 had identical SHA-256 digests, and the original was inaccessible through the asset URL. The placement endpoint and loader applied a known transform from four simulated control points with sub-millimetre error at a fifth point. That check verifies software placement. Survey accuracy requires measured controls and independent checkpoints. The subsequent browser review confirmed visible Gaussian drawing. The existing Metal video reconstruction renders but remains visibly blurred, so successful processing does not establish visual-quality acceptance. Native Windows, Ubuntu/RHEL and NVIDIA L40S fitting and rendering remain deployment checks.

## Preview worker configuration

| Runtime | Preview pipeline | Configuration |
| --- | --- | --- |
| Apple Silicon macOS | CPU COLMAP estimates camera poses. Brush trains using the Metal backend. | Set `VIEWER_BRUSH_COMMAND` to the absolute path of `scripts/brush-worker.py`. Use `VIEWER_BRUSH_BIN` and `VIEWER_COLMAP_BIN` when the executables are outside the service PATH. |
| NVIDIA CUDA | COLMAP estimates camera poses. Nerfstudio Splatfacto trains and exports a Gaussian PLY. | Set `VIEWER_SPLATFACTO_COMMAND` to the absolute path of `scripts/splatfacto-worker.py`. |
| CPU preview | CPU COLMAP estimates poses. OpenSplat fits 500 iterations at one-third of the staged image dimensions. | Set `VIEWER_OPENSPLAT_COMMAND` to the absolute path of `scripts/opensplat-worker.py`. Set `VIEWER_OPENSPLAT_BIN` and `VIEWER_COLMAP_BIN` when needed. This profile is selected when the applicable GPU preview workers are unconfigured. |

These preview paths use the same capture preprocessing and packaging contract. Configure `VIEWER_SPZ_V2_ENCODER` for the bundled packager or provide `VIEWER_SPLAT_PACKAGE_COMMAND`. The built-in packager requires a Niantic SPZ v2 encoder with the arguments `INPUT_PLY OUTPUT_SPZ`. The Mac worker selects the Metal backend and requires at least 12 registered images, a limit of 12,000 training iterations and 750,000 splats, and one final PLY export. Verify the reported Metal adapter and rendered result on the deployment Mac.

Surface, large-area, and satellite profiles dispatch only to separately configured workers. They have independent acceptance criteria in Phases 2 and 3.

## Technical references

- [Nerfstudio video preprocessing](https://docs.nerf.studio/quickstart/custom_dataset.html)
- [Splatfacto export](https://docs.nerf.studio/nerfology/methods/splat.html)
- [2D Gaussian Splatting](https://github.com/hbb1/2d-gaussian-splatting)
- [CityGaussianV2](https://github.com/Via-new/citygaussian-custom)
- [EOGS](https://openaccess.thecvf.com/content/CVPR2025/html/Aira_Gaussian_Splatting_for_Efficient_Satellite_Image_Photogrammetry_CVPR_2025_paper.html)
- [SatSplat evaluation](https://gdaosu.github.io/satsplat/)

## Cross-cutting functional requirements

| ID | Requirement | Acceptance |
|---|---|---|
| GS-17 | Each capture job shall record source family, requested goal, selected profile, processing state, actionable failure and retained-source reference. Where available it shall retain worker/tool versions, selected frame count, registered views, training settings and output counts. | Inspect a successful job and failed/retried job. Missing provenance is reported as unknown rather than inferred. |
| GS-18 | A published reconstruction shall be discoverable in the library and directly reopenable by model/version link. Navigation shall offer rotate, pan, zoom, reset, full-screen inspection and the existing fly-by controls. | Open a completed job through its library entry and direct link; exercise mouse and trackpad controls and full-screen operation. |
| GS-19 | Appearance and spatial validation shall have separate results. Unregistered captures start with unverified location/scale. Manual placement, GNSS/control fitting and independent checkpoints shall record units and coordinate/datum provenance. | A visually good model with no surveyed controls remains unverified. Checkpoints are excluded from fitting and reported separately. |
| GS-20 | Measurement, DSM/DTM, terrain profile and line-of-sight results shall identify the geometric source used. Gaussian opacity or apparent color alone shall not certify a surface or obstruction. Earth curvature and vertical-datum handling remain requirements of the existing geometric analysis pipeline. | With no suitable companion geometry, results cannot be represented as certified terrain/visibility derived from the splats. Validate geometry-based results against known terrain and occluders separately. |
| GS-21 | Operators shall be able to hide and remove a Gaussian model through the same authorized library lifecycle as other models. Removing a desktop reference shall leave the user's original file intact. | Verify reopen and deletion behavior with both local and server data, including authorization and version semantics. |
| GS-22 | Offline finished-model viewing shall use locally available dependencies. Reconstruction shall disclose missing executables, model assets or licenses before claiming readiness. Library storage may use configured server/network storage; it shall not embed credentials in model URLs or project metadata. | Reopen a stored SPZ offline; exercise unavailable source/cache and unavailable-worker paths with actionable errors. Target network-storage checks remain deployment acceptance. |
| GS-23 | Installer documentation shall distinguish ordinary viewing from reconstruction-worker installation, supported runtime/profile, required external tools, licensing and unverified target platforms. Independent map/data packages shall remain compatible and separate. | Follow each relevant installation guide on its target machine and record versions and evidence. |
| GS-24 | A presentation MP4, if requested, shall be a separately exported artifact with a declared camera path, dimensions, duration and frame rate. It shall not replace the interactive reconstruction or imply geometric validation. | Play the exported file independently of VIEWER and confirm duration, camera coverage and absence of blank frames. This revision does not claim an export from the user's capture has been delivered. |

## Quality and performance acceptance protocol

A job reaching “ready” means the asset was published; it does not mean it is visually acceptable. Before accepting a capture profile, record a representative input dataset, capture permissions, hardware, worker versions/settings, elapsed time, peak worker memory and viewer load/render measurements. Synthetic data and mocked fitting shall be labelled and cannot pass a real-training gate.

Review appearance along reproducible viewpoints inside the captured camera coverage: initial framing, multiple sides of the subject, close detail and a continuous orbit. Compare with source frames for blur, doubled edges, missing areas, floating Gaussians and unstable appearance. Record failures with model/version and screenshots. Novel viewpoints outside source coverage shall be identified. The current WhatsApp-video result fails this visual-quality review because it remains blurred; improving it requires reconstruction investigation and re-review, not only SPZ re-encoding.

For each target hardware class, record dataset size, viewport resolution, cold-load time, navigation frame-time distribution and peak browser/GPU memory. Test a normal sample, the direct-import limit and a representative tiled large scene. Set project-specific minimum frame rate, load-time budget and memory budget before production sign-off. No fixed minimum frame rate or completion time is established by this SRS without those measurements.

Spatial acceptance shall use independently measured checkpoints and a declared horizontal CRS and vertical datum. Agree horizontal/vertical error tolerances before fitting. Record control residuals and independent checkpoint errors separately. A DSM shall not be relabelled as a bare-earth DTM. Elevation comparisons require compatible units and vertical datums, documented no-data behavior and reproducible sampling.

## Verification and readiness matrix — 20 November 2026

| Capability / gate | Evidence | Current disposition |
|---|---|---|
| Direct SPZ v2/v3/v4 adapter, errors and source preservation (GS-11–16) | `tests/spz-import.test.ts`; full 214-test run under `artifacts/spz-import-qa/tests-final-release.log` | Automated checks passed on this Mac. Native desktop interactions still require target acceptance. |
| Real finished-model rendering (GS-15, GS-18) | Official Niantic horned-lizard, 786,233 splats, SH3; screenshots `real-spz-v2-render.png` and derived `real-spz-v4-render.png` | Visibly rendered in browser, approximately 30 fps in this session. Not a universal performance or native-v4-capture claim. |
| Container serving and SPZ v4 import | `artifacts/spz-import-qa/container-verification.log` | Container smoke passed, including isolated runtime and retained-source paths. Not native RHEL/Ubuntu GPU acceptance. |
| Existing real video reconstruction | Model `8fb7df41-3425-4520-9d17-31c4353e686d`, version 1; 127,377 splats; `existing-video-reconstruction.png` | Published and visibly rendered; visual quality unresolved because of blur/floaters. |
| Capture routing and worker contracts (GS-01–05) | Capture tests and earlier real ground-video runs described above | Integration exercised. Each deployed worker and representative capture must pass real-training and visual-quality gates. |
| Surface, GNSS and satellite adapters (GS-06, GS-08–10) | Synthetic controls/reference rasters/telemetry and fixture workers described in their sections | Software-path evidence only where simulated. Real field/satellite fitting and accuracy remain open. |
| Large-area hierarchy (GS-07) | Existing fitted PLY packaging and separation fixtures | Packaging exercised. Multi-flight fitting, seams, continuity and memory remain open. |
| Windows, Ubuntu, RHEL and L40S | Installable artifacts/guide work is separate from this SRS | Native installation, upgrade, worker/GPU, network storage and device acceptance must run on the user's target machines. |
| Presentation movie (GS-24) | No accepted MP4 of this video reconstruction recorded here | Separate export and playback acceptance required if commissioned. |

A release may claim only the capabilities whose gates have passed. Whole-system Gaussian reconstruction acceptance remains open while the real-video quality issue or required target-machine checks are unresolved. Specialist profiles remain conditional on their configured workers and separate licensing.

## Operational review of the current video result

On the development computer with VIEWER running, open:

`http://127.0.0.1:3001/?model=8fb7df41-3425-4520-9d17-31c4353e686d&version=1`

The same result appears in Model library as **WhatsApp Video 2026-11-20 at 07.05.29**. Drag in Rotate mode, wheel/pinch to zoom, or select Pan to move horizontally/vertically. This link opens an interactive scene; it is not a downloadable video. The `127.0.0.1` address works only on the development computer and requires its local service.

For a separate, sharp public-format reference, use **Gaussian splat — Niantic horned lizard**, model `93d6ef13-794d-4114-8e89-abb75e073043`. Its demonstration placement is arbitrary and its scale/location are not surveyed. Do not substitute that sample for acceptance of the user's video.

## Guided processing, export and usability — added 20 November 2026

These requirements incorporate the latest operator requests. Their inclusion in this specification does not mean that their implementation or acceptance is complete.

| ID | Requirement | Acceptance |
|---|---|---|
| GS-25 | Operators shall choose input family, desired output and processing methods from dropdown menus. Routine labels shall be short; technical explanations belong in expandable Help. Open, Run, Export and Delete remain action buttons. | A first-time operator can choose input, goal and method and find the result without reading implementation instructions. Review mouse, keyboard, trackpad, full-screen and small-screen layouts. |
| GS-26 | The system shall recommend a compatible method, explain its suitability briefly and list compatible alternatives. Recommendations shall consider goal, sensor/calibration needs, configured workers and detected processing hardware. | Recommendations are deterministic for tested inputs. An unavailable preferred method is labelled; the system does not claim an uninstalled method is runnable or silently substitute another explicitly selected method. |
| GS-27 | The operator shall be able to select several methods for the same capture. Each run shall retain its own method, quality setting, job/result identity and comparison group. | Queue the selected methods atomically and idempotently. Reject incompatible/unconfigured selections before creating jobs. Preserve identical input bytes and independent retry/results. |
| GS-28 | Results shall support A/B comparison and optional side-by-side viewing. The interface shall identify each result's method, quality and available geometry/accuracy metadata. | Switch between results and compare two completed runs. Closing or switching a result releases its scene resources. Do not infer survey accuracy or image quality from point count alone. |
| GS-29 | The system shall detect processing CPU, RAM, NVIDIA GPU identity and total/free VRAM, or Apple Metal availability. It shall adapt reconstruction frame count, resolution and supported training limits conservatively. Users may choose Fast, Balanced or High quality. | Validate unknown/absent GPU, low free VRAM, RTX A4000, RTX 4000 Ada and L40S on appropriate machines. A driver branch such as R530 shall not be treated as a GPU model. Browser/client rendering capacity and server training capacity shall remain distinct. |
| GS-30 | GPU capture training shall be serialized on a single device, including comparison batches. Decoder concurrency, export allocations and temporary storage shall be bounded. Unused GPU resources, decoder workers, analysis buffers and temporary URLs shall be released. | Exercise cancellation, repeated model changes, comparison close/reopen and export failure. Record steady-state and peak memory; demonstrate no continuing growth caused by retained application references. No deletion of original models or saved data is implied. |
| GS-31 | A dedicated export module shall cover the viewer's supported model formats: GLB, glTF, FBX, SPZ and 3D Tiles, with unchanged-source download when retained. It shall expose only valid conversions or explain why a target is unavailable. | Reopen exported examples, retain required dependencies, materials where supported, attribution/classification and placement metadata. Preserve complete tile hierarchies. Reject partial or unsupported conversions rather than publish a misleading file. |
| GS-32 | Gaussian 3D Tiles export shall retain the Gaussian glTF/compression extensions and embed the current placement once. Local-coordinate outputs shall include placement/provenance sidecars. Mesh conversion is a separate reconstruction step. GIS vector/raster exports shall preserve CRS/datum and source metadata; a WMTS connection alone shall not be represented as downloaded imagery. | Test a placed SPZ model and a native georeferenced tileset; verify source/geometry bytes where preservation is promised. A Gaussian-to-FBX request cannot invent a surface. Test GIS export separately from model export. |
| GS-33 | Component management shall record upstream URL, exact source revision, dependency/license requirements, installation state and local validation. Source downloaded, environment installed, worker configured and representative training passed shall be separate states. | Check all methods in the selection matrix. Missing SatSplat code or CUDA hardware is reported explicitly. Do not silently install incompatible GPU dependencies into the application's runtime. |
| GS-34 | Before release, run a skill-guided usability/completeness review and a source-grounded security/safety audit. Findings shall be fixed or recorded with their impact, evidence and remaining validation steps. | Trace every SRS requirement and accepted user request to implementation and evidence. Produce an audit report with scope and unresolved gaps. Native target-machine checks remain unverified until executed there. |

### Method selection matrix

| Input / goal | Preferred candidate | Alternatives and conditions |
|---|---|---|
| Ground/drone video or overlapping images → photorealistic scene | COLMAP + Splatfacto on a configured NVIDIA worker | COLMAP + Brush on Apple Silicon; OpenSplat CPU preview as a slower fallback. Choice depends on actual worker availability and hardware. |
| Drone/aerial imagery → surface mesh or elevation | 2D Gaussian Splatting | Requires a configured CUDA environment; verify extracted geometry against independent controls/reference elevations. |
| Many flights / large area → streaming scene | CityGaussianV2 | Hierarchical 3D Gaussians for view-dependent detail. Neither is accepted solely because a source checkout exists. |
| Calibrated satellite views → reconstruction/elevation | EOGS | SatSplat when its code and a validated adapter are available. Current official SatSplat code link returns 404. |
| Satellite imagery → immersive fly-through | Skyfall-GS | Generative detail must be labelled as synthesized and excluded from measured-geometry claims. Model-weight requirements and calibration must be checked. |

The recommendation is a compatible starting point, not a guarantee of the best reconstruction. Training and visual validation on the actual dataset are required. Low-memory presets may reduce detail. Exact operating limits and any fallback shall be visible in job provenance.

### Current status of these additions

Source code now contains the guided selectors, hardware capability probe, adaptive preview budgets, atomic multi-method queue, comparison dialog, export framework and decoder cleanup changes. They are **under development**, not release-accepted. The 214-test baseline passed after the initial integration work; dedicated regression and browser checks for the new additions remain necessary. The main running service has not yet been restarted with all these additions.

Six available upstream repositories and their submodules have been downloaded: Nerfstudio, 2DGS, CityGaussian, Hierarchical 3D Gaussians, EOGS and Skyfall-GS. This Mac cannot validate their NVIDIA CUDA training environments. SatSplat's project links to unavailable source. Specialist adapters, target installation/runtime validation, full export acceptance, the final audit and the rebuilt delivery remain unfinished. The user's current video reconstruction still has the quality limitation recorded above.

Primary method references: [Nerfstudio](https://docs.nerf.studio/quickstart/custom_dataset.html), [2DGS](https://github.com/hbb1/2d-gaussian-splatting), [CityGaussian](https://github.com/Linketic/CityGaussian), [Hierarchical 3D Gaussians](https://github.com/graphdeco-inria/hierarchical-3d-gaussians), [EOGS](https://github.com/mezzelfo/EOGS), [SatSplat project](https://gdaosu.github.io/satsplat/), [Skyfall-GS](https://github.com/jayin92/Skyfall-GS). Reviewed 20 November 2026.

## Change control

Preserve GS-01–10 when extending this specification. New requirements use GS-11–34. Format support changes shall update the compatibility contract, negative tests, worker/renderer expectations and manuals. Performance and survey tolerances become binding only when documented for the agreed dataset and target system. Attach test evidence and outstanding issues to release notes; do not turn an unexecuted acceptance step into a passed requirement.
