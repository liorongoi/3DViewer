# Sample conformance (WP 1.2)

Checked 4 Nov 2026 with `scripts/check-sample-conformance.cjs`. The script opens each sample in the built web app, through the viewer's own `engine.open`, on software rendering (SwiftShader). A sample passes when:

- the viewer reports no error and the page has none;
- no tile fails to load;
- the model draws something. The frame with the model must differ from the frame without it. A single-sided surface is also looked at from the other sides.

| Set | Files | Open | Refused, reason named | Fail |
|---|---|---|---|---|
| 3D Tiles samples | 26 | 26 | 0 | 0 |
| CesiumJS spec tilesets | 93 | 93 | 0 | 0 |
| Khronos glTF | 338 | 311 | 27 | 0 |

The sets are:

- **Khronos glTF.** Every variant listed in `Models/model-index.json` of KhronosGroup/glTF-Sample-Assets, for all 150 models: glTF with separate files, GLB, embedded, Draco, quantized, meshopt, KTX2/BasisU, WebP and JPG.
- **3D Tiles samples.** Every tileset in CesiumGS/3d-tiles-samples. These are 3D Tiles 1.0 and 1.1: implicit quadtree and octree, multiple contents, metadata, and glTF content with `EXT_mesh_features` and `EXT_structural_metadata`.
- **CesiumJS spec tilesets.** CesiumJS's `Specs/Data/Cesium3DTiles`, for the 1.0 formats the samples repository no longer has: b3dm, i3dm, pnts and cmpt, with and without batch tables, plus RTC, quantized, octahedral normals, Draco point clouds, styles and transforms. Its Vector, Geometry, GeoJson, Voxel, GaussianSplats and Terrain folders are CesiumJS experiments outside 3D Tiles 1.0/1.1, and are not checked.

Two samples open with nothing to draw. Both are counted as open:

- TilesetWithFullMetadata has metadata only, no content.
- TilesetReplacementWithViewerRequestVolume shows its content only from inside its request volume.

## Refused, with the reason named

These Khronos models list a glTF extension in `extensionsRequired` that CesiumJS 1.146 does not implement. The glTF specification says a loader must then refuse the file. The viewer does, with a message that names the extension, for example "This model needs the glTF extension KHR_lights_punctual, which VIEWER cannot read." The rest of the viewer keeps working.

| File | Why |
|---|---|
| AnimationPointerUVs (glTF) | Requires `KHR_lights_punctual` |
| AnimationPointerUVs (glTF-Binary) | Requires `KHR_lights_punctual` |
| ChronographWatch (glTF-KTX-BasisU) | Requires `KHR_materials_transmission` |
| ChronographWatch (glTF-WEBP) | Requires `KHR_materials_transmission` |
| CommercialRefrigerator (glTF) | Requires `KHR_materials_transmission` |
| CommercialRefrigerator (glTF-Binary) | Requires `KHR_materials_transmission` |
| CubeVisibility (glTF) | Requires `KHR_node_visibility` |
| CubeVisibility (glTF-Binary) | Requires `KHR_node_visibility` |
| DiffuseTransmissionTest (glTF) | Requires `KHR_lights_punctual` |
| DiffuseTransmissionTest (glTF-Binary) | Requires `KHR_lights_punctual` |
| DirectionalLight (glTF) | Requires `KHR_lights_punctual` |
| DirectionalLight (glTF-Binary) | Requires `KHR_lights_punctual` |
| IridescenceSuzanne (glTF-Binary) | Requires `KHR_materials_iridescence` |
| LightVisibility (glTF) | Requires `KHR_lights_punctual` |
| LightVisibility (glTF-Binary) | Requires `KHR_lights_punctual` |
| MorphStressTest (glTF) | More morph targets than the GPU can draw at once (Cesium fails to link the shader: too many vertex attributes) |
| MorphStressTest (glTF-Binary) | More morph targets than the GPU can draw at once (Cesium fails to link the shader: too many vertex attributes) |
| NodePerformanceTest (glTF) | Requires `KHR_lights_punctual` |
| NodePerformanceTest (glTF-Binary) | Requires `KHR_lights_punctual` |
| PlaysetLightTest (glTF) | Requires `KHR_lights_punctual` |
| PlaysetLightTest (glTF-Binary) | Requires `KHR_lights_punctual` |
| PotOfCoalsAnimationPointer (glTF) | Requires `KHR_materials_transmission` |
| PotOfCoalsAnimationPointer (glTF-Binary) | Requires `KHR_materials_transmission` |
| SheenTestGrid (glTF) | Requires `KHR_materials_sheen` |
| SheenTestGrid (glTF-Binary) | Requires `KHR_materials_sheen` |
| SpecularSilkPouf (glTF) | Requires `KHR_materials_sheen` |
| SpecularSilkPouf (glTF-Binary) | Requires `KHR_materials_sheen` |

That is 14 of the 150 models. For two of them, ChronographWatch and IridescenceSuzanne, the other variants do not require the extension and open. The other 136 models open in every variant.

## Found and fixed while checking

- **A b3dm or i3dm without a batch table froze all drawing whenever a custom shader was on it.** This covers the ground-cut capture and the unlit view. CesiumJS read the class of a property table that has none. It is fixed by a patch to `@cesium/engine` (`patches/`, applied by pnpm).
- **Opening a tileset could freeze all drawing ("This object was destroyed").** Cesium's dynamic sky reflections can queue the same compute command twice in a frame. The second copy ran after the first had freed the shared buffers. This is fixed in the same patch: a command that has run, or was canceled, is skipped. The ground-cut capture made it likely, because it renders several frames at once, but any tileset could hit it.
- **Tiles that fail to load are now reported.** The model stays open, and a notice names the tiles and says why. Before, nothing was shown.
- **A model that makes drawing fail is now closed with a message, and the view keeps drawing.** Before, Cesium stopped all drawing and showed its own technical panel. MorphStressTest is one such model.
- **Load-error reasons were fixed.**
  - A missing extension is now named.
  - A file whose address contains ".glb" is no longer always called "not a valid GLB".
  - ".json" in an address no longer reads as a JSON error.

`scripts/check-load-errors.cjs` checks the last three, in English and Hebrew.

## Running it

```
KHRONOS=<glTF-Sample-Assets checkout> TILES=<3d-tiles-samples checkout> SPECS=<cesium>/Specs/Data \
  node scripts/check-sample-conformance.cjs <out folder>
```

Build the web app and start `vite preview` on :4173 first. `LIMIT_S=300` gives heavy models more time on software rendering. The out folder gets a screenshot of every sample, `results.json` and `results.md`.
