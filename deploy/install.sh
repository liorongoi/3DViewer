#!/usr/bin/env bash
# VIEWER server: install or upgrade from the offline bundle (WP 5.6, docs/INSTALL.md).
#
#   sudo ./install.sh [--host viewer.internal] [--database-url postgres://...] \
#                     [--cert chain.pem --key key.pem] [--no-start]
#   sudo ./install.sh --rollback        back to the version installed before this one
#
# Run from the unpacked bundle. It is safe to run again: settings in /etc/viewer are never
# overwritten, only created when missing. Each version goes to /opt/viewer-releases/<version>
# and /opt/viewer points at the one in use, so an upgrade switches in one step and a failed
# start switches back by itself.
set -euo pipefail
umask 022

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
RELEASES=/opt/viewer-releases
CURRENT=/opt/viewer
ETC=/etc/viewer
DATA=/var/lib/viewer
HOST_NAME="" DB_URL="" CERT="" KEY="" START=1 ROLLBACK=0

say() { echo "· $*"; }
warn() { echo "! $*" >&2; }
fail() { echo "install.sh: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST_NAME="$2"; shift 2 ;;
    --database-url) DB_URL="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "run as root (sudo ./install.sh)"
[[ "$(uname -m)" == x86_64 ]] || fail "this bundle is for x86-64 Linux"
if [[ $START -eq 1 ]]; then
  [[ -d /run/systemd/system ]] || fail "systemd is not running; use --no-start to only install the files"
fi

port_of() { local p; p="$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ETC/viewer.env" 2>/dev/null | tail -1)"; echo "${p:-8787}"; }

# Starts the server and the front end, and waits for the server to answer.
start_services() {
  systemctl daemon-reload
  systemctl enable viewer-server viewer-caddy viewer-backup.timer >/dev/null
  systemctl restart viewer-server
  local port; port="$(port_of)"
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true'; then
      systemctl restart viewer-caddy
      systemctl start viewer-backup.timer
      return 0
    fi
    if ! systemctl is-active --quiet viewer-server && [[ "$(systemctl show -p ExecMainStatus --value viewer-server)" == 78 ]]; then break; fi
    sleep 1
  done
  return 1
}

switch_to() { ln -sfn "$1" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"; }
# The release folder /opt/viewer points at, or nothing on a first install.
in_use() { [[ -L "$CURRENT" ]] && readlink -e "$CURRENT" || true; }

if [[ $ROLLBACK -eq 1 ]]; then
  prev="$(cat "$RELEASES/previous" 2>/dev/null || true)"
  [[ -n "$prev" && -d "$prev" ]] || fail "there is no earlier version to go back to"
  cur="$(in_use)"
  say "going back to $(basename "$prev")"
  switch_to "$prev"
  install -m 0644 "$prev"/deploy/systemd/* /etc/systemd/system/
  echo "$cur" > "$RELEASES/previous"
  [[ $START -eq 1 ]] && { start_services || fail "the earlier version did not start: journalctl -u viewer-server"; }
  say "done"
  exit 0
fi

# --- The bundle itself -------------------------------------------------------------------------
[[ -f "$BUNDLE/VERSION" && -f "$BUNDLE/SHA256SUMS" ]] || fail "run this from the unpacked bundle"
say "checking the bundle"
(cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS) || fail "the bundle is damaged (SHA256SUMS does not match); copy it again"
VERSION="$(awk '/^viewer /{print $2}' "$BUNDLE/VERSION")"
say "VIEWER $VERSION"

# --- What the operating system must provide ----------------------------------------------------
command -v curl >/dev/null || fail "curl is needed"
command -v pg_dump >/dev/null || warn "pg_dump is not installed: install the PostgreSQL client (same major version as the database or newer) for backups"
command -v clamdscan >/dev/null || warn "clamdscan is not installed: uploads will be published as \"not scanned\""
chromium="$(command -v chromium chromium-browser google-chrome 2>/dev/null | head -1 || true)"
[[ -n "$chromium" ]] || warn "Chromium is not installed: the library shows models without thumbnails"

# --- User and folders --------------------------------------------------------------------------
if ! id viewer >/dev/null 2>&1; then
  say "creating the user viewer"
  useradd --system --home "$DATA" --shell /usr/sbin/nologin viewer
fi
install -d -o viewer -g viewer -m 0750 "$DATA" "$DATA/caddy" /var/log/viewer /var/backups/viewer
install -d -o root -g viewer -m 0750 "$DATA/basemaps"
install -d -o root -g viewer -m 0750 "$ETC" "$ETC/tls"
install -d -o root -g root -m 0755 "$RELEASES"

# --- Files ------------------------------------------------------------------------------------
dest="$RELEASES/$VERSION"
if [[ "$(in_use)" == "$dest" ]]; then
  say "$VERSION is already installed; checking settings and services"
else
  say "copying to $dest"
  rm -rf "$dest.partial"
  cp -a "$BUNDLE" "$dest.partial"
  chown -R root:root "$dest.partial"
  chmod -R go-w "$dest.partial"
  rm -rf "$dest"
  mv "$dest.partial" "$dest"
fi

# --- Settings, created once ---------------------------------------------------------------------
secret() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24; }
if [[ ! -f "$ETC/viewer.env" ]]; then
  say "writing $ETC/viewer.env"
  pw="$(secret)"
  sed -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$pw|" \
      -e "s|^FBX2GLTF=.*|FBX2GLTF=$CURRENT/bin/FBX2glTF|" \
      "$dest/deploy/viewer.env.example" > "$ETC/viewer.env"
  [[ -n "$DB_URL" ]] && sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" "$ETC/viewer.env"
  command -v clamdscan >/dev/null || sed -i 's|^CLAMDSCAN=|# CLAMDSCAN=|' "$ETC/viewer.env"
  if [[ -n "$chromium" ]]; then
    sed -i -e "s|^# CHROMIUM=.*|CHROMIUM=$chromium|" -e "s|^# THUMBNAIL_WEB_URL=.*|THUMBNAIL_WEB_URL=https://${HOST_NAME:-$(hostname -f)}/|" "$ETC/viewer.env"
  fi
  # The first admin password: shown once here and kept for root only until the admin changes it.
  install -m 0600 -o root -g root /dev/null "$ETC/first-admin-password"
  echo "$pw" > "$ETC/first-admin-password"
  echo "  First admin password: $pw  (also in $ETC/first-admin-password; delete it after signing in)"
fi
if [[ ! -f "$ETC/caddy.env" ]]; then
  say "writing $ETC/caddy.env"
  sed -e "s|^VIEWER_HOST=.*|VIEWER_HOST=${HOST_NAME:-$(hostname -f)}|" \
      -e "s|^WEB_ROOT=.*|WEB_ROOT=$CURRENT/web|" \
      "$dest/deploy/caddy.env.example" > "$ETC/caddy.env"
fi
if [[ -n "$CERT" || -n "$KEY" ]]; then
  [[ -f "$CERT" && -f "$KEY" ]] || fail "--cert and --key must both name files"
  say "installing the certificate"
  install -m 0640 -o root -g viewer "$CERT" "$ETC/tls/viewer-chain.pem"
  install -m 0640 -o root -g viewer "$KEY" "$ETC/tls/viewer.key"
fi
chown root:viewer "$ETC"/*.env && chmod 0640 "$ETC"/*.env

# --- Services and tools -------------------------------------------------------------------------
install -m 0644 "$dest"/deploy/systemd/* /etc/systemd/system/
for t in viewer-backup viewer-restore viewer-basemap-install; do ln -sfn "$CURRENT/deploy/bin/$t" "/usr/local/sbin/$t"; done

# --- Ready to start? ---------------------------------------------------------------------------
missing=()
grep -q '^DATABASE_URL=.*CHANGE-ME' "$ETC/viewer.env" && missing+=("DATABASE_URL in $ETC/viewer.env")
. <(grep -E '^(TLS_CERT|TLS_KEY)=' "$ETC/caddy.env")
[[ -r "${TLS_CERT:-}" ]] || missing+=("the certificate ${TLS_CERT:-TLS_CERT} (--cert)")
[[ -r "${TLS_KEY:-}" ]] || missing+=("the key ${TLS_KEY:-TLS_KEY} (--key)")

prev="$(in_use)"
before="$(cat "$RELEASES/previous" 2>/dev/null || true)"
if [[ "$prev" != "$dest" ]]; then
  switch_to "$dest"
  [[ -n "$prev" && -d "$prev" ]] && echo "$prev" > "$RELEASES/previous"
fi

if [[ $START -eq 0 ]]; then
  say "installed $VERSION (not started: --no-start)"
elif [[ ${#missing[@]} -gt 0 ]]; then
  say "installed $VERSION, not started yet. Fill in, then run this again:"
  for m in "${missing[@]}"; do echo "    - $m"; done
else
  say "starting"
  if ! start_services; then
    warn "the server did not start. Its last messages:"
    journalctl -u viewer-server -n 20 --no-pager >&2 || true
    if [[ -n "$prev" && -d "$prev" && "$prev" != "$dest" ]]; then
      warn "going back to $(basename "$prev")"
      switch_to "$prev"
      install -m 0644 "$prev"/deploy/systemd/* /etc/systemd/system/
      # As if this version had never been installed: the one to go back to stays the same.
      if [[ -n "$before" ]]; then echo "$before" > "$RELEASES/previous"; else rm -f "$RELEASES/previous"; fi
      rm -rf "$dest"
      start_services || warn "$(basename "$prev") did not start either: journalctl -u viewer-server"
    fi
    exit 1
  fi
  . <(grep -E '^(VIEWER_HOST|HTTPS_PORT)=' "$ETC/caddy.env")
  say "VIEWER $VERSION is running: https://$VIEWER_HOST${HTTPS_PORT:+:$HTTPS_PORT}/"
fi

# Keep the three newest versions.
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$(in_use)/" == "$old" || "$(cat "$RELEASES/previous" 2>/dev/null)/" == "$old" ]] || rm -rf "$old"
done
