#!/usr/bin/env bash
# Read-only preflight for the hardened Jace Commander services. Fails closed: any failed check exits non-zero.
# It never prints a secret value. Credential separation is checked by comparing SHA-256 digests.
#
#   preflight.sh [--etc DIR] [--policy PATH] [--units DIR]
#
# Defaults: --etc /etc/jace-commander, --policy /etc/jace-commander/policy.json, --units <this script's dir>.
# Tests point --etc at a fixture directory. Run as root on the host for the ownership checks to be meaningful.
set -u

ETC=/etc/jace-commander
POLICY=""
UNITS="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --etc) ETC="$2"; shift 2 ;;
    --policy) POLICY="$2"; shift 2 ;;
    --units) UNITS="$2"; shift 2 ;;
    *) echo "preflight: unknown argument" >&2; exit 2 ;;
  esac
done
[ -n "$POLICY" ] || POLICY="$ETC/policy.json"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

# value_of FILE KEY -> the value after KEY= (first match), without printing it anywhere.
value_of() {
  local line
  line="$(grep -m1 -E "^$2=" "$1" 2>/dev/null)" || return 1
  printf '%s' "${line#"$2="}"
}
digest() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
has_key() { grep -q -E "^$2=" "$1" 2>/dev/null; }

GW_ENV="$ETC/gateway.env"
BR_ENV="$ETC/bridge.env"
EDGE_ENV="$ETC/edge.env"

# 1. Credential files exist, are not symlinks, and are not readable by others.
for f in "$GW_ENV" "$BR_ENV" "$EDGE_ENV"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then pass "file present: $(basename "$f")"; else fail "file missing or symlink: $(basename "$f")"; continue; fi
  mode="$(stat -c '%a' "$f" 2>/dev/null)"
  # Stricter than or equal to 0640: no group write or execute, and no bits at all for other.
  if [ -n "$mode" ] && [ $((8#$mode & 0027)) -eq 0 ]; then
    pass "mode $mode: $(basename "$f")"
  else
    fail "mode ${mode:-unknown} is not 0640 or stricter: $(basename "$f")"
  fi
done

# 2. Each process holds only its own credentials.
if has_key "$BR_ENV" ACS_JC_GATEWAY_TOKEN; then fail "bridge.env holds the gateway's ACS JC token (must not)"; else pass "bridge.env excludes ACS_JC_GATEWAY_TOKEN"; fi
if has_key "$BR_ENV" ACS_GATEWAY_TOKEN; then fail "bridge.env holds the gateway ACS token (must not)"; else pass "bridge.env excludes ACS_GATEWAY_TOKEN"; fi
if has_key "$GW_ENV" ACS_WORKER_TOKEN; then fail "gateway.env holds the bridge ACS worker token (must not)"; else pass "gateway.env excludes ACS_WORKER_TOKEN"; fi
if has_key "$EDGE_ENV" GATEWAY_EXECUTION_TOKEN || has_key "$EDGE_ENV" SIGNING_KEY || has_key "$EDGE_ENV" ACS_JC_GATEWAY_TOKEN || has_key "$EDGE_ENV" ACS_WORKER_TOKEN; then
  fail "edge.env holds a secret (the public edge must hold none)"
else
  pass "edge.env holds no secrets"
fi

# 3. Shared attestation secret matches between the gateway and the bridge; ACS tokens are distinct.
gw_exec="$(value_of "$GW_ENV" GATEWAY_EXECUTION_TOKEN)"
br_exec="$(value_of "$BR_ENV" DC_GATEWAY_EXECUTION_TOKEN)"
if [ -z "$gw_exec" ] || [ -z "$br_exec" ]; then
  fail "attestation secret missing from gateway.env or bridge.env"
elif [ "$(digest "$gw_exec")" = "$(digest "$br_exec")" ]; then
  pass "attestation secret matches gateway and bridge"
else
  fail "attestation secret differs between gateway.env and bridge.env"
fi
gw_acs="$(value_of "$GW_ENV" ACS_JC_GATEWAY_TOKEN)"
br_acs="$(value_of "$BR_ENV" ACS_WORKER_TOKEN)"
if [ -n "$gw_acs" ] && [ -n "$br_acs" ] && [ "$(digest "$gw_acs")" = "$(digest "$br_acs")" ]; then
  fail "gateway ACS token equals the bridge ACS worker token (ACS identities must differ)"
else
  pass "ACS gateway and bridge identities are distinct"
fi
unset gw_exec br_exec gw_acs br_acs

# 4. Required secrets are present (presence only, no values).
for key in SIGNING_KEY CONSENT_PASSPHRASE GATEWAY_EXECUTION_TOKEN ACS_JC_GATEWAY_TOKEN; do
  if has_key "$GW_ENV" "$key"; then pass "gateway.env has $key"; else fail "gateway.env missing $key"; fi
done
if has_key "$BR_ENV" DC_GATEWAY_EXECUTION_TOKEN && has_key "$BR_ENV" JC_ACS_PUBLIC_KEY; then
  pass "bridge.env has attestation secret and ACS public key"
else
  fail "bridge.env missing DC_GATEWAY_EXECUTION_TOKEN or JC_ACS_PUBLIC_KEY"
fi

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
for user in jc-edge jc-gateway jc-bridge jc-exec; do
  if id -u "$user" >/dev/null 2>&1; then
    shell="$(getent passwd "$user" | cut -d: -f7)"
    case "$shell" in
      */nologin|*/false) pass "identity $user exists, no login shell" ;;
      *) fail "identity $user has login shell $shell" ;;
    esac
  else
    fail "identity $user does not exist (run migrate-jc-identities.sh)"
  fi
done

# 7. Units verify and are present.
for unit in jace-commander-edge jace-commander-gateway jace-commander-bridge; do
  if [ -f "$UNITS/$unit.service" ] && systemd-analyze verify --man=no "$UNITS/$unit.service" >/dev/null 2>&1; then
    pass "unit verifies: $unit"
  else
    fail "unit missing or fails verification: $unit"
  fi
done

echo
if [ "$FAILS" -eq 0 ]; then
  echo "preflight: PASS (all checks)"
  exit 0
fi
echo "preflight: FAIL ($FAILS check(s) failed). Do not start the services."
exit 1
