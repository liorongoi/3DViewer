# Gaussian splats in HOLO

Gaussian splats are a way to show a real place as millions of small, soft, coloured blobs. They look photographic from every side. They are not a measured surface.

This document describes how HOLO adds splats, using the Geo Splatian Viewer Integration SRS rev 1.2 as its input. That SRS was drafted for another codebase; it is kept as received in [spikes/GAUSSIAN_SPLATS_SRS_1.2.md](spikes/GAUSSIAN_SPLATS_SRS_1.2.md). This document covers:

- what HOLO does;
- the decisions taken where the SRS did not fit HOLO;
- the methods chosen and why;
- the worker contract;
- every requirement, GS-01 to GS-34, with its honest status;
- the safety audit.

No acceptance gate is marked passed here without evidence. "Built" means the code is there and covered by the tests named. A gate that needs a real GPU, real field data or a target machine stays **open** until it is run there.

## What the operator can do

1. **Open a finished splat model.** Choose an `.spz` file (SPZ version 2 or 3) or a splat `.ply` file through Upload. HOLO accepts PLY files written by training programs and the compressed PLY that SuperSplat and PlayCanvas write. HOLO checks every splat before anything is published. The file is kept byte for byte under `original/`, and the model is drawn as 3D Tiles through Cesium's `KHR_gaussian_splatting` support.
   - The view frames the model on the 1st to 99th percentile of its splats. Stray splats far from the scene ("floaters", which training often leaves behind) therefore do not shrink the view. Nothing is deleted.
2. **Say how big it really is.** Splat files almost never carry metres. The Place step asks one question, "How big is it really?", with these answers:
   - *I know one real measurement.* Choose width, depth or height, type its length in metres, and the whole model is scaled evenly.
   - *I don't know: keep it floating.* The model is drawn in its own units, measurements read as model units, and downloads keep it unscaled with no position. This is the default for splats.
   - *Its units are right.* This answer is offered for meshes only.

   The same choice is in **Properties → Gaussian splats** after publishing. On the server, a change of size adds a version with the same files and the new scale. The earlier version is never changed.
3. **Make a splat from a capture.** The **Make a splat** wizard (the sparkle button beside Upload, or the command palette) asks four short questions:
   - what you have: a video, photos or satellite images;
   - what you want: a place to look around, surfaces to measure, a large area, or terrain from orbit;
   - how: the method recommended for *this server's hardware* is already chosen, with the reason. The other methods are in a dropdown, each with a short "About" note. Quality is Fast, Balanced or High. You can tick up to two more methods to compare.
   - a name and a classification.

   The server trains and the window shows each method's progress. The window can be closed meanwhile. When several methods were chosen, each result becomes a version of the same model, and the version picker switches between them from the same viewpoint.
4. **Download.** Properties of a splat model offers three downloads:
   - the original file, as uploaded;
   - SPZ: scaled to the real size, with `holo-placement.json` when the model has one;
   - 3D Tiles as a zip: placed on the globe (root transform) when the model has a real size, or in its own frame when it is floating.

   The Measurements and Analysis panels say, while a splat model is open, that splats are not a measured surface.

## Decisions where the SRS did not fit HOLO

| SRS says | HOLO does | Why |
|---|---|---|
| Direct import capped at 2,000,000 splats and 160 MiB (GS-12) | Up to 10,000,000 splats. The decompressed size is computed from the gzip trailer and checked before inflating. Clouds over 1,000,000 splats are split into level-of-detail tiles. | HOLO tiles large clouds, so one tile never holds more than 300,000 splats. Memory is bounded per tile, not per file. |
| SPZ v4 (NGSP/Zstandard) converted (GS-12, GS-14) | v4 is recognised from its header and **refused** with the reason. | No Zstandard decoder is bundled. Refusing is the explicit, safe answer that GS-13 asks for. |
| A built-in worker: COLMAP + Splatfacto (GS-03), and per-tool `VIEWER_*_COMMAND` variables | One worker contract for every method. `SPLAT_WORKERS=method=/path,…` names the installed programs. HOLO itself does the SPZ v2 packaging and tiling. | One contract to secure and test. The training code stays outside HOLO under its own licence. |
| Splatfacto as the NVIDIA default | **gsplat** (the library under Splatfacto) with the MCMC strategy | Same code family, Apache-2.0, and MCMC caps the splat count so memory cannot run out. |
| 2DGS reference code for surfaces (GS-06) | **gsplat's 2DGS mode** | The reference 2DGS code is derived from INRIA's code and needs the licensor's consent for commercial use. gsplat's 2DGS is Apache-2.0. |
| EOGS for satellite (GS-09) | **EOGS++** | EOGS++ is the authors' successor: it is faster, reports 1.19 m MAE on its benchmark, and has code available. SatSplat still has no public code. |
| A comparison dialog (GS-28) | Results are versions of one model, compared with the version picker | It reuses the existing version lifecycle, links and audit. A side-by-side view is still open. |

## Methods, and why these

Researched 20 November 2026. These are the best methods that can be installed today; where the SRS's choice was already the best, it is kept.

| Goal | Recommended | Alternatives | Notes and sources |
|---|---|---|---|
| A place to look around, NVIDIA GPU | gsplat (MCMC) | Brush; OpenSplat | Apache-2.0. [gsplat](https://github.com/nerfstudio-project/gsplat). Camera poses from COLMAP or GLOMAP ([GLOMAP](https://github.com/colmap/glomap) is much faster on large sets). |
| A place to look around, Apple silicon or AMD | Brush | OpenSplat | Apache-2.0, WebGPU, runs on Metal. [Brush](https://github.com/ArthurBrussee/brush) |
| A place to look around, no GPU | OpenSplat | — | AGPL-3.0, slow; Fast is chosen automatically. [OpenSplat](https://github.com/pierotofy/OpenSplat) |
| Surfaces to measure | gsplat 2DGS | CityGaussianV2 (research licence) | PGSR and the original 2DGS are INRIA-derived (non-commercial). |
| A large area | gsplat (MCMC), splat count capped by memory | CityGaussianV2 (24 GB NVIDIA, research licence) | Also considered: Octree-GS, Hierarchical 3DGS (INRIA, non-commercial), "A LoD of Gaussians". HOLO's own tiler gives the level of detail when viewing. |
| Terrain from satellite images | EOGS++ | Skyfall-GS (labelled **generative**) | [EOGS++](https://gardiens.github.io/EOGS2/). Skyfall-GS invents the sides no satellite saw, so its models carry a "Partly generated" warning. |
| Camera poses without COLMAP | (not yet wired) | VGGT-X, LongSplat | Promising for long videos and few views; a candidate for a later worker. |

INRIA's original 3DGS code is non-commercial, so no method here depends on it unless it is marked "research". Every method marked "research" shows "Research licence: check it before commercial use" in the wizard and on its result.

## Hardware

The server reads its own hardware when someone opens the wizard. It looks at the CPU, the RAM, and for each NVIDIA GPU the name, total and free memory and the driver version (`nvidia-smi`). On a Mac it looks for Apple silicon, and counts three quarters of unified memory as GPU memory. It reads this at most once a minute and changes nothing. The driver version is kept apart from the GPU name, so a driver branch such as R530 is never taken for a GPU model (test: `reconstruct.test.ts`).

The recommendation is deterministic: the same input, goal, hardware and installed workers always give the same method and preset (`splat-methods.test.ts`).

Presets are fitted to the memory that is free:

- the most splats is about 250,000 per GB of free GPU memory (60,000 per GB of a quarter of RAM on a CPU);
- images are limited to 1280 px under 8 GB;
- a CPU-only server gets Fast;
- one CPU thread is always left free.

One training runs at a time per server, so jobs never share a GPU.

The development machine for this work is a 4-core Xeon with 16 GB and no GPU. HOLO therefore recommended OpenSplat on Fast there, and said why. The operator's own machines were not probed from here: the server reads the hardware wherever it is installed.

## Worker contract

A worker is any program. HOLO starts it without a shell, with these discrete arguments:

```
--method <id> --input <dir> --input-kind video|photos|satellite --goal <goal> --output <dir>
--preset fast|balanced|high --iterations N --max-splats N --resolution N --sh-degree N
--video-fps N --threads N
```

It runs with:

- the environment cut down to `PATH`, `HOME` (the work folder), `LANG` and `CUDA_VISIBLE_DEVICES`;
- a time limit (`SPLAT_TIMEOUT_HOURS`, 12 by default): it receives SIGTERM, then SIGKILL 10 s later.

What the worker does:

- It prints `progress <0..1> <stage>` lines on stdout.
- It writes exactly one of `output/splats.ply` or `output/splats.spz`.
- It may write `output/provenance.json` with `{ tool, version, poses, frames, registeredViews, fixture, georefNote }`. Anything it leaves out is recorded as unknown, never guessed.
- It may write `output/georef.json` when it placed the splats from measured camera positions: `{ source, origin: {lat, lon, height}, horizontalCrs, verticalDatum, metresPerModelUnit, controls: {count, horizontalRms, verticalRms, max}, checks: {...} | null }`. The splats are then in metres east, north and up of `origin`. HOLO places the model there and shows the control and check residuals in the report; anything out of range means the model stays floating.
- `--check --method <id>` prints one JSON line `{ ok, tool, version, revision, problems, fixture }` and exits. HOLO asks at most every ten minutes and shows the answer under "Set up" in Make a splat.

A training can be stopped from Make a splat. HOLO marks the job cancelled, sends the worker SIGTERM (SIGKILL 10 s later), publishes nothing from it and removes its folders.

How HOLO reads the exit code:

- 0: success.
- 2: the capture cannot be used. The job is not retried and the worker's last lines are shown.
- Anything else: retried once.

HOLO then puts the splats through a normal ingest: checked, scanned, tiled and published. The capture is virus-scanned before the worker reads it (when `CLAMDSCAN` is set). The capture's uploaded bytes and work folders are removed when every method has finished.

`apps/server/test-fixtures/splat-worker-fixture.mjs` is a **test fixture**, not a reconstruction. It writes a small box of splats and says `fixture: true`. Everything it makes is labelled "TEST FIXTURE, not a real reconstruction" in the version note, and carries a warning at the top of the check report.

## Installing a method

HOLO installs nothing: GPU libraries stay out of the application. `workers/holo-splat-worker.mjs` is one worker program for every ground-capture method (Node only, no packages). It takes frames from a video by how far the view has moved, not on a fixed clock (a frame each time the image has shifted 3% of its width, `frameStep` in holo-worker.json, and at least `--video-fps` a second; of the frames around each point the sharpest), so a car at 40 km/h gets nearly every frame and a slow walk a few a second, recovers camera poses with COLMAP, GLOMAP or pycolmap (`workers/sfm_pycolmap.py`), places the result when the capture carries camera positions, and runs the method's trainer.

1. Install the trainer of each method you want (gsplat with PyTorch and CUDA, Brush, OpenSplat), ffmpeg, and COLMAP (with GLOMAP, or pycolmap in the same Python).
2. Copy `workers/holo-worker.example.json` to `workers/holo-worker.json` and set the paths of this machine. EOGS++ has no fixed command: set its `train` (and `check`) from the release you install.
3. Point HOLO at the worker, one entry per method: `SPLAT_WORKERS=gsplat=/opt/viewer/workers/holo-splat-worker.mjs,brush=/opt/viewer/workers/holo-splat-worker.mjs`.
4. Open Make a splat, then "Set up". Each method shows four states, each from its own evidence: **source** (the revision the worker reports), **environment** (its own check passed), **configured** (named in `SPLAT_WORKERS`) and **trained** (a training with it finished on this server; test-fixture runs are labelled). A method whose check fails cannot be chosen, and the problems it reported are shown.

Camera positions it uses, in this order: GPS in the photos' EXIF, a drone `.SRT` beside the video, or `camera-gnss.csv` (`time,lat,lon,height` in seconds from the start of the video). Every fifth camera is held back and reported as an independent check. Heights are ellipsoidal (WGS 84) as the camera reports them; ground control points measured on the ground are not used yet.

Satellite captures are checked before training (`apps/server/src/satellite.ts`): every image needs an RPC model (`.RPB`, `_RPC.TXT` or inside the TIFF), at least two views are needed, and when the metadata gives the view angles they must be at least 5° apart. A satellite video alone is refused: its frames are needed as images, each with its RPC.

## Traceability, GS-01 to GS-34

Status: **Built** (code and tests named), **Partly** (what is missing is named), **Open** (not built), **Gate open** (built, but acceptance needs a run HOLO cannot do here).

| ID | Status | What HOLO has | Evidence | Still open |
|---|---|---|---|---|
| GS-01 | Partly | Make a splat accepts video (MP4, MOV, M4V, LRV, TS, MTS, AVI, MKV, WEBM), images (JPG, PNG, TIFF, HEIC, WEBP, DNG), sidecars and ZIP; a dropped folder is read with its files. Uses the existing resumable (tus) upload. | `reconstruct.test.ts` (zip of photos, refused file types); `scripts/check-capture.cjs` | A folder button in the wizard (drop works); folder vs ZIP equivalence test |
| GS-02 | Built | Input family and goal are chosen in the wizard, checked against each method and stored with the capture and in each result's provenance. | `reconstruct.test.ts` (goal mismatch refused) | — |
| GS-03 | Gate open | `workers/holo-splat-worker.mjs` wraps gsplat, gsplat 2DGS, Brush and OpenSplat with COLMAP, GLOMAP or pycolmap; HOLO packages the splats as SPZ v2 in 3D Tiles and Cesium opens them. | `splat-worker.test.ts`; fixture worker end to end in tests and in the browser; a 128 s 1080p phone video posed 159 of 256 frames with pycolmap (training not run: no GPU here) | A real CUDA training run on a target machine |
| GS-04 | Partly | A result opens floating where the map is: model units, scale unverified. A real size can be set afterwards. | `check-capture.cjs` (floating, then 5 m width → scale 5.000) | A worker-supplied georeference overriding the preview placement |
| GS-05 | Built | Same upload, quota, progress, retry and failure path; discrete arguments; failures publish nothing; the capture is scanned before a worker reads it. | `reconstruct.test.ts` (runner without a shell, timeout, exit 2 not retried) | A manual "try again" that reuses the upload |
| GS-06 | Partly | gsplat 2DGS is chosen for surfaces. Properties of a splat model compare its heights with a GeoTIFF DSM or DTM (EPSG code required): mean, RMS, RMS after a vertical shift, 95th percentile and maximum, per raster cell, with floaters left out. | `elevation.test.ts`; `check-capture.cjs` (synthetic DSM) | A 2DGS run on real data against a checked DSM |
| GS-07 | Partly | HOLO tiles large clouds into level-of-detail 3D Tiles (median splits, replace refinement, every splat kept in the leaves). CityGaussianV2 is listed. | `splat.test.ts` (tiling keeps every splat) | A multi-flight run; seams; memory budget |
| GS-08 | Partly | The worker fits the reconstruction to camera GNSS (EXIF, SRT or CSV) with a similarity transform, holds every fifth camera back as a check, trains in local ENU metres and writes `georef.json`; HOLO places the model and reports CRS, datum and residuals. | `splat-worker.test.ts`; `reconstruct.test.ts` (georef placement) | Ground control points measured on the ground; a real drone flight |
| GS-09 | Partly | EOGS++ is listed; satellite captures are checked before training for an RPC model per image, two views or more, and view angles at least 5° apart; the result is recorded in provenance. | `satellite.test.ts`; `reconstruct.test.ts` | EOGS++ command on a real install; placing satellite output on the globe |
| GS-10 | Partly | A satellite video without per-frame RPCs is refused with what to send instead; a video next to RPC images is ignored and said so. | `satellite.test.ts` | Satellite video frames with RPCs on real data |
| GS-11 | Built | `.spz` and splat `.ply` upload in the browser, through the server and in the desktop open dialog; the original is kept byte for byte; local files are read, never changed. | `ingest.test.ts` (original byte for byte); `check-splats.cjs` | Reopen after a desktop restart on the target machine |
| GS-12 | Built (adapted) | v2/v3 read; v4 recognised and refused; corrupt header, cut short, bytes after the splats, too many splats and gzip bombs refused before publishing. | `splat.test.ts` | v4 decoding (needs Zstandard) |
| GS-13 | Built | v1 and SH degree 4 refused; PLY converted from the trainer's frame (COLMAP) to glTF consistently. | `splat.test.ts` (orientation by covariance) | — |
| GS-14 | Built | An SPZ v2 is drawn from the uploaded bytes unchanged; v3 is converted, and its reduced rotation precision is shown in the report. | `splat.test.ts` (v2 bytes identical, v3 rotations) | — |
| GS-15 | Built | The viewer keeps drawing until the splat sort has landed; framing ignores floaters without deleting them. | `check-splats.cjs` (synthetic box with floaters 500 units away; real guitar and biker samples looked at) | Frame rate on target hardware |
| GS-16 | Built | Original kept, quota checked before upload, derived tiles beside it, paths contained, a failed check publishes nothing. | `ingest.test.ts` (damaged SPZ publishes nothing) | — |
| GS-17 | Built | Each capture keeps input, goal, methods and preset; each result's provenance keeps method, licence, settings, hardware, and (when the worker says) tool, version, poses, frames and registered views; each method's error is shown. | `reconstruct.test.ts`; `/api/captures/:id` | — |
| GS-18 | Built | Results are ordinary library models with versions and links; all existing navigation and fly-by apply. | `check-capture.cjs` | — |
| GS-19 | Partly | Floating models measure in model units; a set size is recorded in the version note. | `check-capture.cjs` | Marking a hand-set scale as "unverified"; checkpoints |
| GS-20 | Partly | Measurements and Analysis show that splats are not a measured surface. | Browser (note shown for splat models) | Naming the geometric source on each result |
| GS-21 | Built (existing) | Splat models use the same library lifecycle (status, versions, admin delete). | Existing library tests | A splat-specific delete test |
| GS-22 | Partly | The splat decoder ships inside the app (no network); methods without a worker are labelled "Not installed on this server" and cannot be chosen; no credentials in URLs. | Wizard screenshot | Offline reopen test on the desktop build |
| GS-23 | Built | `SPLAT_WORKERS` and `SPLAT_TIMEOUT_HOURS` in `docs/OPERATIONS.md` and `deploy/viewer.env.example`; "Installing a method" above; `workers/holo-worker.example.json`. | — | Per-platform install notes once run on the target machines |
| GS-24 | Built | Properties, "Make a presentation video": one turn around the model as an MP4 (H.264, or VP9 where no H.264 encoder), 720p or 1080p, 4 to 20 s at 30 fps, each frame drawn only when the view is complete and refused when blank, with a "not a measurement" caption; the camera path can be saved as JSON. | `check-capture.cjs` (ffprobe size, frame count, no blank frames) | — |
| GS-25 | Built | Cards for input and goal, a method dropdown with short labels, an "About" note for each, Fast/Balanced/High. | `check-capture.cjs` screenshots | Small-screen review |
| GS-26 | Built | Deterministic recommendation by input, goal, hardware and installed workers, with reasons; an uninstalled better method is named, never claimed runnable. | `splat-methods.test.ts` (8 cases) | — |
| GS-27 | Built | Up to three methods per capture, queued in one transaction; incompatible or uninstalled ones refused before any byte is sent; each result has its own method, preset, job and version. A rerun of a method that already handed over only tidies up. | `reconstruct.test.ts` | — |
| GS-28 | Built | Side by side: a splat model is compared with another version through a draggable divider, both from the same viewpoint, labelled with method and version. | `check-capture.cjs` (screenshot) | — |
| GS-29 | Built (gate open) | CPU, RAM, NVIDIA name, total and free memory and driver, Apple silicon; presets fitted to free memory. | `reconstruct.test.ts`, `splat-methods.test.ts` | RTX A4000, RTX 4000 Ada and L40S on real machines |
| GS-30 | Built | One training at a time per server; a training can be stopped (SIGTERM, then SIGKILL), publishes nothing, and its folders are removed. | `reconstruct.test.ts` (cancel) | Memory measurements on target machines |
| GS-31 | Built | Splats: original, SPZ, standard PLY (the format trainers write; read by SuperSplat, Blender add-ons and game engines), 3D Tiles zip. Meshes and tilesets: original, GLB and glTF zips with `holo-model.json`, 3D Tiles (a placed GLB in a one-tile tileset; a tileset copied whole or refused). FBX only when the original was FBX: HOLO does not write FBX. | `export-models.test.ts`; `ply-write.test.ts` (PLY reads back as the same splats); `check-capture.cjs` downloads | — |
| GS-32 | Built | The 3D Tiles zip keeps the tiles as published (Gaussian extensions intact); a placed model has its placement in the root transform once, plus `holo-placement.json`; a floating model has none. No mesh is invented from splats. | `splat.test.ts` (3D Tiles download) | — |
| GS-33 | Built | Each method records its upstream URL and licence; "Set up" shows source revision, environment check, configured and trained as four separate states. | `reconstruct.test.ts` (install states, broken worker) | — |
| GS-34 | Built | This table, the browser walkthroughs and the audit below. | This document | Native target-machine checks |

## Safety audit (20 November 2026)

**Scope.** Every change on this branch:

- the server's capture, worker and download routes;
- the SPZ and PLY readers;
- the 3D Tiles packaging and download;
- the web wizard and panels;
- the settings.

**Method.**

- A source review of the branch diff, following the security-review skill: command and argument injection, path traversal, SQL, authorisation, unsafe rendering and data exposure.
- The repository's own checks: tests, typecheck, and the interface-string check.

**Findings: none exploitable.** Checked specifically:

- **Workers.** Workers start with no shell. Every value a client sends is checked against a fixed list: input, goal, method and preset. Every other argument is a number or a path the server makes.
- **SQL.** All queries are parameterised. A client cannot set the fields that join a result to a model (`parentIngest`, `method`, `provenance`), because the upload schema forbids extra properties.
- **Uploads.** Unpacking uses the existing zip guards and `Storage.inside`. The new "originals" listing goes through the same check and lists only files `/files/` already serves.
- **Parsers.** The SPZ and PLY readers are bounds-checked typed-array code. Gzip size is checked before inflating.

**Hardening done during the audit.**

1. Captures are virus-scanned before a worker opens them. Before this, only the worker's output was scanned.
2. The 3D Tiles download renames any tile whose decoded name is not a plain relative path, so a zip can never hold `../` entries.

**Remaining risks, recorded.**

- Workers run as the server's user with a minimal environment, but outside the Podman sandbox that conversion steps use, and they have network access. Run them in a container with no network once the real workers exist.
- Methods marked "research" need a licence check before commercial use. The app says so; it cannot check the licence for you.
- Large PLY files are converted to SPZ for download in the browser, on the main thread: a big file pauses the page while it is prepared.

**Data.**

- No existing model, file or row is changed by this work.
- Migration 006 only widens the allowed source formats (`spz`, `ply`).
- Setting a size adds a version and leaves earlier ones as they were.
- Uploads are kept byte for byte.

## Checks to run again

- `npx vitest run` in `packages/core`, `packages/shared` and `apps/server` , and `npx tsc --noEmit -p .` in each package and in `apps/web`.
- `node scripts/check-splats.cjs` (a splat file through upload, size and framing) and `node scripts/check-capture.cjs` (Make a splat with the fixture worker, a real size, the downloads, set-up states, the DSM check, the MP4 and side by side), in a real browser. How to start each is at the top of the script.

## What is still open

- No real GPU training has run yet: this environment has no GPU. The worker was run on a real 1080p phone video up to the poses (159 of 256 frames posed with pycolmap); the trainer step needs a CUDA machine or Brush on a Mac.
- EOGS++ needs its training command set from the release installed.
- Satellite results open floating; placing them on the globe from the RPCs is not done.
- Placement uses camera GNSS only; ground control points measured on the ground are not used yet.
- Checks on the target machines (RTX A4000, RTX 4000 Ada, L40S, Apple silicon) are run by the owner on those machines, not tracked here.
