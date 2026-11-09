#!/usr/bin/env bash
# Downloads open sample data for the prototype into apps/web/public/samples.
# Run on an internet-connected machine; copy the folder through the approved
# transfer process for use on the internal network. Licences: docs/DATA_SOURCES.md
# LIGHT=1 fetches only the Khronos models and the CesiumGS tilesets (about 110 MB), which is
# what the browser checks in CI need.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/public/samples"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT/khronos" "$OUT/3dtiles"

echo "· Khronos glTF Sample Assets"
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/KhronosGroup/glTF-Sample-Assets "$TMP/khronos"
MODELS=(SciFiHelmet WaterBottle BoomBox Lantern Corset MetalRoughSpheres ABeautifulGame)
(cd "$TMP/khronos" && git sparse-checkout set $(printf 'Models/%s/glTF ' "${MODELS[@]}"))
for m in "${MODELS[@]}"; do
  npx -y @gltf-transform/cli@4.5.1 copy "$TMP/khronos/Models/$m/glTF/$m.gltf" "$OUT/khronos/$m.glb" >/dev/null
  echo "  $m.glb"
done

echo "· CesiumGS 3D Tiles samples"
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/CesiumGS/3d-tiles-samples "$TMP/tiles"
(cd "$TMP/tiles" && git sparse-checkout set 1.0/TilesetWithDiscreteLOD 1.0/TilesetWithRequestVolume)
cp -r "$TMP/tiles/1.0/TilesetWithDiscreteLOD" "$TMP/tiles/1.0/TilesetWithRequestVolume" "$OUT/3dtiles/"
rm -rf "$OUT"/3dtiles/*/screenshot

# One FBX for the desktop app's local conversion (WP 5.2): the scanned bunny from the three.js
# examples (MIT), 8 MB ASCII FBX 7.5, also used in the FBX bake-off (docs/spikes/FBX_BAKEOFF.md).
echo "· FBX sample"
mkdir -p "$OUT/fbx"
curl -sfL -o "$OUT/fbx/stanford-bunny.fbx" https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/fbx/stanford-bunny.fbx
if [[ "${LIGHT:-0}" == 1 ]]; then echo "Done (light): $OUT"; exit 0; fi
echo "Done: $OUT"

# Georeferenced real-world 3D Tiles from the iTowns sample data repository:
# Lyon 1st district textured buildings (Data Grand Lyon, Licence Ouverte 2.0) and
# IGN Lidar HD point cloud of the Tarn gorges (Licence Ouverte 2.0), ~490 MB.
ITOWNS="$TMP/itowns"
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/iTowns/iTowns2-sample-data "$ITOWNS"
(cd "$ITOWNS" && git sparse-checkout set 3DTiles/lyon_1_4978 3DTiles/lidar-hd-gorges-saint-chely-tarn)
mkdir -p "$OUT/3dtiles/lyon1" "$OUT/3dtiles/tarn-lidar"
cp -r "$ITOWNS/3DTiles/lyon_1_4978/." "$OUT/3dtiles/lyon1/"
cp -r "$ITOWNS/3DTiles/lidar-hd-gorges-saint-chely-tarn/." "$OUT/3dtiles/tarn-lidar/"
# Lyon comes as 128 blocks under one root; give it real LOD (simplified parent tiles).
LODTOOLS="$TMP/lod-tools"
mkdir -p "$LODTOOLS" && (cd "$LODTOOLS" && npm init -y >/dev/null && npm i -s @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 \
  @gltf-transform/functions@4.5.1 draco3dgltf@1.5.7 meshoptimizer@0.25.0 sharp@0.34.5 >/dev/null)
cp "$(dirname "$0")/build-lod-pyramid.mjs" "$LODTOOLS/"
node "$LODTOOLS/build-lod-pyramid.mjs" "$OUT/3dtiles/lyon1" "$OUT/3dtiles/lyon1" >/dev/null

# Lyon 2023 photomesh (Data Grand Lyon, Licence Ouverte 2.0): Fourvière and the north of
# Vieux Lyon, 16 blocks with the publisher's LOD, converted to glTF 2.0 + Draco.
PHOTOTOOLS="$TMP/photomesh-tools"
mkdir -p "$PHOTOTOOLS" && (cd "$PHOTOTOOLS" && npm init -y >/dev/null && npm pkg set overrides.cesium=1.120.0 >/dev/null && npm i -s gltf-pipeline@4.1.0 >/dev/null)
cp "$(dirname "$0")/fetch-lyon-photomesh.mjs" "$PHOTOTOOLS/"
node "$PHOTOTOOLS/fetch-lyon-photomesh.mjs" "$OUT/3dtiles/lyon-photomesh"
