#!/usr/bin/env bash
# Adds the building tools to a HOLO server installed in a home folder (install-user.sh), so it can
# make Gaussian splats from a video or photos by itself. No root and no internet needed.
#
#   ./install-building.sh                 for HOLO in ~/holo
#   ./install-building.sh --dir /data/holo
#   ./install-building.sh --no-test       skip the short self-test build at the end
#
# Run it from the unpacked holo-building bundle, as the same user that installed HOLO. It puts the
# tools in <holo>/training/<version>, tells HOLO where they are (settings/holo-worker.json and
# SPLAT_WORKERS in settings/viewer.env), restarts HOLO, and runs `holo test-building`.
# Running it again, or with a newer bundle, is safe.
set -euo pipefail
umask 077

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/holo" TEST=1
say() { echo "· $*"; }
fail() { echo; echo "Stopped: $*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) D="$2"; shift 2 ;;
    --no-test) TEST=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (./install-building.sh --help lists them)" ;;
  esac
done

[[ $EUID -ne 0 ]] || fail "run it as yourself, without sudo"
[[ -f "$BUNDLE/VERSION" && -f "$BUNDLE/SHA256SUMS" ]] || fail "run this from the unpacked holo-building folder"
[[ -f "$D/settings/viewer.env" && -L "$D/current" ]] || fail "HOLO is not installed in $D. Install the server first (./install-user.sh), or give its folder with --dir"
[[ -f "$D/current/workers/holo-splat-worker.mjs" ]] || fail "this HOLO version has no splat worker; install HOLO 1.1.1 or newer first"
VERSION="$(awk '/^holo-building /{print $2}' "$BUNDLE/VERSION")"
echo "HOLO building tools $VERSION: adding them to $D"
echo

say "checking the download"
(cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS) || fail "the download is damaged; copy the .tar.gz again"

T="$D/training"
dest="$T/$VERSION"
mkdir -p "$T"
if [[ -x "$dest/env/bin/python" && -x "$dest/brush/brush_app" ]]; then
  say "$VERSION is already there"
else
  say "unpacking Python, ffmpeg and pycolmap (a few minutes)"
  rm -rf "$dest.partial"
  mkdir -p "$dest.partial/env"
  tar -xzf "$BUNDLE/env.tar.gz" -C "$dest.partial/env"
  # conda-pack's fix-up: the environment now lives here, not where it was built.
  "$dest.partial/env/bin/python" "$dest.partial/env/bin/conda-unpack" >/dev/null 2>&1 || (cd "$dest.partial/env" && ./bin/conda-unpack >/dev/null)
  cp -a "$BUNDLE/brush" "$BUNDLE/sample" "$BUNDLE/VERSION" "$dest.partial/"
  [[ -d "$BUNDLE/models" ]] && cp -a "$BUNDLE/models" "$dest.partial/"
  "$dest.partial/env/bin/python" -c "import pycolmap" || fail "the unpacked Python cannot load pycolmap"
  if [[ -d "$BUNDLE/models" ]]; then "$dest.partial/env/bin/python" -c "import onnxruntime" || fail "the unpacked Python cannot load onnxruntime"; fi
  rm -rf "$dest"
  mv "$dest.partial" "$dest"
fi
ln -sfn "$dest" "$T/current.new" && mv -Tf "$T/current.new" "$T/current"

# --- Small launchers with fixed paths: the server starts the worker with a bare environment --------
mkdir -p "$T/bin"
cat > "$T/bin/brush" <<EOF
#!/usr/bin/env bash
# Brush with a Vulkan loader: the system's, or the one in the building environment.
if ! /sbin/ldconfig -p 2>/dev/null | grep -q 'libvulkan.so.1 '; then
  export LD_LIBRARY_PATH="$T/current/env/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi
exec "$T/current/brush/brush_app" "\$@"
EOF
cat > "$T/bin/holo-splat-worker" <<EOF
#!/usr/bin/env bash
# HOLO's splat worker on HOLO's own Node.js, with the settings install-building.sh wrote.
export HOLO_WORKER_CONFIG="$D/settings/holo-worker.json"
exec "$D/current/node/bin/node" "$D/current/workers/holo-splat-worker.mjs" "\$@"
EOF
chmod 700 "$T/bin/brush" "$T/bin/holo-splat-worker"

say "telling HOLO where the tools are"
cat > "$D/settings/holo-worker.json" <<EOF
{
  "_note": "Written by install-building.sh. Camera poses with pycolmap on the processor; building with Brush on the graphics card.",
  "ffmpeg": "$T/current/env/bin/ffmpeg",
  "sfm": "pycolmap",
  "python": "$T/current/env/bin/python",
  "sfmGpu": false,$([[ -f "$T/current/models/yolox_s.onnx" ]] && printf '\n  "masks": "%s",' "$T/current/models/yolox_s.onnx" || true)
  "methods": {
    "brush": { "program": "$T/bin/brush", "revision": "$("$T/current/brush/brush_app" --version 2>/dev/null | awk '{print $2}')" }
  }
}
EOF
chmod 600 "$D/settings/holo-worker.json"
line="SPLAT_WORKERS=brush=$T/bin/holo-splat-worker"
if grep -q '^SPLAT_WORKERS=' "$D/settings/viewer.env"; then
  sed -i "s|^SPLAT_WORKERS=.*|$line|" "$D/settings/viewer.env"
else
  printf '\n# Added by install-building.sh: splats from video and photos, built with Brush.\n%s\n' "$line" >> "$D/settings/viewer.env"
fi

say "restarting HOLO"
"$D/holo" restart >/dev/null || fail "HOLO did not start again: holo logs shows why"

if [[ $TEST -eq 1 ]]; then
  echo
  "$D/holo" test-building || exit 1
fi
echo
echo "Done. In HOLO, choose \"Make a splat\" and upload a video or photos."
