#!/usr/bin/env bash
# WP 5.6 check: the offline server bundle installs, runs, upgrades and goes back, on a clean
# Linux machine with systemd, as docs/INSTALL.md says. Run as root on a throw-away machine (CI):
#
#   sudo bash scripts/check-server-install.sh <bundle-1.tar.gz> <bundle-2.tar.gz> <DATABASE_URL>
#
# Bundle 2 must be a later version than bundle 1. It uses the name viewer.test (added to
# /etc/hosts) with a certificate from a test CA it makes, and the real ports 80 and 443. It also runs
# the 20-user load test (scripts/load-20-users.cjs) against the installed system.
set -uo pipefail
B1="$(readlink -f "$1")" B2="$(readlink -f "$2")" DB="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
HOST=viewer.test
failed=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failed=$((failed + 1)); fi; }
https() { curl -sS --cacert "$WORK/ca.pem" --resolve "$HOST:443:127.0.0.1" "$@"; }
health_ok() { https -f "https://$HOST/api/health" 2>/dev/null | grep -q '"ok":true'; }

# A test CA and a certificate for viewer.test.
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=VIEWER test CA" -keyout "$WORK/ca.key" -out "$WORK/ca.pem" -days 2 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout "$WORK/viewer.key" -out "$WORK/viewer.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$HOST" > "$WORK/san"
openssl x509 -req -in "$WORK/viewer.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial -days 2 -extfile "$WORK/san" -out "$WORK/viewer.crt" 2>/dev/null
cat "$WORK/viewer.crt" "$WORK/ca.pem" > "$WORK/chain.pem"

unpack() { mkdir -p "$WORK/$2" && tar -xzf "$1" -C "$WORK/$2" && echo "$WORK/$2/$(ls "$WORK/$2")"; }
d1="$(unpack "$B1" b1)"; d2="$(unpack "$B2" b2)"
v1="$(awk '/^viewer /{print $2}' "$d1/VERSION")"; v2="$(awk '/^viewer /{print $2}' "$d2/VERSION")"

echo "== first install ($v1)"
t0=$(date +%s)
(cd "$d1" && ./install.sh --host "$HOST" --database-url "$DB" --cert "$WORK/chain.pem" --key "$WORK/viewer.key") 2>&1 | tee "$WORK/install1.log"
check "install.sh finishes and says it is running" "grep -q 'is running: https://$HOST/' '$WORK/install1.log'"
echo "  (install took $(( $(date +%s) - t0 )) s)"
check "/opt/viewer is version $v1" "[[ \$(readlink -e /opt/viewer) == /opt/viewer-releases/$v1 ]]"
check "the services are running" "systemctl is-active --quiet viewer-server viewer-caddy viewer-backup.timer"
check "the server runs as user viewer, on the bundled Node" "pgrep -u viewer -f '^/opt/viewer/node/bin/node /opt/viewer/server/dist/main.js' >/dev/null"
check "Caddy runs as user viewer, from the bundle" "ps -o user=,args= -C caddy | grep -q '^viewer .*/opt/viewer/bin/caddy run'"
check "health over HTTPS, with the organisation's certificate" "health_ok"
check "the web app over HTTPS" "https -f https://$HOST/ | grep -q '<div id=\"root\"'"
check "plain HTTP redirects to HTTPS" "[[ \$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve $HOST:80:127.0.0.1 http://$HOST/x) == '301 https://$HOST:443/x' ]]"
check "HSTS and nosniff are sent" "https -sI https://$HOST/ | grep -qi '^strict-transport-security' && https -sI https://$HOST/ | grep -qi '^x-content-type-options: nosniff'"
check "TLS 1.1 is refused" "! curl -s -o /dev/null --tls-max 1.1 --cacert $WORK/ca.pem --resolve $HOST:443:127.0.0.1 https://$HOST/"
tls12() { echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" -tls1_2 "$@" 2>/dev/null | grep -q 'Cipher is [A-Z0-9]'; }
check "TLS 1.2 and TLS 1.3 are offered" "https -so /dev/null --tlsv1.2 --tls-max 1.2 https://$HOST/ && https -so /dev/null --tlsv1.3 https://$HOST/"
check "TLS 1.2 offers only forward-secret AEAD suites (ECDHE with AES-GCM or ChaCha20)" "tls12 -cipher 'ECDHE+AESGCM' && ! tls12 -cipher 'ALL:!AESGCM:!CHACHA20:@SECLEVEL=0' && ! tls12 -cipher 'kRSA:@SECLEVEL=0'"
check "the release carries its SBOM (CycloneDX), with the server's packages, Node.js and Caddy" "/opt/viewer/node/bin/node -e 'const b = require(\"/opt/viewer/sbom.cdx.json\"); const n = b.components.map((c) => c.name); process.exit(b.bomFormat === \"CycloneDX\" && [\"fastify\", \"cesium\", \"fbx2gltf\", \"node\", \"caddy\"].every((x) => n.includes(x)) ? 0 : 1)'"
check "the settings are root:viewer 0640" "[[ \$(stat -c '%U:%G %a' /etc/viewer/viewer.env) == 'root:viewer 640' ]]"
check "the first admin password is root-only" "[[ \$(stat -c '%U %a' /etc/viewer/first-admin-password) == 'root 600' ]]"
check "the program is owned by root and not writable by viewer" "! sudo -u viewer test -w /opt/viewer/server/dist/main.js"
pw="$(cat /etc/viewer/first-admin-password)"
login() { https -f -H 'Content-Type: application/json' -d "{\"password\":\"$pw\"}" "https://$HOST/api/admin/login" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).token)'; }
token="$(login 2>/dev/null)"
check "the admin signs in with the first admin password" "[[ -n '$token' ]]"
check "the library answers" "https -f https://$HOST/api/models >/dev/null"

echo "== conversion sandbox"
check "install.sh turned the sandbox on (podman is installed)" "grep -q '^CONVERT_SANDBOX=podman' /etc/viewer/viewer.env && [[ -f /etc/systemd/system/viewer-server.service.d/sandbox.conf ]]"
check "the server checked the sandbox at start: no network, read-only root" "journalctl -u viewer-server --no-pager | grep -q 'conversion sandbox ready'"
# An FBX through the real upload API: the converter, the validator and the optimiser run in it.
fbx="$ROOT/apps/web/public/samples/fbx/stanford-bunny.fbx"
size=$(stat -c %s "$fbx")
ing=$(https -f -H 'Content-Type: application/json' -d "{\"files\":[{\"path\":\"bunny.fbx\",\"size\":$size}],\"model\":{\"name\":\"Bunny, sandbox check\",\"status\":\"draft\",\"classificationId\":\"unclassified\"},\"placement\":{\"lat\":32.08,\"lon\":34.78,\"height\":0,\"aboveGround\":0}}" "https://$HOST/api/ingests")
ing_id=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$ing")
up_url=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).uploads[0].url)' "$ing")
https -f -X PATCH -H 'Content-Type: application/offset+octet-stream' -H 'Upload-Offset: 0' -H 'Tus-Resumable: 1.0.0' --data-binary "@$fbx" "https://$HOST${up_url}" >/dev/null
https -f -X POST "https://$HOST/api/ingests/$ing_id/submit" >/dev/null
state=""
for _ in $(seq 1 120); do
  state=$(https -f "https://$HOST/api/ingests/$ing_id" | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(r.state + " " + (r.error ?? ""))')
  [[ "$state" == ready* || "$state" == failed* ]] && break
  sleep 1
done
check "an FBX upload is converted, validated and published through the sandbox ($state)" "[[ '$state' == ready* ]]"
check "the conversion ran in a container (podman left its state under /var/lib/viewer)" "[[ -d /var/lib/viewer/sandbox/storage ]]"
check "no container is left running" "[[ -z \$(sudo -u viewer -H podman --root /var/lib/viewer/sandbox/storage --runroot /var/lib/viewer/sandbox/run --storage-driver vfs ps --all --quiet 2>/dev/null) ]]"

echo "== base map package"
mk="$WORK/tiles"
node -e '
  const fs = require("fs"), zlib = require("zlib"), path = require("path");
  const root = process.argv[1];
  // A 1x1 PNG: enough for the server; the viewer is checked elsewhere.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  for (const [z, x, y] of [[0, 0, 0], [1, 1, 0], [2, 2, 1]]) {
    fs.mkdirSync(path.join(root, "img", `${z}/${x}`), { recursive: true });
    fs.writeFileSync(path.join(root, "img", `${z}/${x}/${y}.png`), png);
    fs.mkdirSync(path.join(root, "qm", `${z}/${x}`), { recursive: true });
    fs.writeFileSync(path.join(root, "qm", `${z}/${x}/${y}.terrain`), Buffer.alloc(88, 1));
  }
  fs.writeFileSync(path.join(root, "qm", "layer.json"), JSON.stringify({ tilejson: "2.1.0", format: "quantized-mesh-1.0", version: "1.0.0", scheme: "tms", tiles: ["{z}/{x}/{y}.terrain?v={version}"], minzoom: 0, maxzoom: 2, projection: "EPSG:4326", available: [] }));
' "$mk"
bash "$ROOT/scripts/build-basemap-package.sh" --name site --version 1 --imagery "$mk/img" --terrain "$mk/qm" --out "$WORK/pkg" >/dev/null
VIEWER_ADMIN_PASSWORD="$pw" viewer-basemap-install "$WORK/pkg/site-1.basemap.tar" --register 2>&1 | tee "$WORK/basemap.log"
check "viewer-basemap-install installs and registers the package" "grep -q 'added to the admin page' '$WORK/basemap.log'"
check "its sources are in the base map list, as the defaults" "https -f https://$HOST/api/basemaps | node -e 'const c = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")); process.exit(c.defaultImagery === \"site-imagery\" && c.defaultTerrain === \"site-terrain\" && c.sources.length === 2 ? 0 : 1)'"
check "an imagery tile comes through Caddy" "[[ \$(https -s -o /dev/null -w '%{http_code} %{content_type}' https://$HOST/basemaps/site/imagery/1/1/0.png) == '200 image/png' ]]"
check "a terrain tile comes gzipped as quantized-mesh" "https -sI https://$HOST/basemaps/site/terrain/0/0/0.terrain | grep -qi '^content-encoding: gzip' && https -sI https://$HOST/basemaps/site/terrain/0/0/0.terrain | grep -qi '^content-type: application/vnd.quantized-mesh'"
check "the terrain's layer.json comes through" "https -f https://$HOST/basemaps/site/terrain/layer.json | grep -q quantized-mesh"
check "SHA256SUMS and folder listings are not served" "[[ \$(https -s -o /dev/null -w '%{http_code}' https://$HOST/basemaps/site/SHA256SUMS) == 404 && \$(https -s -o /dev/null -w '%{http_code}' https://$HOST/basemaps/site/) == 404 ]]"
check "a missing tile is a 404, not the web app" "[[ \$(https -s -o /dev/null -w '%{http_code}' https://$HOST/basemaps/site/imagery/9/9/9.png) == 404 ]]"

echo "== 20 users at once, through Caddy and TLS (NFR-05, NFR-01)"
# Node finds the host by name (curl above is told the address with --resolve).
grep -q " $HOST # viewer-check" /etc/hosts || echo "127.0.0.1 $HOST # viewer-check" >> /etc/hosts
node "$ROOT/scripts/load-20-users.cjs" "https://$HOST" "$WORK/ca.pem" > "$WORK/load.log" 2>&1; load=$?
sed -i "/ $HOST # viewer-check\$/d" /etc/hosts
sed 's/^/  /' "$WORK/load.log" | tail -25
check "20 users open a 200 MB model together, each within 5 s and with no errors" "[[ $load -eq 0 ]]"

echo "== backup"
systemctl start viewer-backup
check "the nightly backup runs and writes a database dump" "ls /var/backups/viewer/viewer-*/database.dump >/dev/null 2>&1 && systemctl show -p Result --value viewer-backup | grep -q success"

echo "== upgrade to $v2"
(cd "$d2" && ./install.sh) 2>&1 | tee "$WORK/install2.log"
check "the upgrade finishes and says it is running" "grep -q 'is running' '$WORK/install2.log'"
check "/opt/viewer is version $v2, $v1 is the one to go back to" "[[ \$(readlink -e /opt/viewer) == /opt/viewer-releases/$v2 && \$(cat /opt/viewer-releases/previous) == /opt/viewer-releases/$v1 ]]"
check "the settings were kept (the same admin password works)" "[[ -n \$(login 2>/dev/null) ]]"
check "the base map package is still served" "[[ \$(https -s -o /dev/null -w '%{http_code}' https://$HOST/basemaps/site/imagery/0/0/0.png) == 200 ]]"
check "health after the upgrade" "health_ok"

echo "== a version that does not start goes back by itself"
bad="$WORK/bad/viewer-server-broken"
mkdir -p "$WORK/bad" && cp -a "$d2" "$bad"
sed -i "s/^viewer .*/viewer $v2-broken/" "$bad/VERSION"
echo 'console.error("DATABASE_URL: broken on purpose"); process.exit(78);' > "$bad/server/dist/main.js"
(cd "$bad" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
(cd "$bad" && ./install.sh) > "$WORK/install3.log" 2>&1
code=$?
cat "$WORK/install3.log"
check "install.sh fails and says so" "[[ $code -ne 0 ]] && grep -q 'going back to $v2' '$WORK/install3.log'"
check "/opt/viewer is back on $v2, with $v1 still the one to go back to" "[[ \$(readlink -e /opt/viewer) == /opt/viewer-releases/$v2 && \$(cat /opt/viewer-releases/previous) == /opt/viewer-releases/$v1 && ! -e /opt/viewer-releases/$v2-broken ]]"
check "health after going back" "health_ok"

echo "== rollback by hand"
/opt/viewer/install.sh --rollback 2>&1 | tee "$WORK/rollback.log"
check "--rollback goes back to $v1" "[[ \$(readlink -e /opt/viewer) == /opt/viewer-releases/$v1 ]]"
check "health after the rollback" "health_ok"

echo "== a damaged bundle is refused"
dmg="$WORK/dmg/viewer-server-damaged"
mkdir -p "$WORK/dmg" && cp -a "$d2" "$dmg" && echo x >> "$dmg/web/index.html"
check "install.sh refuses it before changing anything" "! (cd '$dmg' && ./install.sh) >/dev/null 2>&1 && [[ \$(readlink -e /opt/viewer) == /opt/viewer-releases/$v1 ]]"

echo "== hardening (systemd-analyze security, lower is better)"
systemd-analyze security --no-pager viewer-server viewer-caddy 2>/dev/null | tail -3 || true

if [[ $failed -gt 0 ]]; then
  journalctl -u viewer-server -u viewer-caddy -u viewer-backup -n 80 --no-pager | grep -v '"msg":"\(incoming request\|request completed\)"' || true
  echo "$failed FAILED"; exit 1
fi
echo "ALL PASSED"
