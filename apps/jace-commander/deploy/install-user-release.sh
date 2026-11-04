#!/usr/bin/env bash
# Install a native Jace Commander release for the CachyOS systemd user service.
#
#   apps/jace-commander/deploy/install-user-release.sh            # build + install
#   PREFIX=/some/dir apps/jace-commander/deploy/install-user-release.sh
#
# Layout: $PREFIX/releases/<version>-<commit>/ (read-only) and $PREFIX/current
# (atomically switched symlink). Point the bridge at it with
#   Environment=JC_RUNTIME_DIR=%h/.local/lib/jace-commander/current
# Keep $PREFIX outside JC_FS_ROOTS: workloads must never be able to alter the
# code that verifies capabilities and holds ACS credentials. Runtime
# dependencies only, freshly resolved from the registry (no Desktop Commander,
# no workspace packages). Rollback: re-point `current` at the previous release.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/lib/jace-commander}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP/../.." && pwd)"
NODE="${NODE:-/usr/bin/node}"

"$NODE" -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<24||(maj===24&&min<16)) { console.error("Node >= 24.16 required"); process.exit(1); }'
command -v bwrap >/dev/null || { echo "bubblewrap (bwrap) is required for workload isolation" >&2; exit 1; }

(cd "$REPO" && npm run build -w apps/jace-commander >/dev/null)
version="$("$NODE" -p "require('$APP/package.json').version")"
commit="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
release="$PREFIX/releases/$version-$commit"

case "$release/" in
  "$REPO"/*) echo "refusing to install inside the repository ($REPO)" >&2; exit 1 ;;
esac

if [ -e "$release" ]; then
  echo "release already installed: $release"
else
  staging="$(mktemp -d "$PREFIX/.staging-XXXXXX" 2>/dev/null || { mkdir -p "$PREFIX"; mktemp -d "$PREFIX/.staging-XXXXXX"; })"
  trap 'chmod -R u+w "$staging" 2>/dev/null; rm -r -f -- "$staging"' EXIT
  for entry in package.json dist deploy docs verify README.md; do
    [ -e "$APP/$entry" ] && cp -R "$APP/$entry" "$staging/"
  done
  rm -f "$staging/dist/.tsbuildinfo"
  (cd "$staging" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
  printf '{"version":"%s","commit":"%s","installedAt":"%s"}\n' "$version" "$commit" "$(date -u +%FT%TZ)" > "$staging/RELEASE.json"
  "$NODE" "$staging/dist/cli.js" version >/dev/null
  mkdir -p "$PREFIX/releases"
  mv "$staging" "$release"
  trap - EXIT
  # Immutable once installed (the owner can still chmod u+w deliberately).
  chmod -R a-w "$release"
fi

ln -sfn "$release" "$PREFIX/.current.tmp"
mv -T "$PREFIX/.current.tmp" "$PREFIX/current"
echo "installed: $release"
echo "current -> $(readlink "$PREFIX/current")"
echo "bridge:   Environment=JC_RUNTIME_DIR=$PREFIX/current"
