#!/usr/bin/env bash
# The building add-on for a HOLO server installed in a home folder (deploy/install-user.sh): the
# tools that turn a video or photos into Gaussian splats, in one archive that installs with no
# root and no internet (deploy/install-building.sh, docs/INSTALL.md):
#
#   env.tar.gz     Python 3.12 with pycolmap (camera poses), numpy, Pillow, and ffmpeg (video
#                  frames), from conda-forge and PyPI, packed with conda-pack so it can move
#   brush/         Brush (Apache-2.0), built from source with HOLO's needle penalty: one program
#                  that builds on any graphics card through Vulkan (NVIDIA, AMD or Intel), or
#                  slowly on the processor
#   sample/        a small made-up scene for the self-test (workers/selftest/make_sample.py)
#   install-building.sh, VERSION, SHA256SUMS
#
# Run on an internet-connected build machine:
#   bash scripts/make-building-bundle.sh      -> out/holo-building-<version>-linux-x64.tar.gz
# VIEWER_VERSION sets the version. MICROMAMBA_VERSION, PYCOLMAP_VERSION, BRUSH_VERSION and
# BRUSH_COMMIT pin the tools (defaults below). Building Brush needs Rust (cargo) and git.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VIEWER_VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
MICROMAMBA_VERSION="${MICROMAMBA_VERSION:-2.3.3-0}"
PYCOLMAP_VERSION="${PYCOLMAP_VERSION:-3.13.0}"
BRUSH_VERSION="${BRUSH_VERSION:-v0.3.0}"
BRUSH_COMMIT="${BRUSH_COMMIT:-3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486}"
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

echo "· Brush $BRUSH_VERSION with HOLO's needle penalty (scripts/brush/needle-penalty.patch)"
# Built from Brush's own source at the tag's commit, with one small addition: a penalty on long,
# thin splats (--aniso-loss-weight, --aniso-max-ratio). Needs Rust (cargo) on the build machine.
src="$WORK/brush-src"
git clone -q --depth 1 --branch "$BRUSH_VERSION" https://github.com/ArthurBrussee/brush.git "$src"
[[ "$(git -C "$src" rev-parse HEAD)" == "$BRUSH_COMMIT" ]] || fail "Brush $BRUSH_VERSION is not commit $BRUSH_COMMIT"
git -C "$src" apply "$ROOT/scripts/brush/needle-penalty.patch"
(cd "$src" && cargo build -q --release --locked --bin brush_app)
mkdir -p "$STAGE/brush"
install -m 0755 "$src/target/release/brush_app" "$STAGE/brush/brush_app"
cp "$src/LICENSE"* "$STAGE/brush/" 2>/dev/null || true
cp "$ROOT/scripts/brush/needle-penalty.patch" "$STAGE/brush/"
"$STAGE/brush/brush_app" --help | grep -q -- "--aniso-loss-weight" || fail "the Brush build has no needle penalty"
brv="$("$STAGE/brush/brush_app" --version | awk '{print $2}')+holo"

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
