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

- **Primary:** FBX2glTF. **Chosen by the product owner on 2 Nov 2026**, accepting the Autodesk FBX SDK licence terms; the EULA goes to security review with the dependency list (WP 0.2).
- **Fallback, and the desktop converter in any case:** three.js FBXLoader + GLTFExporter with our clean-up pass. No native binary, so it also removes a sandboxing concern in the EXE (WP 5.2).
- **Not chosen:** Assimp.
- **Still to test:** ufbx (MIT, C, known for broad FBX coverage) with a small glTF writer, and Blender headless (GPL; acceptable only as a separate server tool).

## Round 2 (public files, 2 Nov 2026)

The product owner has no producer FBX files, so round 2 used 17 public files: 12 from the Assimp test suite (each file keeps the licence noted in that repository) and 5 from the three.js examples (MIT). Together they cover binary and ASCII FBX 6/7, hierarchies with and without names, unit and axis settings, Phong and 3ds Max PBR materials (metal/rough and spec/gloss), embedded textures, external textures that are missing, skinning and animation, a 30k-triangle scan, curves only, and one damaged file. The same script was used, with the Khronos validator.

| File | Feature | FBX2glTF | Assimp | three.js |
|---|---|---|---|---|
| box.FBX (ASCII, 600 KB) | embedded texture | **0 errors** | 0 errors | fails (texture) |
| box.fbx | simple | **0** | 0 | fails |
| cubes_with_names / cubes_nonames | hierarchy, names | **0** | 0 | 0 |
| close_to_identity_transforms | near-identity transforms | **0** | 0 | 0 |
| global_settings | unit scale, axes | **0** | 0 | 0 |
| phong_cube, vCube | Phong material | **0** | 0 | 0 |
| maxPbrMaterial_metalRough | 3ds Max PBR | **0** | 3 (out of range) | 2 (out of range) |
| maxPbrMaterial_specGloss | 3ds Max PBR | **0** | 4 | 2 |
| spider (1.4k tris) | external textures, missing | **0** (converts without the texture) | 4 (I/O error) | fails (texture) |
| huesitos | bones, animation | **0** | 194 (weights) | 0 |
| Samba Dancing (55k tris) | skin, animation | **0**, 2.7 s | 191, 15.7 s | 3 |
| mixamo (49k tris) | skin, animation | **0**, 2.2 s | 191, 8.9 s | 3 |
| stanford-bunny (30k tris, ASCII) | large mesh | **0**, 0.6 s | 0, 3.5 s | 0 |
| nurbs | curves only | 1 (empty) | 1 (empty) | 0 (curves as lines) |
| transparentTest | damaged header | fails | fails | fails |

**Result.** FBX2glTF converted 15 of 17 files with zero validator errors; the other two have no mesh or a damaged header, and every converter failed on those. Assimp produced errors on 6 files and three.js failed on 3 (textures in Node) with errors on 4 more. This confirms the choice of FBX2glTF.

**What the pipeline adds (WP 3.3, 3.4):** the upload check reads the texture names inside the FBX and lists missing ones before conversion (spider.fbx needs SpiderTex.jpg); a damaged FBX gets a named reason ("the FBX header is damaged"), not a converter log; NURBS-only files are rejected with "no meshes" (curves are out of scope).

Still worth a later run when real producer files exist: files of 1 GB and more, multiple UV sets, instancing, and exports from SketchUp and Revit.
