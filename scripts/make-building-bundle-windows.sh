#!/usr/bin/env bash
# The building add-on for HOLO for Windows: everything "Build on this PC" needs to turn a video or
# photos into Gaussian splats on the PC's own graphics card, in one zip that HOLO installs for the
# user (no administrator, no internet):
#
#   node/          Node.js, which runs the building steps (workers/holo-splat-worker.mjs)
#   python/        Python 3.12 (python.org's embeddable build) with pycolmap (camera poses without
#                  an NVIDIA card), onnxruntime with DirectML (masks, on the graphics card when it
#                  can), numpy and Pillow
#   colmap/        COLMAP (BSD) built with CUDA, its official Windows release: features, matching
#                  and bundle adjustment on an NVIDIA card; Microsoft's C++ runtime beside it
#   ffmpeg/        ffmpeg (video frames; decoded on an NVIDIA card with -hwaccel cuda), Gyan Doshi's
#                  essentials build
#   brush/         Brush (Apache-2.0), built from source with HOLO's needle penalty
#                  (scripts/brush/needle-penalty.patch); it uses the graphics card through Vulkan
#   models/        YOLOX-S (Apache-2.0), which finds people and vehicles for the masks
#   worker/        HOLO's building steps: holo-splat-worker.mjs, sfm_pycolmap.py, holo_masks.py
#   sample/        a small made-up scene for the self-test
#   VERSION, SHA256SUMS
#
# Run on a Windows build machine with Git Bash, Python 3.12, Rust (cargo), curl, 7-Zip and Visual
# Studio (for its C++ runtime, which COLMAP needs and does not ship):
#   bash scripts/make-building-bundle-windows.sh   -> out/holo-building-<version>-windows-x64.zip
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VIEWER_VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
NODE_VERSION="${NODE_VERSION:-}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12.10}"
PYCOLMAP_VERSION="${PYCOLMAP_VERSION:-3.13.0}"
ONNXRUNTIME_VERSION="${ONNXRUNTIME_VERSION:-1.20.1}"
BRUSH_VERSION="${BRUSH_VERSION:-v0.3.0}"
BRUSH_COMMIT="${BRUSH_COMMIT:-3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486}"
FFMPEG_URL="https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip"
FFMPEG_SHA256="04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4"
COLMAP_VERSION="${COLMAP_VERSION:-3.13.0}"
COLMAP_URL="https://github.com/colmap/colmap/releases/download/$COLMAP_VERSION/colmap-x64-windows-cuda.zip"
COLMAP_SHA256="60f77bd8e9823e6d2b39082ee665f69c91900011d5321fc54a4dfebe3de110b7"
COLMAP_LICENSE_URL="https://raw.githubusercontent.com/colmap/colmap/$COLMAP_VERSION/COPYING.txt"
COLMAP_LICENSE_SHA256="ab30dabb4f0a6731f980108f57aa160cc8f5cebae6984e01a5d109df99669233"
YOLOX_URL="https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx"
YOLOX_SHA256="c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"
NAME="holo-building-$VERSION-windows-x64"
OUT="$ROOT/out"
STAGE="$OUT/$NAME"
DL="$OUT/.downloads"
WORK="$OUT/.building-windows"

fail() { echo "make-building-bundle-windows: $*" >&2; exit 1; }
check() { echo "$2  $1" | sha256sum -c --quiet - || fail "$(basename "$1") is not the expected file"; }
# 7-Zip is a Windows program: give it Windows paths (Git Bash does not convert "-o<path>").
unpack() { mkdir -p "$2" && 7z x -y -bso0 -bsp0 -o"$(cygpath -w "$2")" "$(cygpath -w "$1")" || fail "cannot unpack $(basename "$1")"; }
rm -rf "$STAGE" "$OUT/$NAME.zip" "$WORK"
mkdir -p "$STAGE" "$DL" "$WORK"

if [[ -z "$NODE_VERSION" ]]; then
  major="$(tr -dc '0-9' < "$ROOT/.nvmrc")"
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | python -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$major.')))")"
fi
echo "· Node.js $NODE_VERSION"
nz="node-$NODE_VERSION-win-x64.zip"
[[ -f "$DL/$nz" ]] || curl -fsSL -o "$DL/$nz" "https://nodejs.org/dist/$NODE_VERSION/$nz"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $nz\$" | (cd "$DL" && sha256sum -c --quiet -) || fail "Node.js checksum does not match"
unpack "$DL/$nz" "$WORK"
mkdir -p "$STAGE/node"
cp "$WORK/node-$NODE_VERSION-win-x64/node.exe" "$WORK/node-$NODE_VERSION-win-x64/LICENSE" "$STAGE/node/"

echo "· Python $PYTHON_VERSION with pycolmap $PYCOLMAP_VERSION and onnxruntime-directml $ONNXRUNTIME_VERSION"
pz="python-$PYTHON_VERSION-embed-amd64.zip"
[[ -f "$DL/$pz" ]] || curl -fsSL -o "$DL/$pz" "https://www.python.org/ftp/python/$PYTHON_VERSION/$pz"
mkdir -p "$STAGE/python"
unpack "$DL/$pz" "$STAGE/python"
# The embeddable build ignores site-packages until its ._pth file says otherwise.
pth="$(ls "$STAGE/python"/python3*._pth)"
printf 'python312.zip\n.\nLib\\site-packages\nimport site\n' > "$pth"
python -m pip install -q --no-cache-dir --target "$STAGE/python/Lib/site-packages" --only-binary=:all: \
  "pycolmap==$PYCOLMAP_VERSION" "onnxruntime-directml==$ONNXRUNTIME_VERSION" numpy pillow
"$STAGE/python/python.exe" -c "import pycolmap, onnxruntime, numpy, PIL; print('  pycolmap', pycolmap.__version__, '· onnxruntime', onnxruntime.__version__, onnxruntime.get_available_providers())"
"$STAGE/python/python.exe" -c "import onnxruntime as o, sys; sys.exit(0 if 'DmlExecutionProvider' in o.get_available_providers() else 1)" || fail "onnxruntime has no DirectML"

echo "· COLMAP $COLMAP_VERSION with CUDA"
cz="$DL/colmap-$COLMAP_VERSION-windows-cuda.zip"
[[ -f "$cz" ]] || curl -fsSL -o "$cz" "$COLMAP_URL"
check "$cz" "$COLMAP_SHA256"
unpack "$cz" "$WORK/colmap"
cdir="$(dirname "$(find "$WORK/colmap" -path '*/bin/colmap.exe' | head -1)")/.."
[[ -f "$cdir/bin/colmap.exe" ]] || fail "no bin/colmap.exe in the COLMAP release"
mkdir -p "$STAGE/colmap"
# The program and what it loads; not its tests and debug symbols (half the size).
cp -r "$cdir/bin" "$cdir/plugins" "$STAGE/colmap/"
find "$STAGE/colmap" \( -name '*_test.exe' -o -name '*.pdb' \) -delete
curl -fsSL -o "$STAGE/colmap/COPYING.txt" "$COLMAP_LICENSE_URL"
check "$STAGE/colmap/COPYING.txt" "$COLMAP_LICENSE_SHA256"
# COLMAP's release leaves Microsoft's C++ runtime to the PC; put it beside the program
# (app-local, as Microsoft allows), so a PC without the Visual C++ Redistributable runs it too.
vs="$("/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe" -latest -products '*' -property installationPath | tr -d '\r')"
crt="$(ls -d "$(cygpath -u "$vs")"/VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT 2>/dev/null | sort -V | tail -1)"
omp="$(dirname "$crt")/Microsoft.VC143.OpenMP"
[[ -d "$crt" ]] || fail "no Visual C++ runtime (Microsoft.VC143.CRT) on this machine"
cp "$crt"/*.dll "$STAGE/colmap/bin/"
[[ -d "$omp" ]] && cp "$omp"/*.dll "$STAGE/colmap/bin/"
"$STAGE/colmap/bin/colmap.exe" help >/dev/null || fail "COLMAP does not start"
"$STAGE/colmap/bin/colmap.exe" feature_extractor -h 2>&1 | grep "FeatureExtraction.use_gpu" >/dev/null || fail "COLMAP has no GPU option"

echo "· ffmpeg"
fz="$DL/ffmpeg-essentials.zip"
[[ -f "$fz" ]] || curl -fsSL -o "$fz" "$FFMPEG_URL"
check "$fz" "$FFMPEG_SHA256"
unpack "$fz" "$WORK/ffmpeg"
mkdir -p "$STAGE/ffmpeg"
cp "$WORK"/ffmpeg/*/bin/ffmpeg.exe "$WORK"/ffmpeg/*/LICENSE "$STAGE/ffmpeg/"
ffv="$("$STAGE/ffmpeg/ffmpeg.exe" -hide_banner -version | awk 'NR==1{print $3}')"

echo "· Brush $BRUSH_VERSION with HOLO's needle penalty"
src="$WORK/brush-src"
git -c core.autocrlf=false clone -q --depth 1 --branch "$BRUSH_VERSION" https://github.com/ArthurBrussee/brush.git "$src"
[[ "$(git -C "$src" rev-parse HEAD)" == "$BRUSH_COMMIT" ]] || fail "Brush $BRUSH_VERSION is not commit $BRUSH_COMMIT"
git -C "$src" apply --ignore-whitespace "$ROOT/scripts/brush/needle-penalty.patch"
(cd "$src" && cargo build -q --release --locked --bin brush_app)
mkdir -p "$STAGE/brush"
cp "${CARGO_TARGET_DIR:-$src/target}/release/brush_app.exe" "$src/LICENSE" "$ROOT/scripts/brush/needle-penalty.patch" "$STAGE/brush/"
"$STAGE/brush/brush_app.exe" --help | grep -q -- "--aniso-loss-weight" || fail "the Brush build has no needle penalty"
brv="$("$STAGE/brush/brush_app.exe" --version | awk '{print $2}')+holo"

echo "· the people and vehicle detector for masks (YOLOX-S)"
yx="$DL/yolox_s.onnx"
[[ -f "$yx" ]] || curl -fsSL -o "$yx" "$YOLOX_URL"
check "$yx" "$YOLOX_SHA256"
mkdir -p "$STAGE/models"
cp "$yx" "$STAGE/models/yolox_s.onnx"
printf 'yolox_s.onnx: YOLOX-S by Megvii, Apache-2.0, from %s\r\n' "$YOLOX_URL" > "$STAGE/models/README.txt"

echo "· HOLO's building steps and the self-test sample"
mkdir -p "$STAGE/worker"
cp "$ROOT/workers/holo-splat-worker.mjs" "$ROOT/workers/sfm_pycolmap.py" "$ROOT/workers/holo_masks.py" "$STAGE/worker/"
"$STAGE/python/python.exe" "$ROOT/workers/selftest/make_sample.py" "$STAGE/sample" | sed 's/^/  /'

cat > "$STAGE/VERSION" <<EOF
holo-building $VERSION windows-x64
node $NODE_VERSION
python $PYTHON_VERSION
pycolmap $PYCOLMAP_VERSION
onnxruntime-directml $ONNXRUNTIME_VERSION
colmap $COLMAP_VERSION cuda
ffmpeg $ffv
brush $brv
yolox_s $YOLOX_SHA256
built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
EOF
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

echo "· zip"
(cd "$OUT" && 7z a -tzip -mx=5 -bso0 -bsp0 "$NAME.zip" "$NAME")
(cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
rm -rf "$WORK"
echo "Done: $OUT/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
