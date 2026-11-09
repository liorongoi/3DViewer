#!/usr/bin/env bash
# The conversion sandbox's root (apps/server/src/sandbox.ts): only the shared C libraries that the
# given programs load, found with ldd, plus empty mount points. No shell, no tools, no package
# manager; Node.js, the server and FBX2glTF are mounted into it read-only when a step runs.
# A folder stands for every native module in it (*.node, and the libraries packages bring, such
# as sharp's libvips): the system libraries they need are copied too.
#
#   bash scripts/build-sandbox-rootfs.sh <out dir> <program or folder>...
set -euo pipefail
OUT="$1"; shift
[[ $# -gt 0 ]] || { echo "usage: $0 <out dir> <program>..." >&2; exit 2; }
rm -rf "$OUT"
mkdir -p "$OUT"/{proc,dev,sys,tmp,etc,opt,var,run}
objects() {
  for a in "$@"; do
    if [[ -d "$a" ]]; then find -L "$a" -type f \( -name '*.node' -o -name 'lib*.so*' \) 2>/dev/null || true; else echo "$a"; fi
  done | sort -u
}
objects "$@" | while read -r prog; do
  { ldd "$prog" 2>/dev/null || true; } | awk '/=>/ {print $3} /^[ \t]*\// {print $1}' | while read -r lib; do
    # Only system libraries: a package's own (such as sharp's libvips) is mounted with it.
    [[ -f "$lib" && "$lib" =~ ^/(usr/)?lib ]] || continue
    mkdir -p "$OUT$(dirname "$lib")"
    cp -L "$lib" "$OUT$lib"
  done
done
# Name lookups must fail cleanly rather than look for a missing file.
printf 'hosts: files\n' > "$OUT/etc/nsswitch.conf"
: > "$OUT/etc/hosts"
: > "$OUT/etc/resolv.conf"
echo "nobody:x:65534:65534::/tmp:/nonexistent" > "$OUT/etc/passwd"
echo "nogroup:x:65534:" > "$OUT/etc/group"
chmod -R a+rX "$OUT"
echo "sandbox rootfs: $(find "$OUT" -type f | wc -l) files, $(du -sh "$OUT" | cut -f1)"
