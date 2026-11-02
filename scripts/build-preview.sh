#!/usr/bin/env bash
# Builds a shareable preview of the prototype into apps/web/dist-preview:
# the normal build, without unused Cesium widget files, and with sample models
# re-encoded (meshopt geometry, WebP textures ≤ 2048 px) so each stays small.
# The full-resolution originals in public/samples are what the AC-03 check uses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/apps/web"
OUT="$WEB/dist-preview"
(cd "$WEB" && npx vite build --outDir "$OUT" --emptyOutDir >/dev/null)
rm -rf "$OUT/cesium/Widgets" "$OUT/cesium/Assets/Textures/maki"
for f in "$OUT"/samples/khronos/*.glb; do
  npx -y @gltf-transform/cli@4.5.1 optimize "$f" "$f.tmp.glb" \
    --compress meshopt --texture-compress webp --texture-size 2048 >/dev/null
  mv "$f.tmp.glb" "$f"
done
echo "files: $(find "$OUT" -type f | wc -l)  size: $(du -sh "$OUT" | cut -f1)"
find "$OUT" -type f -size +14M -exec ls -lh {} \;
