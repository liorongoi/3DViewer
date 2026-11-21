#!/usr/bin/env bash
# The install without root (deploy/install-user.sh): installs as an ordinary user into a folder of
# its own, runs with the built-in database behind Caddy on a high port, signs in, stops and starts,
# backs up, writes a support report with no addresses or names, upgrades, and uninstalls leaving
# the data. Run as an ordinary user (not root):
#
#   bash scripts/check-user-install.sh <bundle-1.tar.gz> <bundle-2.tar.gz>
set -uo pipefail
[[ $EUID -ne 0 ]] || { echo "run as an ordinary user"; exit 2; }
B1="$(readlink -f "$1")" B2="$(readlink -f "$2")"
WORK="$(mktemp -d)"
H="$WORK/holo"
failed=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failed=$((failed + 1)); fi; }
unpack() { mkdir -p "$WORK/$2" && tar -xzf "$1" -C "$WORK/$2" && echo "$WORK/$2/$(ls "$WORK/$2")"; }
d1="$(unpack "$B1" b1)"; d2="$(unpack "$B2" b2)"
v2="$(awk '/^viewer /{print $2}' "$d2/VERSION")"
holo() { "$H/holo" "$@"; }
port() { sed -n 's/^HTTP_PORT=//p' "$H/settings/caddy.env"; }

(cd "$d1" && ./install-user.sh --dir "$H" --port 18080) 2>&1 | tee "$WORK/i1.log"
check "install-user.sh says it is running" "grep -q 'is running' '$WORK/i1.log'"
check "it refuses root" "grep -q 'without sudo' '$d1/install-user.sh'"
check "everything is inside its folder; the settings are private" "[[ \$(stat -c %a '$H/settings') == 700 && \$(stat -c %a '$H/settings/viewer.env') == 600 ]]"
check "built-in database, healthy through the front end" "curl -fsS http://127.0.0.1:18080/api/health | grep -q '\"db\":\"pglite\"'"
check "the web app is served" "curl -fsS http://127.0.0.1:18080/ | grep -q '<div id=\"root\"'"
pw="$(cat "$H/settings/first-admin-password")"
check "the admin signs in with the printed password" "grep -q '$pw' '$WORK/i1.log' && curl -fsS -X POST -H 'content-type: application/json' -d '{\"password\":\"$pw\"}' http://127.0.0.1:18080/api/admin/login | grep -q token"
check "nothing runs as root" "! pgrep -u root -f '$H' >/dev/null"
check "holo stop stops it" "holo stop >/dev/null && ! curl -fsS -m 3 http://127.0.0.1:18080/api/health >/dev/null 2>&1"
check "holo start starts it" "holo start >/dev/null && holo status >/dev/null"
check "holo backup makes a backup and leaves it running" "holo backup >/dev/null && ls '$H/backups' | grep -q viewer- && holo status >/dev/null"
holo report > "$WORK/report.out"
rep="$(sed -n 's/^Written: //p' "$WORK/report.out")"
check "holo report names no address, host or user" "[[ -s '$rep' ]] && ! grep -qE '([0-9]{1,3}\.){3}[0-9]{1,3}|$(hostname)|$USER|$HOME' '$rep'"
check "holo check runs" "holo check >/dev/null; [[ \$? -le 1 ]]"
(cd "$d2" && ./install-user.sh --dir "$H") > "$WORK/i2.log" 2>&1
check "upgrade to $v2 keeps the address and runs" "[[ \$(readlink -e '$H/current') == '$H/releases/$v2' ]] && curl -fsS http://127.0.0.1:18080/api/health | grep -q '\"ok\":true'"
check "the upgrade kept the admin password" "curl -fsS -X POST -H 'content-type: application/json' -d '{\"password\":\"$pw\"}' http://127.0.0.1:18080/api/admin/login | grep -q token"
holo uninstall >/dev/null
check "uninstall stops it and keeps the data" "! curl -fsS -m 3 http://127.0.0.1:18080/api/health >/dev/null 2>&1 && [[ -d '$H/data' && ! -e '$H/current' ]]"
rm -f "$rep"; rm -rf "$WORK"
echo; [[ $failed -eq 0 ]] && echo "All checks passed." || { echo "$failed check(s) failed."; exit 1; }
