#!/usr/bin/env bash
# Checks the Windows building add-on on a Windows machine (Git Bash), the way HOLO for Windows
# uses it: unpacked with Windows' own tar, every file against SHA256SUMS, then each tool and
# HOLO's building steps on the self-test sample, from a folder with a space in its name.
# Nothing here needs a graphics card: the steps HOLO puts on an NVIDIA card are run here with the
# card asked for, and must still finish (on the processor, when this machine has no such card).
# The last step tries a short Brush build and only reports.
#   bash scripts/check-building-windows.sh out/holo-building-<version>-windows-x64.zip
set -uo pipefail
ZIP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
T="$(mktemp -d)/HOLO check"
mkdir -p "$T"
fails=0
check() {
  if eval "$2" >"$T/last.log" 2>&1; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/last.log" | tail -25; fails=$((fails + 1)); fi
}

"$SYSTEMROOT/System32/tar.exe" -xf "$(cygpath -w "$ZIP")" -C "$(cygpath -w "$T")" || { echo "FAIL Windows' tar cannot unpack the zip"; exit 1; }
A="$(ls -d "$T"/holo-building-*-windows-x64)"
W="$(cygpath -w "$A")"
echo "Add-on: $(head -1 "$A/VERSION")"

check "every file matches SHA256SUMS" "cd '$A' && sha256sum -c --quiet SHA256SUMS"
check "Node.js runs" "'$A/node/node.exe' --version"
check "Python has pycolmap, onnxruntime, numpy and Pillow" "'$A/python/python.exe' -I -c 'import pycolmap, onnxruntime, numpy, PIL'"
check "onnxruntime can use the graphics card (DirectML)" "'$A/python/python.exe' -I -c 'import onnxruntime as o, sys; sys.exit(0 if \"DmlExecutionProvider\" in o.get_available_providers() else 1)'"
check "ffmpeg runs" "'$A/ffmpeg/ffmpeg.exe' -hide_banner -version"
check "ffmpeg can decode on an NVIDIA card (cuda)" "'$A/ffmpeg/ffmpeg.exe' -hide_banner -hwaccels | grep -qx cuda"
check "COLMAP runs" "'$A/colmap/bin/colmap.exe' help"
check "COLMAP has its GPU options" "'$A/colmap/bin/colmap.exe' feature_extractor -h | grep -q FeatureExtraction.use_gpu"
check "Microsoft's C++ runtime is beside COLMAP" "test -f '$A/colmap/bin/msvcp140.dll' && test -f '$A/colmap/bin/vcruntime140.dll' && test -f '$A/colmap/bin/vcruntime140_1.dll'"
check "COLMAP's licence is there" "grep -q 'ETH Zurich' '$A/colmap/COPYING.txt'"
check "Brush has the needle penalty" "'$A/brush/brush_app.exe' --help | grep -q -- --aniso-loss-weight"

# The settings HOLO for Windows writes (apps/desktop/src/local-build.ts, workerConfig).
CFG="$T/holo-worker.json"
"$A/python/python.exe" -I - "$W" "$(cygpath -w "$CFG")" <<'EOF'
import json, os, sys
a, out = sys.argv[1], sys.argv[2]
json.dump({"ffmpeg": os.path.join(a, "ffmpeg", "ffmpeg.exe"), "sfm": "pycolmap", "python": os.path.join(a, "python", "python.exe"), "sfmGpu": False,
           "masks": os.path.join(a, "models", "yolox_s.onnx"), "methods": {"brush": {"program": os.path.join(a, "brush", "brush_app.exe"), "revision": "check"}}}, open(out, "w"))
EOF
export HOLO_WORKER_CONFIG="$(cygpath -w "$CFG")"
NODE="$A/node/node.exe"
WORKER="$W\\worker\\holo-splat-worker.mjs"

check "the worker's own check of Brush passes" "'$NODE' '$WORKER' --check --method brush | grep -q '\"ok\":true'"

cp -r "$A/sample" "$T/sample copy"
S="$(cygpath -w "$T/sample copy")"
check "masks run on the sample" "'$A/python/python.exe' -I '$W\\worker\\holo_masks.py' --data '$S' --model '$S\\sparse\\0' --detector '$W\\models\\yolox_s.onnx' | grep -q '\"pictures\": 24'"

# A video from the sample's pictures: frames by movement (ffmpeg's blurdetect writes a file, the
# step that needs Windows paths handled), then the capture check on the video and on the photos.
mkdir -p "$T/video in" "$T/photos in"
check "ffmpeg makes a test video" "'$A/ffmpeg/ffmpeg.exe' -hide_banner -loglevel error -framerate 4 -i '$S\\images\\view_%02d.jpg' -c:v mpeg4 -q:v 3 '$(cygpath -w "$T/video in/walk.mp4")'"
cp "$T/sample copy/images/"*.jpg "$T/photos in/"
URL="file:///$(cygpath -m "$A/worker/holo-splat-worker.mjs" | sed 's/ /%20/g')"
check "frames are taken from the video" "'$NODE' --input-type=module -e \"const m = await import('$URL'); const out = await m.videoFrames(m.loadConfig(), process.argv[1], process.argv[2], { resolution: 320, videoFps: 2 }); if (out.length < 8) throw new Error('only ' + out.length + ' frames'); console.log(out.length, 'frames');\" '$(cygpath -w "$T/video in/walk.mp4")' '$(cygpath -w "$T/frames/images")'"
check "the capture check runs on the video" "'$NODE' '$WORKER' --assess --input '$(cygpath -w "$T/video in")' --input-kind video --output '$(cygpath -w "$T/assess video")' --threads 2 && grep -q verdict '$T/assess video/report.json'"
check "the capture check poses the photos" "'$NODE' '$WORKER' --assess --input '$(cygpath -w "$T/photos in")' --input-kind photos --output '$(cygpath -w "$T/assess photos")' --threads 2 && grep -q verdict '$T/assess photos/report.json'"

# The same with the settings HOLO writes on a PC with an NVIDIA card (workerConfig with nvidia):
# the add-on's COLMAP, video decoding and masks on the card. Where the card is missing, each step
# must say so and finish on the processor.
GCFG="$T/holo-worker-gpu.json"
"$A/python/python.exe" -I - "$(cygpath -w "$CFG")" "$(cygpath -w "$GCFG")" "$W" <<'EOF2'
import json, os, sys
c = json.load(open(sys.argv[1]))
c.update({"sfm": "colmap", "colmap": os.path.join(sys.argv[3], "colmap", "bin", "colmap.exe"), "sfmGpu": True, "videoDecode": "cuda", "masksGpu": True})
json.dump(c, open(sys.argv[2], "w"))
EOF2
check "with the NVIDIA settings, frames are taken from the video" "HOLO_WORKER_CONFIG='$(cygpath -w "$GCFG")' '$NODE' --input-type=module -e \"const m = await import('$URL'); const out = await m.videoFrames(m.loadConfig(), process.argv[1], process.argv[2], { resolution: 320, videoFps: 2 }); if (out.length < 8) throw new Error('only ' + out.length + ' frames'); console.log(out.length, 'frames');\" '$(cygpath -w "$T/video in/walk.mp4")' '$(cygpath -w "$T/frames gpu/images")'"
check "with the NVIDIA settings, COLMAP poses the photos" "HOLO_WORKER_CONFIG='$(cygpath -w "$GCFG")' '$NODE' '$WORKER' --assess --input '$(cygpath -w "$T/photos in")' --input-kind photos --output '$(cygpath -w "$T/assess photos gpu")' --threads 2 2>'$T/gpu.log' && grep -q verdict '$T/assess photos gpu/report.json' && grep -q 'colmap.exe feature_extractor' '$T/gpu.log'"
grep -h "sfm:\|frames:" "$T/gpu.log" 2>/dev/null | sed 's/^/     /'
check "with the NVIDIA settings, masks run on the sample" "'$A/python/python.exe' -I '$W\\worker\\holo_masks.py' --gpu --data '$S' --model '$S\\sparse\\0' --detector '$W\\models\\yolox_s.onnx' | grep -q '\"pictures\": 24'"

# A short Brush build on the sample, which already has its camera poses (made-up pictures are
# too plain for the pose step), as `holo test-building` does. Brush needs a graphics adapter,
# which a runner may not have: reported, not required.
mkdir -p "$T/build"
if "$A/brush/brush_app.exe" "$(cygpath -w "$A/sample")" --total-steps 300 --max-resolution 320 --export-every 300 \
  --export-path "$(cygpath -w "$T/build")" --export-name splats.ply >"$T/build.log" 2>&1 && [[ -s "$T/build/splats.ply" ]]; then
  echo "ok   a short Brush build of the sample made splats"
else
  echo "note a short Brush build did not finish here (no graphics adapter on this machine?):"
  tail -5 "$T/build.log" | sed 's/^/     /'
fi

rm -rf "$(dirname "$T")"
[[ $fails -eq 0 ]] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
