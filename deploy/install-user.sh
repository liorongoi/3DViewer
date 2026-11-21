#!/usr/bin/env bash
# HOLO server: install or upgrade in your home folder, with no root and no admin rights.
#
#   ./install-user.sh                    install in ~/holo and start; prints the address
#   ./install-user.sh --dir /data/holo   somewhere else (a folder you can write to)
#   ./install-user.sh --port 9000        the web address's port (default 8080, or the next free one)
#   ./install-user.sh --cert chain.pem --key key.pem [--host holo.example]   HTTPS on port 8443
#   ./install-user.sh --database-url postgres://...   a PostgreSQL database instead of the built-in one
#   ./install-user.sh --no-start         only copy the files
#
# Run it from the unpacked bundle, as yourself (not with sudo). Running it again is safe: it keeps
# your settings and data, and installs a newer bundle beside the old one. If the new one does not
# start, it goes back to the old one by itself. Afterwards, the `holo` command runs everything:
# holo status, holo stop, holo start, holo check, holo logs, holo backup (docs/INSTALL.md).
set -euo pipefail
umask 077

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/holo" PORT="" HOST_NAME="" DB_URL="" CERT="" KEY="" START=1

say() { echo "· $*"; }
warn() { echo "! $*" >&2; }
fail() { echo; echo "Stopped: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) D="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST_NAME="$2"; shift 2 ;;
    --database-url) DB_URL="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (./install-user.sh --help lists them)" ;;
  esac
done

[[ $EUID -ne 0 ]] || fail "run it as yourself, without sudo: ./install-user.sh (the site install for root is install.sh)"
[[ -f "$BUNDLE/VERSION" && -f "$BUNDLE/SHA256SUMS" ]] || fail "run this from the unpacked bundle folder"
[[ -z "$PORT" || ( "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ) ]] || fail "--port must be a number from 1024 to 65535 (lower ports need root)"
[[ -z "$CERT$KEY" || ( -r "$CERT" && -r "$KEY" ) ]] || fail "--cert and --key must both name files you can read"
D="$(mkdir -p "$D" && cd "$D" && pwd)" || fail "cannot create $D"
[[ -w "$D" ]] || fail "you cannot write to $D; choose another folder with --dir"

VERSION="$(awk '/^viewer /{print $2}' "$BUNDLE/VERSION")"
echo "HOLO $VERSION: installing in $D"
echo

# --- The machine ---------------------------------------------------------------------------------
"$BUNDLE/deploy/bin/holo-check" "$D" || { [[ $? -eq 1 ]] || fail "this machine cannot run HOLO (see above)"; }
echo

say "checking the download"
(cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS) || fail "the download is damaged; copy the .tar.gz again"

busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
free_port() { local p="$1"; while busy "$p"; do p=$((p + 1)); (( p > $1 + 50 )) && return 1; done; echo "$p"; }

# --- Folders and files ---------------------------------------------------------------------------
mkdir -p "$D/releases" "$D/settings" "$D/data" "$D/logs" "$D/backups" "$D/run"
chmod 700 "$D/settings"
dest="$D/releases/$VERSION"
in_use() { [[ -L "$D/current" ]] && readlink -e "$D/current" || true; }
switch_to() { ln -sfn "$1" "$D/current.new" && mv -Tf "$D/current.new" "$D/current"; }
if [[ "$(in_use)" == "$dest" ]]; then
  say "$VERSION is already installed; checking settings"
else
  say "copying the program"
  rm -rf "$dest.partial" "$dest"
  cp -a "$BUNDLE" "$dest.partial"
  chmod -R go-w "$dest.partial"
  mv "$dest.partial" "$dest"
fi

# --- Settings, written once ----------------------------------------------------------------------
ENV="$D/settings/viewer.env" CENV="$D/settings/caddy.env"
setting() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -1; }
if [[ ! -f "$ENV" ]]; then
  say "writing the settings"
  api="$(free_port 8787)" || fail "no free port near 8787 for the server"
  pw="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  sed -e "s|^DATA_DIR=.*|DATA_DIR=$D/data|" \
      -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$pw|" \
      -e "s|^PORT=.*|PORT=$api|" \
      -e "s|^FBX2GLTF=.*|FBX2GLTF=$D/current/bin/FBX2glTF|" \
      -e "s|^CONVERT_SANDBOX=.*|CONVERT_SANDBOX=none|" \
      "$dest/deploy/viewer.env.example" > "$ENV"
  if [[ -n "$DB_URL" ]]; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" "$ENV"
  else
    sed -i 's|^DATABASE_URL=.*|# DATABASE_URL= (not used: the built-in database, EMBEDDED_DB=1 below)|' "$ENV"
    printf '\n# Added by install-user.sh: the built-in database, kept in DATA_DIR. One server, no PostgreSQL to run.\nEMBEDDED_DB=1\n' >> "$ENV"
  fi
  command -v clamdscan >/dev/null || sed -i 's|^CLAMDSCAN=|# CLAMDSCAN=|' "$ENV"
  chromium="$(command -v chromium chromium-browser google-chrome 2>/dev/null | head -1 || true)"
  [[ -n "$chromium" ]] && sed -i "s|^# CHROMIUM=.*|CHROMIUM=$chromium|" "$ENV"
  echo "$pw" > "$D/settings/first-admin-password"
  NEW_PASSWORD="$pw"
fi
if [[ ! -f "$CENV" ]]; then
  api="$(setting PORT "$ENV")"
  if [[ -n "$CERT" ]]; then
    cp "$CERT" "$D/settings/tls-chain.pem"; cp "$KEY" "$D/settings/tls.key"
    web="${PORT:-$(free_port 8443)}" || fail "no free port near 8443"
    http="$(free_port 8080)" || fail "no free port near 8080"
    cat > "$CENV" <<EOF
# HOLO front end (Caddy), HTTPS. Written by install-user.sh; deploy/caddy/README.md explains each value.
CADDY_CONFIG=Caddyfile
VIEWER_HOST=${HOST_NAME:-$(hostname -f 2>/dev/null || hostname)}
TLS_CERT=$D/settings/tls-chain.pem
TLS_KEY=$D/settings/tls.key
HTTP_PORT=$http
HTTPS_PORT=$web
EOF
  else
    web="${PORT:-$(free_port 8080)}" || fail "no free port near 8080"
    cat > "$CENV" <<EOF
# HOLO front end (Caddy), plain HTTP. Written by install-user.sh; deploy/caddy/README.md explains each value.
# For HTTPS, run install-user.sh with --cert and --key after removing this file.
CADDY_CONFIG=Caddyfile.user
HTTP_PORT=$web
EOF
  fi
  cat >> "$CENV" <<EOF
WEB_ROOT=$D/current/web
FILES_ROOT=$D/data/storage/files
BASEMAP_ROOT=$D/data/basemaps
API_UPSTREAM=127.0.0.1:$api
LOG_DIR=$D/logs
EOF
fi
mkdir -p "$D/data/basemaps" "$D/data/storage/files"
chmod 600 "$D"/settings/*

# --- The holo command ----------------------------------------------------------------------------
cat > "$D/holo" <<EOF
#!/usr/bin/env bash
# Written by install-user.sh: runs the holo command of the version in use.
exec "$D/current/deploy/bin/holo" --home "$D" "\$@"
EOF
chmod 700 "$D/holo"
mkdir -p "$HOME/.local/bin"
ln -sfn "$D/holo" "$HOME/.local/bin/holo"

# --- Switch to this version and start ------------------------------------------------------------
prev="$(in_use)"
if [[ "$prev" != "$dest" ]]; then
  switch_to "$dest"
  [[ -n "$prev" && -d "$prev" ]] && echo "$prev" > "$D/releases/previous"
fi
"$D/holo" setup-services

if [[ $START -eq 0 ]]; then
  say "installed (not started: --no-start). Start it with: holo start"
  exit 0
fi
say "starting"
if ! "$D/holo" restart >/dev/null; then
  warn "HOLO did not start. Its last messages:"
  "$D/holo" logs 20 >&2 || true
  if [[ -n "$prev" && -d "$prev" && "$prev" != "$dest" ]]; then
    warn "going back to the version you had: $(basename "$prev")"
    switch_to "$prev"
    "$D/holo" restart || warn "that did not start either: holo logs shows why"
  fi
  exit 1
fi

# Keep the three newest versions.
ls -1dt "$D"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$(in_use)/" == "$old" || "$(cat "$D/releases/previous" 2>/dev/null)/" == "$old" ]] || rm -rf "$old"
done

echo
echo "HOLO $VERSION is running."
"$D/holo" address
if [[ -n "${NEW_PASSWORD:-}" ]]; then
  echo
  echo "  Sign in as admin with this password: $NEW_PASSWORD"
  echo "  (it is also in $D/settings/first-admin-password; change it on the admin page, then delete that file)"
fi
echo
echo "  The holo command: holo status, holo stop, holo start, holo check, holo logs, holo backup, holo help"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  (open a new terminal first, or type ~/.local/bin/holo)";; esac
