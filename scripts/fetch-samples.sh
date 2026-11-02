#!/usr/bin/env bash
# Downloads open sample data for the prototype into apps/web/public/samples.
# Run on an internet-connected machine; copy the folder through the approved
# transfer process for use on the internal network. Licences: docs/DATA_SOURCES.md
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
