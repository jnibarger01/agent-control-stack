#!/usr/bin/env bash
# Installs approverd (ADR 0026 D4). Run from the repo root after `npm run build`, as root:
#
#   sudo JC_RUNTIME_ID=jc-local JC_SERVER_USER=jc JC_APPROVER_OPERATOR=jacen \
#        deploy/jace-commander/install-approverd.sh
#
# Creates three DISTINCT identities: the `jc` server account, the `jc-approverd` signer,
# and your login (added to `jc-approvers`, the only group that can reach decide.sock).
# Nothing here adds the server account to jc-approvers, and it must never be.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
: "${JC_RUNTIME_ID:?set JC_RUNTIME_ID (same value the MCP server uses)}"
SERVER_USER="${JC_SERVER_USER:-jc}"
OPERATOR="${JC_APPROVER_OPERATOR:?set JC_APPROVER_OPERATOR to the human login that may approve}"
NODE_BIN="${JC_NODE_BIN:-/usr/bin/node}"
KEY_ID="${JC_APPROVER_KEY_ID:-jc-approver-1}"
[[ "$JC_RUNTIME_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || { echo "invalid JC_RUNTIME_ID" >&2; exit 1; }
[[ "$KEY_ID" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || { echo "invalid JC_APPROVER_KEY_ID" >&2; exit 1; }
id "$OPERATOR" >/dev/null
[[ "$OPERATOR" != "$SERVER_USER" && "$OPERATOR" != "jc-approverd" ]] || { echo "operator, server and signer must be three different accounts" >&2; exit 1; }

node_real="$(readlink -f "$NODE_BIN")"
[[ "$(stat -c %u "$node_real")" == 0 ]] || { echo "$node_real is not root-owned" >&2; exit 1; }
[[ $(( 0$(stat -c %a "$node_real") & 022 )) -eq 0 ]] || { echo "$node_real is group/world-writable" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/dist"
FILES=(managed-acs.js jace-commander/approverd-cli.js jace-commander/approverd.js jace-commander/contract.js jace-commander/local-token.js jace-commander/looptrace.js jace-commander/providers.js jace-commander/manifest.generated.js)
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f; run npm run build first" >&2; exit 1; }
done

getent group jc >/dev/null || groupadd --system jc
getent group jc-approvers >/dev/null || groupadd --system jc-approvers
id "$SERVER_USER" >/dev/null 2>&1 || useradd --system --gid jc --home-dir "/home/$SERVER_USER" --create-home --shell /usr/sbin/nologin "$SERVER_USER"
id jc-approverd >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin jc-approverd
usermod -aG jc "$SERVER_USER"
usermod -aG jc,jc-approvers jc-approverd
usermod -aG jc-approvers "$OPERATOR"
# Guard the one property that matters: the server account must not be an approver.
if id -nG "$SERVER_USER" | tr ' ' '\n' | grep -qx jc-approvers; then
  echo "refusing: $SERVER_USER is a member of jc-approvers, so it could approve its own requests" >&2
  exit 1
fi

# Code approverd runs is root-owned: the agent must not be able to edit what holds the signing key.
install -d -o root -g root -m 0755 /opt/jace-commander /opt/jace-commander/dist /opt/jace-commander/dist/jace-commander
for f in "${FILES[@]}"; do install -o root -g root -m 0644 "$SRC/$f" "/opt/jace-commander/dist/$f"; done
printf '{"type":"module","private":true}\n' > /opt/jace-commander/package.json
chmod 0644 /opt/jace-commander/package.json

install -d -o jc-approverd -g jc-approverd -m 0700 /var/lib/jace-commander/approverd /var/lib/jace-commander/approverd-key
install -d -o root -g root -m 0755 /etc/jace-commander
umask 022
cat > /etc/jace-commander/approverd.json <<CFG
{
  "runtimeId": "$JC_RUNTIME_ID",
  "keyId": "$KEY_ID",
  "stateDir": "/var/lib/jace-commander/approverd",
  "keyPath": "/var/lib/jace-commander/approverd-key/approver.key",
  "requestSocket": "/run/jace-commander/request/request.sock",
  "decideSocket": "/run/jace-commander/decide/decide.sock",
  "requestGroup": "jc",
  "decideGroup": "jc-approvers",
  "approvalTtlMs": 900000,
  "tokenTtlMs": 25000,
  "maxPending": 64
}
CFG
chown root:root /etc/jace-commander/approverd.json
chmod 0644 /etc/jace-commander/approverd.json

install -o root -g root -m 0644 "$REPO/deploy/jace-commander/jace-commander-approverd.service" /etc/systemd/system/jace-commander-approverd.service

# Create the key as the signer and print ONLY the public half.
pub="$(runuser -u jc-approverd -- env -i PATH=/usr/bin:/bin "$node_real" /opt/jace-commander/dist/jace-commander/approverd-cli.js init --config /etc/jace-commander/approverd.json)"
systemctl daemon-reload
systemctl enable --now jace-commander-approverd.service

cat <<DONE

approverd installed. Log out and back in so "$OPERATOR" picks up the jc-approvers group.

Server environment (PUBLIC values only; add to the JC bridge env file):
  JC_APPROVER_SOCKET=/run/jace-commander/request/request.sock
  JC_APPROVER_KEY_ID=$KEY_ID
  JC_APPROVER_PUBLIC_KEY=$(printf '%s' "$pub" | "$node_real" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).publicKey))')

Operator environment (your login shell):
  export JC_APPROVER_DECIDE_SOCKET=/run/jace-commander/decide/decide.sock
  jace-commander pending            # list requests
  jace-commander approve <id>       # needs a real terminal

Verify the separation with: jace-commander doctor   (the 'local approver' check must pass)
DONE
