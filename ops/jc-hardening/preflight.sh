#!/usr/bin/env bash
# Read-only preflight for the canonical Jace Commander service set. Fails closed: any failed check exits non-zero.
# It never prints a secret value. Credential separation is checked by key presence and SHA-256 digest comparison.
#
#   preflight.sh [--secrets DIR] [--policy PATH] [--units DIR]
#
# Defaults: --secrets /etc/acs-secrets, --policy /etc/acs-secrets/policy.json (see docs/jace-commander-service-isolation.md),
# --units <this script's directory>. Tests point --secrets at a fixture directory.
set -u

SECRETS=/etc/acs-secrets
POLICY=""
UNITS="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --secrets) SECRETS="$2"; shift 2 ;;
    --policy) POLICY="$2"; shift 2 ;;
    --units) UNITS="$2"; shift 2 ;;
    *) echo "preflight: unknown argument" >&2; exit 2 ;;
  esac
done
[ -n "$POLICY" ] || POLICY="$SECRETS/policy.json"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

# value_of FILE KEY -> the value after KEY= (first match). Callers compare digests; the value is never printed.
value_of() {
  local line
  line="$(grep -m1 -E "^$2=" "$1" 2>/dev/null)" || return 1
  printf '%s' "${line#"$2="}"
}
digest() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
has_key() { grep -q -E "^$2=" "$1" 2>/dev/null; }

EDGE_ENV="$SECRETS/acs-edge.env"       # OAuth gateway
BRIDGE_ENV="$SECRETS/acs-jc.env"       # MCP bridge
INGRESS_ENV="$SECRETS/acs-ingress.env" # public ingress (no secrets)
UNIT_DIR="$UNITS"
RETIRED_KEY=DC_GATEWAY_ATTESTATION_KEY

# 1. Secret files exist, are not symlinks, and are no more permissive than 0640.
for f in "$EDGE_ENV" "$BRIDGE_ENV" "$INGRESS_ENV"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then pass "file present: $(basename "$f")"; else fail "file missing or symlink: $(basename "$f")"; continue; fi
  mode="$(stat -c '%a' "$f" 2>/dev/null)"
  # No group write or execute, and no bits at all for other.
  if [ -n "$mode" ] && [ $((8#$mode & 0027)) -eq 0 ]; then
    pass "mode $mode: $(basename "$f")"
  else
    fail "mode ${mode:-unknown} is more permissive than 0640: $(basename "$f")"
  fi
done

# 2. Each process holds only its own secrets.
for key in ACS_JC_GATEWAY_TOKEN SIGNING_KEY CONSENT_PASSPHRASE GATEWAY_EXECUTION_TOKEN ACS_GATEWAY_TOKEN; do
  if has_key "$BRIDGE_ENV" "$key"; then fail "bridge env holds $key (the bridge must not)"; else pass "bridge env excludes $key"; fi
done
if has_key "$EDGE_ENV" ACS_WORKER_TOKEN || has_key "$EDGE_ENV" DC_GATEWAY_ATTESTATION_SIGNING_KEY; then
  fail "gateway env holds the bridge ACS worker token or the Ed25519 SIGNING key (the gateway must not)"
else
  pass "gateway env excludes the bridge ACS worker token and the Ed25519 signing key"
fi
if has_key "$INGRESS_ENV" SIGNING_KEY || has_key "$INGRESS_ENV" CONSENT_PASSPHRASE || has_key "$INGRESS_ENV" GATEWAY_EXECUTION_TOKEN \
  || has_key "$INGRESS_ENV" DC_GATEWAY_EXECUTION_TOKEN || has_key "$INGRESS_ENV" ACS_JC_GATEWAY_TOKEN \
  || has_key "$INGRESS_ENV" ACS_WORKER_TOKEN || has_key "$INGRESS_ENV" DC_GATEWAY_ATTESTATION_SIGNING_KEY; then
  fail "ingress env holds a secret (the public ingress must hold none)"
else
  pass "ingress env holds no secrets"
fi
for f in "$EDGE_ENV" "$BRIDGE_ENV" "$INGRESS_ENV"; do
  if has_key "$f" "$RETIRED_KEY"; then fail "$(basename "$f") still sets the retired shared attestation key (remove it)"; fi
done
pass "no env file sets the retired shared attestation key"

# 3. The attestation secret is shared by gateway and bridge; the two ACS identities are distinct.
edge_att="$(value_of "$EDGE_ENV" GATEWAY_EXECUTION_TOKEN)"
bridge_att="$(value_of "$BRIDGE_ENV" DC_GATEWAY_EXECUTION_TOKEN)"
if [ -z "$edge_att" ] || [ -z "$bridge_att" ]; then
  fail "attestation secret missing from the gateway env or the bridge env"
elif [ "$(digest "$edge_att")" = "$(digest "$bridge_att")" ]; then
  pass "attestation secret matches gateway and bridge"
else
  fail "attestation secret differs between the gateway env and the bridge env"
fi
edge_acs="$(value_of "$EDGE_ENV" ACS_JC_GATEWAY_TOKEN)"
bridge_acs="$(value_of "$BRIDGE_ENV" ACS_WORKER_TOKEN)"
if [ -n "$edge_acs" ] && [ -n "$bridge_acs" ] && [ "$(digest "$edge_acs")" = "$(digest "$bridge_acs")" ]; then
  fail "gateway ACS token equals the bridge ACS worker token (ACS identities must differ)"
else
  pass "ACS gateway and bridge identities are distinct"
fi
unset edge_att bridge_att edge_acs bridge_acs

# 4. Required values are present (presence only, no values).
for key in SIGNING_KEY CONSENT_PASSPHRASE GATEWAY_EXECUTION_TOKEN ACS_JC_GATEWAY_TOKEN; do
  if has_key "$EDGE_ENV" "$key"; then pass "gateway env has $key"; else fail "gateway env missing $key"; fi
done
for key in DC_GATEWAY_EXECUTION_TOKEN DC_GATEWAY_ATTESTATION_SIGNING_KEY JC_ACS_PUBLIC_KEY; do
  if has_key "$BRIDGE_ENV" "$key"; then pass "bridge env has $key"; else fail "bridge env missing $key"; fi
done

# 5. Policy: a configured policy must exist, be a regular file, and be unwritable by any service identity.
if [ -f "$POLICY" ] && [ ! -L "$POLICY" ]; then
  pass "policy present: $POLICY"
  owner="$(stat -c '%u' "$POLICY")"
  pmode="$(stat -c '%a' "$POLICY")"
  if [ "$owner" = "0" ]; then pass "policy owned by root"; else fail "policy owned by uid $owner (must be root)"; fi
  if [ $((8#$pmode & 0022)) -ne 0 ]; then
    fail "policy mode $pmode is group- or world-writable"
  else
    pass "policy mode $pmode is not group- or world-writable"
  fi
  dir="$(dirname "$POLICY")"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    dmode="$(stat -c '%a' "$dir" 2>/dev/null)"
    downer="$(stat -c '%u' "$dir" 2>/dev/null)"
    if [ "$downer" != "0" ] || [ "$((8#${dmode:-777} & 0022))" -ne 0 ]; then
      fail "policy directory $dir is not root-owned or is writable by others"
      break
    fi
    dir="$(dirname "$dir")"
  done
  [ "$dir" = "/" ] && pass "policy directory chain is root-owned and not writable by others"
else
  fail "policy missing or a symlink: $POLICY (the local preset would otherwise default to uniform local)"
fi

# 6. Service identities exist and are not login accounts.
for user in acs-ingress acs-edge acs-jc acs-jc-exec; do
  if id -u "$user" >/dev/null 2>&1; then
    shell="$(getent passwd "$user" | cut -d: -f7)"
    case "$shell" in
      */nologin|*/false) pass "identity $user exists, no login shell" ;;
      *) fail "identity $user has login shell $shell" ;;
    esac
  else
    fail "identity $user does not exist (run migrate-acs-jc-identities.sh)"
  fi
done

# 7. Units verify, and the static wiring is the canonical one.
for unit in acs-jc-public-ingress acs-jc-edge acs-jc-bridge; do
  if [ -f "$UNIT_DIR/$unit.service" ] && systemd-analyze verify --man=no "$UNIT_DIR/$unit.service" >/dev/null 2>&1; then
    pass "unit verifies: $unit"
  else
    fail "unit missing or fails verification: $unit"
  fi
done
if grep -q -- "--reuid=acs-jc-exec" "$UNIT_DIR/acs-jc-bridge.service" 2>/dev/null; then
  pass "executor is dropped to acs-jc-exec, not the bridge uid"
else
  fail "bridge unit does not drop the executor to acs-jc-exec"
fi
if grep -q '^ExecStart=.*edge/ingress\.js' "$UNIT_DIR/acs-jc-public-ingress.service" 2>/dev/null; then
  pass "public ingress runs the hardened edge/ingress.js"
else
  fail "public ingress unit does not run edge/ingress.js"
fi
if grep -q "$RETIRED_KEY" "$UNIT_DIR"/acs-jc-*.service 2>/dev/null; then
  fail "a unit references the retired shared attestation key"
else
  pass "no unit references the retired shared attestation key"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "preflight: PASS (all checks)"
  exit 0
fi
echo "preflight: FAIL ($FAILS check(s) failed). Do not start the services."
exit 1
