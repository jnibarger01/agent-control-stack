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
# BEGIN node-version-check (#360 R/V F2): approverd and @simplewebauthn/server need Node >= 20.
node_major="$("$node_real" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 20 ]] || { echo "Node.js >= 20 is required; $node_real reports major version '${node_major:-unknown}'" >&2; exit 1; }
# END node-version-check

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/dist"
FILES=(managed-acs.js jace-commander/approval-protocol.js jace-commander/approverd-cli.js jace-commander/approverd.js jace-commander/contract.js jace-commander/local-token.js jace-commander/looptrace.js jace-commander/providers.js jace-commander/manifest.generated.js)
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
# Passkey approvals (docs/jace-commander-passkey-approvals.md) are REQUIRED for privileged approvals:
# approverd refuses to start without a `passkey` block unless JC_ALLOW_SELF_ASSERTED_PRIVILEGED=1 is set
# (an explicit opt-out that approverd records in its audit chain on every start).
PASSKEY_FILES=(jace-commander/passkey-verifier.js jace-commander/root-controlled-file.js)
for f in "${PASSKEY_FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f; run npm run build first" >&2; exit 1; }
  install -o root -g root -m 0644 "$SRC/$f" "/opt/jace-commander/dist/$f"
done
# Install the pinned WebAuthn library and its runtime dependency closure, root-owned, from the repo's
# node_modules (run `npm ci` first). Nothing is fetched from the network here.
WEBAUTHN_PKG=@simplewebauthn/server
WEBAUTHN_VERSION="$("$node_real" -e 'console.log(require(process.argv[1]).dependencies[process.argv[2]])' "$REPO/package.json" "$WEBAUTHN_PKG")"
mapfile -t WEBAUTHN_DIRS < <("$node_real" - "$REPO" "$WEBAUTHN_PKG" "$WEBAUTHN_VERSION" <<'JS'
const fs = require('node:fs'); const path = require('node:path');
const [repo, root, want] = process.argv.slice(2);
const find = (name, from) => { for (let d = from; ; d = path.dirname(d)) { const p = path.join(d, 'node_modules', name); if (fs.existsSync(path.join(p, 'package.json'))) return p; if (d === path.dirname(d)) return null; } };
const top = find(root, repo);
if (!top) { console.error(`missing ${root}; run npm ci first`); process.exit(1); }
const v = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).version;
if (v !== want) { console.error(`${root} is ${v}, expected pinned ${want}`); process.exit(1); }
// Mirror the resolved layout (nested copies included) under /opt/jace-commander/node_modules.
const marker = `${path.sep}node_modules${path.sep}`;
const base = top.slice(0, top.indexOf(marker) + marker.length - 1);
const seen = new Set(); const queue = [[root, top]];
while (queue.length) {
  const [name, dir] = queue.shift();
  if (seen.has(dir)) continue; seen.add(dir);
  if (!dir.startsWith(base + path.sep)) { console.error(`${name} resolves outside ${base}`); process.exit(1); }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) { const d = find(dep, dir); if (!d) { console.error(`missing dependency ${dep} of ${name}`); process.exit(1); } queue.push([dep, d]); }
}
for (const dir of seen) console.log(`${path.relative(base, dir)}\t${dir}`);
JS
)
[[ ${#WEBAUTHN_DIRS[@]} -gt 0 ]] || { echo "could not resolve $WEBAUTHN_PKG" >&2; exit 1; }
rm -rf /opt/jace-commander/node_modules
install -d -o root -g root -m 0755 /opt/jace-commander/node_modules
for entry in "${WEBAUTHN_DIRS[@]}"; do
  name="${entry%%$'\t'*}"; dir="${entry#*$'\t'}"
  [[ "$name" != /* && "$name" != *..* ]] || { echo "refusing package path $name" >&2; exit 1; }
  install -d -o root -g root -m 0755 "/opt/jace-commander/node_modules/$name"
  cp -R --no-preserve=ownership "$dir/." "/opt/jace-commander/node_modules/$name"
done
chown -R root:root /opt/jace-commander/node_modules
chmod -R u=rwX,go=rX /opt/jace-commander/node_modules
installed="$("$node_real" -e 'console.log(require(process.argv[1]).version)' "/opt/jace-commander/node_modules/$WEBAUTHN_PKG/package.json")"
[[ "$installed" == "$WEBAUTHN_VERSION" ]] || { echo "installed $WEBAUTHN_PKG $installed != $WEBAUTHN_VERSION" >&2; exit 1; }
printf '{"type":"module","private":true}\n' > /opt/jace-commander/package.json
chmod 0644 /opt/jace-commander/package.json

install -d -o root -g root -m 0711 /var/lib/jace-commander
install -d -o jc-approverd -g jc-approverd -m 0700 /var/lib/jace-commander/approverd /var/lib/jace-commander/approverd-key
install -d -o root -g root -m 0755 /etc/jace-commander
PASSKEY_ANCHOR=/etc/jace-commander/passkeys.json
if [[ "${JC_ALLOW_SELF_ASSERTED_PRIVILEGED:-}" == 1 ]]; then
  echo "WARNING: JC_ALLOW_SELF_ASSERTED_PRIVILEGED=1: privileged approvals will be self-asserted (no passkey); approverd audits this on every start" >&2
  PASSKEY_JSON='"allowSelfAssertedPrivileged": true'
else
  PASSKEY_RP_ID="${JC_PASSKEY_RP_ID:-localhost}"
  PASSKEY_ORIGIN="${JC_PASSKEY_ORIGIN:-http://localhost:7391}"
  [[ "$PASSKEY_RP_ID" =~ ^[a-z0-9.-]{1,253}$ ]] || { echo "invalid JC_PASSKEY_RP_ID" >&2; exit 1; }
  [[ "$PASSKEY_ORIGIN" =~ ^https?://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo "invalid JC_PASSKEY_ORIGIN" >&2; exit 1; }
  PASSKEY_JSON="\"passkey\": { \"trustAnchorPath\": \"$PASSKEY_ANCHOR\", \"rpId\": \"$PASSKEY_RP_ID\", \"origin\": \"$PASSKEY_ORIGIN\" }"
  [[ -f "$PASSKEY_ANCHOR" ]] || echo "note: $PASSKEY_ANCHOR does not exist yet; privileged approvals fail closed until you register a passkey (jace-commander passkey-register)" >&2
fi
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
  "maxPending": 64,
  $PASSKEY_JSON
}
CFG
chown root:root /etc/jace-commander/approverd.json
chmod 0644 /etc/jace-commander/approverd.json

install -o root -g root -m 0644 "$REPO/deploy/jace-commander/jace-commander-approverd.service" /etc/systemd/system/jace-commander-approverd.service
# The unit ships with a PATH lookup; pin it to the node binary validated above. (ProtectHome=true
# means a node under /home cannot work, so refuse that up front.)
case "$node_real" in /home/*|/root/*|/run/user/*) echo "$node_real is under a path hidden by ProtectHome=true; use a system node via JC_NODE_BIN" >&2; exit 1 ;; esac
sed -i "s|^ExecStart=/usr/bin/env node |ExecStart=${node_real} |" /etc/systemd/system/jace-commander-approverd.service
grep -q "^ExecStart=${node_real} " /etc/systemd/system/jace-commander-approverd.service || { echo "failed to pin node in the unit" >&2; exit 1; }

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
