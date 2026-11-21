#!/usr/bin/env bash
# The training add-on (scripts/build-training-bundle.sh) on a server installed in a home folder:
# installs both as an ordinary user, runs the self-test (a short Brush training on the sample
# scene), and checks that HOLO's own check of the Brush worker passes. Needs a Vulkan driver;
# on a machine with no graphics card, Mesa's lavapipe (mesa-vulkan-drivers) is enough.
#
#   bash scripts/check-training-install.sh <viewer-server.tar.gz> <holo-training.tar.gz>
set -uo pipefail
[[ $EUID -ne 0 ]] || { echo "run as an ordinary user"; exit 2; }
S="$(readlink -f "$1")" T="$(readlink -f "$2")"
WORK="$(mktemp -d)"
H="$WORK/holo"
failed=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failed=$((failed + 1)); fi; }
mkdir -p "$WORK/s" "$WORK/t"
tar -xzf "$S" -C "$WORK/s" && tar -xzf "$T" -C "$WORK/t"
s="$WORK/s/$(ls "$WORK/s")" t="$WORK/t/$(ls "$WORK/t")"
(cd "$s" && ./install-user.sh --dir "$H" --port 18090) > "$WORK/i.log" 2>&1
check "the server installs" "'$H/holo' status >/dev/null"
(cd "$t" && ./install-training.sh --dir "$H") 2>&1 | tee "$WORK/t.log"
check "install-training.sh installs and the self-test trains" "grep -q 'The training tools work' '$WORK/t.log'"
check "HOLO is told about Brush" "grep -q '^SPLAT_WORKERS=brush=$H/training/bin/holo-splat-worker' '$H/settings/viewer.env'"
check "the worker's own check passes with the server's bare environment" "env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 '$H/training/bin/holo-splat-worker' --check --method brush | grep -q '\"ok\":true'"
check "the server sees Brush as ready" "curl -fsS http://127.0.0.1:18090/api/splat-methods | grep -q '\"method\":\"brush\",\"configured\":true,\"environment\":\"ok\"'"
"$H/holo" uninstall >/dev/null
rm -rf "$WORK"
echo; [[ $failed -eq 0 ]] && echo "All checks passed." || { echo "$failed check(s) failed."; exit 1; }
