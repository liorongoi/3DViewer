#!/usr/bin/env bash
# WP 5.6: the offline server bundle. One archive with everything a site server needs that is not
# part of the operating system, so it installs on the internal network with no internet:
#
#   node/          Node.js (the version in .nvmrc, official linux-x64 build, checksum verified)
#   bin/caddy      Caddy (official build, checksum verified)
#   bin/FBX2glTF   the FBX converter (from the fbx2gltf package, as the desktop app)
#   server/        the API server with its production packages
#   web/           the web app (without the sample data)
#   deploy/        systemd units, Caddy config, settings templates, backup, restore, base maps
#   docs/          INSTALL.md and OPERATIONS.md
#   install.sh     installs or upgrades it (docs/INSTALL.md)
#   VERSION, SHA256SUMS
#
# Run on an internet-connected build machine after `pnpm install --frozen-lockfile` and
# `pnpm -r run build`:
#   bash scripts/build-server-bundle.sh            -> out/viewer-server-<version>-linux-x64.tar.gz
# VIEWER_VERSION sets the version (default: git describe). NODE_VERSION and CADDY_VERSION pin
# the runtimes (defaults below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VIEWER_VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
CADDY_VERSION="${CADDY_VERSION:-2.10.2}"
NODE_MAJOR="$(tr -d 'v \n' < "$ROOT/.nvmrc")"
NAME="viewer-server-$VERSION-linux-x64"
OUT="$ROOT/out"
STAGE="$OUT/$NAME"
DL="$OUT/.downloads"

fail() { echo "build-server-bundle: $*" >&2; exit 1; }
[[ -f "$ROOT/apps/server/dist/main.js" ]] || fail "build first: pnpm -r run build"
[[ -f "$ROOT/apps/web/dist/index.html" ]] || fail "build first: pnpm -r run build"
rm -rf "$STAGE" "$OUT/$NAME.tar.gz"
mkdir -p "$STAGE/bin" "$DL"

# --- Node.js ---------------------------------------------------------------------------------
if [[ -z "${NODE_VERSION:-}" ]]; then
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | node -e "
    const all = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const v = all.find((r) => r.version.startsWith('v$NODE_MAJOR.'));
    if (!v) process.exit(1);
    process.stdout.write(v.version);")" || fail "no Node.js $NODE_MAJOR release found"
fi
node_tar="node-$NODE_VERSION-linux-x64.tar.xz"
echo "· Node.js $NODE_VERSION"
[[ -f "$DL/$node_tar" ]] || curl -fsSL -o "$DL/$node_tar" "https://nodejs.org/dist/$NODE_VERSION/$node_tar"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $node_tar\$" | (cd "$DL" && sha256sum -c --quiet -) || fail "Node.js checksum does not match"
mkdir -p "$STAGE/node"
tar -xJf "$DL/$node_tar" -C "$STAGE/node" --strip-components=1
# Only the runtime: npm and the headers are not needed on the server.
rm -rf "$STAGE/node/include" "$STAGE/node/share" "$STAGE/node/lib/node_modules" "$STAGE/node/bin/npm" "$STAGE/node/bin/npx" "$STAGE/node/bin/corepack"

# --- Caddy -----------------------------------------------------------------------------------
caddy_tar="caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
echo "· Caddy $CADDY_VERSION"
base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
[[ -f "$DL/$caddy_tar" ]] || curl -fsSL -o "$DL/$caddy_tar" "$base/$caddy_tar"
curl -fsSL "$base/caddy_${CADDY_VERSION}_checksums.txt" | grep "  $caddy_tar\$" | sed 's/^\([0-9a-f]*\) .*/\1/' > "$DL/caddy.sha512"
[[ "$(sha512sum "$DL/$caddy_tar" | cut -d' ' -f1)" == "$(cat "$DL/caddy.sha512")" ]] || fail "Caddy checksum does not match"
tar -xzf "$DL/$caddy_tar" -C "$STAGE/bin" caddy

# --- FBX2glTF --------------------------------------------------------------------------------
echo "· FBX2glTF"
fbx="$(dirname "$(node -p "require.resolve('fbx2gltf/package.json', { paths: ['$ROOT/apps/desktop'] })")")"
install -m 0755 "$fbx/bin/Linux/FBX2glTF" "$STAGE/bin/FBX2glTF"

# --- Server, web app, deploy files, docs ----------------------------------------------------
echo "· server"
(cd "$ROOT" && pnpm --filter @viewer/server deploy --prod --legacy "$STAGE/server" >/dev/null)
rm -rf "$STAGE/server/src"
echo "· web app"
mkdir -p "$STAGE/web"
(cd "$ROOT/apps/web/dist" && tar --exclude=./samples -cf - .) | tar -xf - -C "$STAGE/web"
cp -r "$ROOT/deploy" "$STAGE/deploy"
mkdir -p "$STAGE/docs"
cp "$ROOT/docs/INSTALL.md" "$ROOT/docs/OPERATIONS.md" "$STAGE/docs/"
cp "$ROOT/THIRD_PARTY_LICENSES.md" "$STAGE/"
install -m 0755 "$ROOT/deploy/install.sh" "$STAGE/install.sh"
cat > "$STAGE/VERSION" <<EOF
viewer $VERSION
node $NODE_VERSION
caddy $CADDY_VERSION
built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
EOF
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

echo "· archive"
tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "Done: $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
