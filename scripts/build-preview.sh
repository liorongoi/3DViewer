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

# ARTIFACT=1: the claude.ai artifact host serves only web media types, so give binary
# model files a served extension (.wasm) and point the bundle and tilesets at them.
# Cesium detects glTF, b3dm and pnts by their magic bytes, not by extension.
if [ "${ARTIFACT:-0}" = "1" ]; then
  find "$OUT/samples" -type f \( -name '*.glb' -o -name '*.b3dm' -o -name '*.pnts' \) -exec mv {} {}.wasm \;
  find "$OUT/samples" -name 'tileset.json' -exec sed -i -E 's/\.(b3dm|pnts)"/.\1.wasm"/g' {} \;
  sed -i -E 's#(/khronos/[A-Za-z]+\.glb)#\1.wasm#g' "$OUT"/assets/index-*.js
  rm -f "$OUT"/samples/3dtiles/*/README.md
  # The artifact host adds its own document skeleton, so the page is the head and body content only.
  JS=$(cd "$OUT" && ls assets/index-*.js); CSS=$(cd "$OUT" && ls assets/index-*.css)
  cat > "$OUT/page.html" <<HTML
<title>VIEWER Prototype</title>
<style>:root{color-scheme:dark;background:#0E0F12}body{background:#0E0F12;color:#E8EAED;margin:0}</style>
<script type="module" crossorigin src="./$JS"></script>
<link rel="stylesheet" crossorigin href="./$CSS">
<div id="root"></div>
HTML
  echo "artifact mode: renamed binary samples to .wasm"
fi
