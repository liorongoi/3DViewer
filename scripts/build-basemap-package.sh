#!/usr/bin/env bash
# RND-11: a base map package for a site with no internet, from tile folders made by the usual
# tools (gdal2tiles for imagery, Cesium terrain builder or a Terrarium writer for terrain).
# The site installs it with viewer-basemap-install (docs/INSTALL.md).
#
#   bash scripts/build-basemap-package.sh --name israel --version 2026.1 \
#        --imagery /data/ortho-xyz [--imagery-type xyz|tms] [--imagery-label "Orthophoto 2026"] \
#        --terrain /data/dem-qm [--terrain-type quantized-mesh|terrarium] [--terrain-label "DEM 2 m"] \
#        [--attribution "Survey of Israel"] [--out out]
#   -> out/israel-2026.1.basemap.tar (+ .sha256)
#
# Imagery: xyz is a {z}/{x}/{y}.<png|jpg|webp> folder in Web Mercator (gdal2tiles --xyz); tms is a
# folder with tilemapresource.xml (gdal2tiles' default). Terrain: quantized-mesh is a folder with
# layer.json and {z}/{x}/{y}.terrain (Cesium terrain builder; tiles are gzipped here if they are
# not already); terrarium is a {z}/{x}/{y}.png folder of Terrarium heights. At least one of the
# two. The package is a plain tar (tiles are already compressed) of <name>/ with basemap.json,
# SHA256SUMS and the tiles under imagery/ and terrain/.
set -euo pipefail
NAME="" VERSION="" IMG="" IMG_TYPE=xyz IMG_LABEL="" TER="" TER_TYPE=quantized-mesh TER_LABEL="" ATTR="" OUT=out

fail() { echo "build-basemap-package: $*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --imagery) IMG="$2"; shift 2 ;;
    --imagery-type) IMG_TYPE="$2"; shift 2 ;;
    --imagery-label) IMG_LABEL="$2"; shift 2 ;;
    --terrain) TER="$2"; shift 2 ;;
    --terrain-type) TER_TYPE="$2"; shift 2 ;;
    --terrain-label) TER_LABEL="$2"; shift 2 ;;
    --attribution) ATTR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fail "--name: lower-case letters, digits and -, up to 41 characters"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || fail "--version: letters, digits, . _ -"
[[ -n "$IMG" || -n "$TER" ]] || fail "give --imagery, --terrain or both"
[[ "$IMG_TYPE" == xyz || "$IMG_TYPE" == tms ]] || fail "--imagery-type is xyz or tms"
[[ "$TER_TYPE" == quantized-mesh || "$TER_TYPE" == terrarium ]] || fail "--terrain-type is quantized-mesh or terrarium"
command -v node >/dev/null || fail "node is needed"

# The highest zoom level: the largest number among the folder's sub-folders.
max_zoom() { find "$1" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]+' -printf '%f\n' | sort -n | tail -1; }

STAGE="$OUT/.basemap-$NAME"
PKG="$STAGE/$NAME"
rm -rf "$STAGE"
mkdir -p "$PKG"
sources=()

if [[ -n "$IMG" ]]; then
  [[ -d "$IMG" ]] || fail "--imagery $IMG is not a folder"
  echo "· imagery ($IMG_TYPE) from $IMG"
  cp -r --no-preserve=mode,ownership "$IMG" "$PKG/imagery"
  find "$PKG/imagery" \( -name '*.html' -o -name '*.kml' -o -name '*.aux.xml' \) -delete
  z="$(max_zoom "$PKG/imagery")"
  [[ -n "$z" ]] || fail "--imagery has no zoom level folders (0, 1, 2 ...)"
  if [[ "$IMG_TYPE" == tms ]]; then
    [[ -f "$PKG/imagery/tilemapresource.xml" ]] || fail "--imagery-type tms needs tilemapresource.xml (gdal2tiles writes it)"
    url="basemaps/$NAME/imagery"
  else
    ext="$(find "$PKG/imagery/$z" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) -print -quit | sed 's/.*\.//')"
    [[ -n "$ext" ]] || fail "--imagery has no png, jpg or webp tiles"
    url="basemaps/$NAME/imagery/{z}/{x}/{y}.$ext"
  fi
  sources+=("$(node -e 'console.log(JSON.stringify({ id: process.argv[1] + "-imagery", label: process.argv[2], kind: "imagery", type: process.argv[3], url: process.argv[4], maxZoom: +process.argv[5], ...(process.argv[6] ? { attribution: process.argv[6] } : {}) }))' \
    "$NAME" "${IMG_LABEL:-$NAME imagery}" "$IMG_TYPE" "$url" "$z" "$ATTR")")
fi

if [[ -n "$TER" ]]; then
  [[ -d "$TER" ]] || fail "--terrain $TER is not a folder"
  echo "· terrain ($TER_TYPE) from $TER"
  cp -r --no-preserve=mode,ownership "$TER" "$PKG/terrain"
  z="$(max_zoom "$PKG/terrain")"
  [[ -n "$z" ]] || fail "--terrain has no zoom level folders (0, 1, 2 ...)"
  if [[ "$TER_TYPE" == quantized-mesh ]]; then
    [[ -f "$PKG/terrain/layer.json" ]] || fail "quantized-mesh terrain needs layer.json (the terrain builder writes it with --layer)"
    # Caddy sends .terrain tiles with Content-Encoding: gzip, so each must be gzipped.
    n=0
    while IFS= read -r -d '' t; do
      if [[ "$(head -c2 "$t" | od -An -tx1 | tr -d ' \n')" != 1f8b ]]; then gzip -n -9 -c "$t" > "$t.gz" && mv "$t.gz" "$t"; n=$((n + 1)); fi
    done < <(find "$PKG/terrain" -type f -name '*.terrain' -print0)
    [[ $n -eq 0 ]] || echo "  gzipped $n tiles"
    url="basemaps/$NAME/terrain"
  else
    [[ -n "$(find "$PKG/terrain/$z" -type f -name '*.png' -print -quit)" ]] || fail "terrarium terrain needs {z}/{x}/{y}.png tiles"
    url="basemaps/$NAME/terrain/{z}/{x}/{y}.png"
  fi
  sources+=("$(node -e 'console.log(JSON.stringify({ id: process.argv[1] + "-terrain", label: process.argv[2], kind: "terrain", type: process.argv[3], url: process.argv[4], maxZoom: +process.argv[5], ...(process.argv[6] ? { attribution: process.argv[6] } : {}) }))' \
    "$NAME" "${TER_LABEL:-$NAME terrain}" "$TER_TYPE" "$url" "$z" "$ATTR")")
fi

# Nothing but files and folders goes in.
[[ -z "$(find "$PKG" ! -type f ! -type d -print -quit)" ]] || fail "the tile folders hold links or other special files: $(find "$PKG" ! -type f ! -type d -print -quit)"

node -e '
  const [name, version, ...src] = process.argv.slice(1);
  const m = { format: "viewer-basemap/1", name, version, built: new Date().toISOString().replace(/\.\d+Z$/, "Z"), sources: src.map((s) => JSON.parse(s)) };
  process.stdout.write(JSON.stringify(m, null, 2) + "\n");
' "$NAME" "$VERSION" "${sources[@]}" > "$PKG/basemap.json"

echo "· checksums"
(cd "$PKG" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

file="$NAME-$VERSION.basemap.tar"
tar --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' -cf "$OUT/$file" -C "$STAGE" "$NAME"
(cd "$OUT" && sha256sum "$file" > "$file.sha256")
rm -rf "$STAGE"
echo "Done: $OUT/$file ($(du -h "$OUT/$file" | cut -f1), $(tar -tf "$OUT/$file" | wc -l) entries)"
