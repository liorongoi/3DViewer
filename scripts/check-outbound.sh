#!/usr/bin/env bash
# AC-10 / NFR-12: zero outbound connections, by packet capture.
#
# Runs the VIEWER server, the web app and a browser through a full working session
# (scripts/check-outbound.cjs) inside a network namespace of their own. In it, every address
# outside the machine is routed onto the loopback interface, so any attempt to reach one, and any
# DNS lookup, is a packet on that interface, which tcpdump records. Traffic between the local
# processes (127.0.0.0/8 and ::1) is left out of the capture.
#
# A control connection to 192.0.2.1 (an address reserved for documentation) is made first: the
# capture must see it, so a capture that sees nothing cannot pass. Any other packet fails the check.
#
# Output in the out folder: capture.pcap (the whole capture, for Wireshark), capture.txt (it as
# text), requests.txt (every request the browser made) and screenshots on failure.
#
# Needs root for the namespace and the capture; the session itself runs as the calling user:
#   sudo -E env PATH="$PATH" bash scripts/check-outbound.sh [out folder]
# Build apps/web and apps/server first. Needs ip (iproute2), tcpdump and curl.
set -euo pipefail

OUT=$(realpath -m "${1:-check-out/outbound}")
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ "${VIEWER_OUTBOUND_NS:-}" != 1 ]; then
  [ "$(id -u)" = 0 ] || { echo "Run as root (sudo -E env PATH=\"\$PATH\" bash $0): it makes a network namespace and captures packets." >&2; exit 2; }
  for t in ip tcpdump curl unshare node; do command -v "$t" >/dev/null || { echo "$t is needed." >&2; exit 2; }; done
  rm -rf "$OUT" && mkdir -p "$OUT"
  status=0
  VIEWER_OUTBOUND_NS=1 unshare --net -- bash "$0" "$OUT" || status=$?
  [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" || true
  exit "$status"
fi

# ---- Inside the namespace ----
cd "$ROOT"
ip link set lo up
ip addr add 10.255.255.1/32 dev lo
ip route add default dev lo src 10.255.255.1
ip -6 addr add fd00:5e::1/128 dev lo 2>/dev/null && ip -6 route add default dev lo 2>/dev/null || true

FILTER='port 53 or not ((src net 127.0.0.0/8 and dst net 127.0.0.0/8) or (ip6 and src host ::1 and dst host ::1))'
tcpdump -i lo -nn -Z root -U -w "$OUT/capture.pcap" "$FILTER" 2>"$OUT/tcpdump.log" &
CAPTURE=$!
timeout 15 bash -c "until grep -q listening '$OUT/tcpdump.log'; do sleep 0.2; done"

# The control connection.
curl -s -m 2 http://192.0.2.1/ >/dev/null 2>&1 || true

# The session runs as the user who called sudo, not as root.
AS=()
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  AS=(sudo -u "$SUDO_USER" env "PATH=$PATH" "HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)" ${CHROMIUM:+"CHROMIUM=$CHROMIUM"})
  chown "$SUDO_USER" "$OUT"
fi

# The local vite, not npx: npx asks the npm registry first, which is the check's own traffic.
(cd apps/web && exec "${AS[@]}" ./node_modules/.bin/vite preview --port 4173 --strictPort >"$OUT/preview.log" 2>&1) &
PREVIEW=$!
cleanup() { kill "$PREVIEW" 2>/dev/null || true; pkill -P "$PREVIEW" 2>/dev/null || true; }
trap cleanup EXIT
timeout 60 bash -c 'until curl -sf http://localhost:4173/ >/dev/null; do sleep 0.5; done' || { cat "$OUT/preview.log"; exit 1; }

status=0
"${AS[@]}" node scripts/check-outbound.cjs "$OUT" || status=1
cleanup
sleep 2
kill -INT "$CAPTURE"
wait "$CAPTURE" || true

tcpdump -nn -r "$OUT/capture.pcap" 2>/dev/null >"$OUT/capture.txt" || true
control=$(grep -c ' > 192\.0\.2\.1\.' "$OUT/capture.txt" || true)
others=$(grep -v ' > 192\.0\.2\.1\.' "$OUT/capture.txt" | grep -c . || true)
echo
if [ "$control" -gt 0 ]; then echo "PASS the capture sees an outbound connection (the control, $control packets)"; else echo "FAIL the capture did not see the control connection"; status=1; fi
if [ "$others" -eq 0 ]; then
  echo "PASS no other packet left for any address outside the machine, and no DNS lookup was made"
else
  echo "FAIL $others packet(s) left for outside the machine:"
  grep -v ' > 192\.0\.2\.1\.' "$OUT/capture.txt" | head -40 | sed 's/^/     /'
  status=1
fi
[ "$status" = 0 ] && echo "All outbound checks passed (AC-10)." || echo "The outbound check failed."
exit "$status"
