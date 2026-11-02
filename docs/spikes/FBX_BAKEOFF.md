# WP 0.4 FBX bake-off — first round (public files)

*2 Nov 2026. Script: [`scripts/spikes/fbx-bakeoff.mjs`](../../scripts/spikes/fbx-bakeoff.mjs). Gate G0 needs a second round on 10 real producer FBX files with textures.*

## What was tested

Four public FBX files from the three.js examples (MIT): two skinned and animated characters (binary FBX 7.x), a static scanned mesh (ASCII FBX 7.5) and NURBS curves (ASCII FBX 7.2). Each was converted to GLB by three candidates, then checked with the Khronos glTF Validator 2.0.0-dev.3.10.

| Candidate | Version | Licence | Where it can run |
|---|---|---|---|
| **FBX2glTF** (Meta/Godot fork binary) | 0.9.7 | BSD-3, but statically links the **Autodesk FBX SDK** | Server worker, desktop child process (Linux / Windows binaries) |
| **Assimp** via assimpjs (WebAssembly) | 0.0.10 (Assimp 5.x) | MIT / BSD-3 | Browser, Electron, server |
| **three.js FBXLoader + GLTFExporter** | r170 | MIT | Browser, Electron, server (Node needs a small `FileReader` shim) |

## Results

| File | Candidate | Time | GLB size | Validator errors | Triangles | Animations |
|---|---|---:|---:|---:|---:|---:|
| Samba Dancing (skinned, binary) | FBX2glTF | 2.3 s | 2.6 MB | **0** | 55 320 | 1 |
| | Assimp | 18.9 s | 12.6 MB | 191 | 55 320 | 1 |
| | three.js | 0.9 s | 9.7 MB | 3 | 55 320 | 2 |
| mixamo (skinned, binary) | FBX2glTF | 2.3 s | 2.2 MB | **0** | 49 112 | 1 |
| | Assimp | 8.6 s | 11.2 MB | 191 | 49 112 | 1 |
| | three.js | 0.7 s | 8.7 MB | 3 | 49 112 | 2 |
| stanford-bunny (static, ASCII) | FBX2glTF | 0.7 s | 0.75 MB | **0** | 30 338 | 0 |
| | Assimp | 3.5 s | 3.2 MB | **0** | 30 338 | 0 |
| | three.js | 0.3 s | 2.8 MB | **0** | 30 338 | 0 |
| nurbs (curves only, ASCII) | FBX2glTF | — | empty | 1 | 0 | 0 |
| | Assimp | — | empty | 1 | 0 | 0 |
| | three.js | — | 10 KB | **0** | 0 (5 curves as lines) | 0 |

Timings are on the cloud build machine (one core, no GPU); the A4000 workstation will be faster. Sizes are before the optimise step (meshopt + WebP) that every upload goes through anyway, so size differences mostly disappear after it.

## Findings

1. **FBX2glTF gives the cleanest output**: zero validator errors on every mesh file, correct skins and animation, smallest files. Its risk is the licence: the binary contains the Autodesk FBX SDK, whose EULA limits redistribution. Legal must confirm we may ship it inside the server image and the desktop installer (risk R-02).
2. **Assimp is not suitable as the main converter**: animated files produce 191 errors (non-increasing animation times), and it is 4–8× slower. Static meshes convert correctly.
3. **three.js is fast, MIT and runs anywhere**, including in the desktop app with no extra binary, and it is the only one that keeps NURBS curves (as lines). Its 3 errors come from the exporter writing an empty second animation and a skin root warning; both are fixable in our wrapper (drop empty clips, re-root skins). Texture handling still has to be proven on real producer files.

## Recommendation for G0 (to confirm in round 2)

- **Primary:** FBX2glTF, **if legal approves the FBX SDK licence**.
- **Fallback, and the desktop converter in any case:** three.js FBXLoader + GLTFExporter with our clean-up pass. No native binary, so it also removes a sandboxing concern in the EXE (WP 5.2).
- **Not chosen:** Assimp.
- **Still to test:** ufbx (MIT, C, known for broad FBX coverage) with a small glTF writer, and Blender headless (GPL; acceptable only as a separate server tool).

## Round 2 (needs the product owner)

Ten real producer FBX files, ideally including: embedded and external textures, multiple UV sets, very large scenes (≥ 1 GB), unit scale other than centimetres, Y-up and Z-up, instancing, and files exported from 3ds Max, Maya, SketchUp, Revit and Blender. For each we will compare materials, textures, hierarchy names (they become the layer tree), scale, orientation and conversion time, and fill the material mapping table v1.
