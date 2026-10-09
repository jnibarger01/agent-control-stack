#!/usr/bin/env bash
# Installs the Jace Commander privileged helper. Run from the repo root after
# `npm run build`, as root:
#
#   sudo ACS_JC_PUBLIC_KEY=... ACS_JC_KEY_ID=... JC_RUNTIME_ID=jc-jacen-ubuntu \
#        JC_AGENT_USER=jacen deploy/jace-commander/install-privileged-helper.sh
#
# Optional second trust anchor (ADR 0026): set BOTH of these to let a human-approved
# jc.local.v1 token from approverd authorize privileged_exec under the local preset.
#   JC_LOCAL_PUBLIC_KEY=<approverd public key>  JC_LOCAL_KEY_ID=<approverd key id>
# They are written to the root-owned config; the helper never reads them from the environment.
#
# Everything the helper executes or reads is copied to root-owned locations.
# Never point sudoers at code under a home directory: the agent user could
# edit it and become root without any approval.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
: "${ACS_JC_PUBLIC_KEY:?set ACS_JC_PUBLIC_KEY (base64url SPKI DER Ed25519 from ACS)}"
: "${ACS_JC_KEY_ID:?set ACS_JC_KEY_ID}"
: "${JC_RUNTIME_ID:?set JC_RUNTIME_ID (same value the MCP server uses)}"
AGENT_USER="${JC_AGENT_USER:-jacen}"
LOCAL_PUBLIC_KEY="${JC_LOCAL_PUBLIC_KEY:-}"
LOCAL_KEY_ID="${JC_LOCAL_KEY_ID:-}"
NODE_BIN="${JC_NODE_BIN:-/usr/bin/node}"
id "$AGENT_USER" >/dev/null
[[ "$ACS_JC_PUBLIC_KEY" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ACS_JC_PUBLIC_KEY must be base64url" >&2; exit 1; }
[[ "$ACS_JC_KEY_ID" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || { echo "invalid ACS_JC_KEY_ID" >&2; exit 1; }
[[ "$JC_RUNTIME_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || { echo "invalid JC_RUNTIME_ID" >&2; exit 1; }
if [[ -n "$LOCAL_PUBLIC_KEY$LOCAL_KEY_ID" ]]; then
  [[ -n "$LOCAL_PUBLIC_KEY" && -n "$LOCAL_KEY_ID" ]] || { echo "set JC_LOCAL_PUBLIC_KEY and JC_LOCAL_KEY_ID together" >&2; exit 1; }
  [[ "$LOCAL_PUBLIC_KEY" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "JC_LOCAL_PUBLIC_KEY must be base64url" >&2; exit 1; }
  [[ "$LOCAL_KEY_ID" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || { echo "invalid JC_LOCAL_KEY_ID" >&2; exit 1; }
  [[ "$LOCAL_PUBLIC_KEY" != "$ACS_JC_PUBLIC_KEY" && "$LOCAL_KEY_ID" != "$ACS_JC_KEY_ID" ]] || { echo "the local and ACS trust anchors must differ" >&2; exit 1; }
fi

# The interpreter is part of the trusted base: refuse a user-writable node (nvm, ~/.local).
node_real="$(readlink -f "$NODE_BIN")"
[[ "$(stat -c %u "$node_real")" == 0 ]] || { echo "$node_real is not root-owned; set JC_NODE_BIN to a root-owned node" >&2; exit 1; }
[[ $(( 0$(stat -c %a "$node_real") & 022 )) -eq 0 ]] || { echo "$node_real is group/world-writable" >&2; exit 1; }

# Build from a checkout the agent user cannot write to (or review dist/ first):
# whatever is in dist/ at install time becomes root-executed code.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/dist"
# Every file the helper's import graph reaches. tests/ verifies this list is a complete closure.
FILES=(managed-acs.js jace-commander/privileged-helper.js jace-commander/privileged-core.js jace-commander/contract.js jace-commander/local-token.js jace-commander/looptrace.js jace-commander/manifest.generated.js)
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f; run npm run build first" >&2; exit 1; }
done

install -d -o root -g root -m 0755 /opt/jace-commander /opt/jace-commander/dist /opt/jace-commander/dist/jace-commander
for f in "${FILES[@]}"; do install -o root -g root -m 0644 "$SRC/$f" "/opt/jace-commander/dist/$f"; done
printf '{"type":"module","private":true}\n' > /opt/jace-commander/package.json
chmod 0644 /opt/jace-commander/package.json

install -d -o root -g root -m 0755 /usr/local/libexec/jace-commander
# env -i: node honours NODE_OPTIONS/NODE_PATH etc.; never let a caller's
# environment (even one a future sudoers env_keep lets through) reach root node.
cat > /usr/local/libexec/jace-commander/jc-privileged-helper <<WRAP
#!/bin/sh
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 $node_real /opt/jace-commander/dist/jace-commander/privileged-helper.js
WRAP
chown root:root /usr/local/libexec/jace-commander/jc-privileged-helper
chmod 0755 /usr/local/libexec/jace-commander/jc-privileged-helper

install -d -o root -g root -m 0755 /etc/jace-commander
umask 077
LOCAL_JSON=""
if [[ -n "$LOCAL_PUBLIC_KEY" ]]; then
  LOCAL_JSON=$',\n  "localPublicKey": "'"$LOCAL_PUBLIC_KEY"$'",\n  "localKeyId": "'"$LOCAL_KEY_ID"'"'
fi
cat > /etc/jace-commander/privileged.json <<CFG
{
  "acsPublicKey": "$ACS_JC_PUBLIC_KEY",
  "acsKeyId": "$ACS_JC_KEY_ID",
  "runtimeId": "$JC_RUNTIME_ID",
  "nonceDir": "/var/lib/jace-commander/nonces",
  "auditPath": "/var/log/jace-commander/privileged-audit.jsonl",
  "maxTimeoutMs": 600000$LOCAL_JSON
}
CFG
chown root:root /etc/jace-commander/privileged.json
chmod 0644 /etc/jace-commander/privileged.json   # public key only; must not be writable by others
install -d -o root -g root -m 0700 /var/lib/jace-commander /var/lib/jace-commander/nonces /var/log/jace-commander

tmp="$(mktemp)"
sed "s/@AGENT_USER@/$AGENT_USER/" "$REPO/deploy/jace-commander/sudoers.jace-commander" > "$tmp"
visudo -cf "$tmp"
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/jace-commander
rm -f "$tmp"

echo "installed. verify as $AGENT_USER:  sudo -n -l /usr/local/libexec/jace-commander/jc-privileged-helper"
