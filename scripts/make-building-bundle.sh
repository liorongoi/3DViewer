#!/usr/bin/env bash
# The building add-on for a HOLO server installed in a home folder (deploy/install-user.sh): the
# tools that turn a video or photos into Gaussian splats, in one archive that installs with no
# root and no internet (deploy/install-building.sh, docs/INSTALL.md):
#
#   env.tar.gz     Python 3.12 with pycolmap (camera poses), numpy, Pillow, and ffmpeg (video
#                  frames), from conda-forge and PyPI, packed with conda-pack so it can move
#   brush/         Brush, the trainer (Apache-2.0): one program that trains on any graphics card
#                  through Vulkan (NVIDIA, AMD or Intel), or slowly on the processor
#   sample/        a small made-up scene for the self-test (workers/selftest/make_sample.py)
#   install-building.sh, VERSION, SHA256SUMS
#
# Run on an internet-connected build machine:
#   bash scripts/make-building-bundle.sh      -> out/holo-building-<version>-linux-x64.tar.gz
# VIEWER_VERSION sets the version. MICROMAMBA_VERSION, PYCOLMAP_VERSION and BRUSH_VERSION pin the
# tools (defaults below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VIEWER_VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
MICROMAMBA_VERSION="${MICROMAMBA_VERSION:-2.3.3-0}"
PYCOLMAP_VERSION="${PYCOLMAP_VERSION:-3.13.0}"
BRUSH_VERSION="${BRUSH_VERSION:-v0.3.0}"
NAME="holo-building-$VERSION-linux-x64"
OUT="$ROOT/out"
STAGE="$OUT/$NAME"
DL="$OUT/.downloads"
WORK="$OUT/.training-build"

fail() { echo "make-building-bundle: $*" >&2; exit 1; }
rm -rf "$STAGE" "$OUT/$NAME.tar.gz" "$WORK"
mkdir -p "$STAGE" "$DL" "$WORK"

echo "· micromamba $MICROMAMBA_VERSION"
mm="$DL/micromamba-$MICROMAMBA_VERSION"
[[ -x "$mm" ]] || { curl -fsSL -o "$mm" "https://github.com/mamba-org/micromamba-releases/releases/download/$MICROMAMBA_VERSION/micromamba-linux-64" && chmod +x "$mm"; }

echo "· Python, ffmpeg and pycolmap $PYCOLMAP_VERSION"
env="$WORK/env"
MAMBA_ROOT_PREFIX="$WORK/mamba" "$mm" create -y -q -p "$env" -c conda-forge --override-channels \
  python=3.12 ffmpeg numpy pillow pip libvulkan-loader >/dev/null
"$env/bin/python" -m pip install -q --no-cache-dir "pycolmap==$PYCOLMAP_VERSION"
"$env/bin/python" -c "import pycolmap, numpy, PIL; print('  pycolmap', pycolmap.__version__)"
"$env/bin/ffmpeg" -hide_banner -version | head -1 | sed 's/^/  /'
ffv="$("$env/bin/ffmpeg" -hide_banner -version | awk 'NR==1{print $3}')"

echo "· the self-test sample"
"$env/bin/python" "$ROOT/workers/selftest/make_sample.py" "$STAGE/sample" | sed 's/^/  /'

echo "· packing the environment"
"$env/bin/python" -m pip install -q --no-cache-dir conda-pack --target "$WORK/cp"
PYTHONPATH="$WORK/cp" "$env/bin/python" -c "import sys; from conda_pack.cli import main; sys.exit(main())" -p "$env" -o "$STAGE/env.tar.gz" --ignore-missing-files -q

echo "· Brush $BRUSH_VERSION"
br="$DL/brush-$BRUSH_VERSION.tar.xz"
[[ -f "$br" ]] || curl -fsSL -o "$br" "https://github.com/ArthurBrussee/brush/releases/download/$BRUSH_VERSION/brush-app-x86_64-unknown-linux-gnu.tar.xz"
mkdir -p "$STAGE/brush"
tar -xJf "$br" -C "$STAGE/brush" --strip-components=1
[[ -x "$STAGE/brush/brush_app" ]] || fail "the Brush archive has no brush_app"
brv="$("$STAGE/brush/brush_app" --version | awk '{print $2}')"

install -m 0755 "$ROOT/deploy/install-building.sh" "$STAGE/install-building.sh"
cat > "$STAGE/VERSION" <<EOF
holo-building $VERSION
pycolmap $PYCOLMAP_VERSION
ffmpeg $ffv
brush $brv
built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
EOF
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

echo "· archive"
tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$WORK"
echo "Done: $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
