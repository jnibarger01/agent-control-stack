#!/usr/bin/env bash
#
# Root-only verification of the local-preset systemd boundary.
#
# This proves the things a user-namespace approximation cannot:
#
#   * the unit file is root-owned and not writable by the service accounts;
#   * the bridge runs as jc-bridge and the executor as a DIFFERENT uid, with
#     the executor's supplementary groups initialized by setpriv;
#   * the executor holds no capabilities;
#   * the pinned release's own readiness probe (policy + bubblewrap self-test)
#     succeeds under the executor account;
#   * a real sandboxed workload can write its policy root but cannot write /,
#     /etc, read JC state or the bridge environment file, or escalate via
#     sudo/mount.
#
# It never changes host security settings. It only writes a temporary probe
# under the workspace (removed afterwards) and a canary in the JC state dir
# (removed afterwards).
#
# Usage (as root, on a DISPOSABLE installation):
#   ACS_VERIFY_DISPOSABLE=1 ./apps/dc-mcp-gateway/deploy/verify-local-preset-systemd.sh
#
# Exit codes: 0 all checks passed, 2 precondition failed, 3 a boundary check failed.
set -u

UNIT="${JC_UNIT:-jace-commander-mcp-local.service}"
BRIDGE_PORT="${JC_BRIDGE_PORT:-8003}"
BRIDGE_USER="${JC_EXPECT_BRIDGE_USER:-jc-bridge}"
EXEC_USER="${JC_EXPECT_EXEC_USER:-jc}"
EXEC_HOME="${JC_EXPECT_EXEC_HOME:-/home/jc}"
RELEASE_DIR="${JC_RELEASE_DIR:-/opt/jace-commander/current}"
STATE_DIR="${JC_STATE_DIR:-/var/lib/jace-commander-mcp/state}"
POLICY_PATH="${JC_POLICY_PATH:-/etc/jace-commander/policy.json}"
BRIDGE_ENV="${JC_BRIDGE_ENV:-/etc/jace-commander/bridge.env}"
WORKSPACE="${JC_WORKSPACE:-/home/jc/work}"

failures=0
precondition() {
  echo "PRECONDITION FAILED: $*" >&2
  exit 2
}
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }
check() {
  local description="$1"
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

# --- preconditions ---------------------------------------------------------
[[ "$(id -u)" == "0" ]] || precondition "must run as root (uid 0); uid=$(id -u)"
[[ "${ACS_VERIFY_DISPOSABLE:-}" == "1" ]] || precondition "set ACS_VERIFY_DISPOSABLE=1 after confirming this is a disposable installation"
for tool in systemctl systemd-analyze ps getent setpriv node; do
  command -v "$tool" >/dev/null 2>&1 || precondition "required tool not found: $tool"
done
[[ -d "$RELEASE_DIR" ]] || precondition "release directory not found: $RELEASE_DIR"
[[ -f "$RELEASE_DIR/dist/cli.js" ]] || precondition "release entrypoint not found: $RELEASE_DIR/dist/cli.js"
[[ -f "$POLICY_PATH" ]] || precondition "policy not found: $POLICY_PATH"
[[ -d "$WORKSPACE" ]] || precondition "workspace not found: $WORKSPACE"
[[ -d "$STATE_DIR" ]] || precondition "JC state directory not found: $STATE_DIR"
getent passwd "$BRIDGE_USER" >/dev/null || precondition "bridge user not found: $BRIDGE_USER"
getent passwd "$EXEC_USER" >/dev/null || precondition "executor user not found: $EXEC_USER"
[[ -x /bin/sh ]] || precondition "/bin/sh is missing"

echo "Verifying $UNIT on $(hostname) (disposable=$ACS_VERIFY_DISPOSABLE)"
echo

# --- unit identity and ownership ------------------------------------------
FRAGMENT="$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null || true)"
if [[ -n "$FRAGMENT" && -f "$FRAGMENT" ]]; then
  pass "unit fragment: $FRAGMENT"
  owner="$(stat -c '%u' "$FRAGMENT")"
  mode="$(stat -c '%a' "$FRAGMENT")"
  [[ "$owner" == "0" ]] && pass "unit file is root-owned" || fail "unit file is not root-owned (uid $owner)"
  # No group/other write bits.
  (( (8#$mode & 8#022) == 0 )) && pass "unit file is not group/world writable (mode $mode)" \
    || fail "unit file is group/world writable (mode $mode)"
else
  fail "unit fragment not found for $UNIT"
fi

ACTIVE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
[[ "$ACTIVE" == "active" ]] && pass "unit is active" || fail "unit is not active (state: ${ACTIVE:-unknown})"

MAIN_PID="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || true)"
if [[ -z "$MAIN_PID" || "$MAIN_PID" == "0" ]]; then
  fail "unit has no MainPID"
  echo
  echo "RESULT: FAIL ($failures boundary check(s) failed)"
  exit 3
fi
pass "MainPID: $MAIN_PID"

# --- bridge uid/gid and capabilities --------------------------------------
bridge_uid="$(awk '/^Uid:/{print $2}' "/proc/$MAIN_PID/status" 2>/dev/null)"
bridge_gid="$(awk '/^Gid:/{print $2}' "/proc/$MAIN_PID/status" 2>/dev/null)"
bridge_expected_uid="$(getent passwd "$BRIDGE_USER" | cut -d: -f3)"
bridge_expected_gid="$(getent passwd "$BRIDGE_USER" | cut -d: -f4)"
[[ "$bridge_uid" == "$bridge_expected_uid" ]] \
  && pass "bridge runs as $BRIDGE_USER (uid $bridge_uid)" \
  || fail "bridge uid $bridge_uid does not match $BRIDGE_USER ($bridge_expected_uid)"
[[ "$bridge_gid" == "$bridge_expected_gid" ]] \
  && pass "bridge gid $bridge_gid matches $BRIDGE_USER" \
  || fail "bridge gid $bridge_gid does not match $BRIDGE_USER ($bridge_expected_gid)"

bridge_caps="$(awk '/^CapEff:/{print $2}' "/proc/$MAIN_PID/status" 2>/dev/null)"
bridge_caps_dec=$((16#${bridge_caps:-0}))
# CAP_SETUID=7, CAP_SETGID=6
(( bridge_caps_dec & (1 << 7) )) && pass "bridge holds CAP_SETUID (needed for setpriv)" \
  || fail "bridge is missing CAP_SETUID; the uid drop cannot work"
(( bridge_caps_dec & (1 << 6) )) && pass "bridge holds CAP_SETGID (needed for setpriv)" \
  || fail "bridge is missing CAP_SETGID; the uid drop cannot work"
# Anything outside SETUID/SETGID is unexpected for this unit.
unexpected=$(( bridge_caps_dec & ~((1 << 7) | (1 << 6)) ))
[[ "$unexpected" == "0" ]] && pass "bridge holds no capabilities beyond SETUID/SETGID" \
  || fail "bridge holds unexpected capabilities (CapEff=$bridge_caps)"

# --- executor is a different uid, with initialized groups and no caps ------
exec_pid=""
for _ in $(seq 1 20); do
  for child in $(pgrep -P "$MAIN_PID" 2>/dev/null || true); do
    child_uid="$(awk '/^Uid:/{print $2}' "/proc/$child/status" 2>/dev/null || true)"
    if [[ "$child_uid" == "$(getent passwd "$EXEC_USER" | cut -d: -f3)" ]]; then exec_pid="$child"; break; fi
  done
  [[ -n "$exec_pid" ]] && break
  sleep 0.25
done

if [[ -z "$exec_pid" ]]; then
  fail "no direct executor child of $MAIN_PID runs as $EXEC_USER"
else
  pass "executor PID $exec_pid is a child of the bridge"
  exec_uid="$(awk '/^Uid:/{print $2}' "/proc/$exec_pid/status")"
  exec_gid="$(awk '/^Gid:/{print $2}' "/proc/$exec_pid/status")"
  exec_expected_uid="$(getent passwd "$EXEC_USER" | cut -d: -f3)"
  exec_expected_gid="$(getent passwd "$EXEC_USER" | cut -d: -f4)"
  [[ "$exec_uid" == "$exec_expected_uid" ]] && pass "executor runs as $EXEC_USER (uid $exec_uid)" \
    || fail "executor uid $exec_uid does not match $EXEC_USER ($exec_expected_uid)"
  [[ "$exec_gid" == "$exec_expected_gid" ]] && pass "executor gid $exec_gid matches $EXEC_USER" \
    || fail "executor gid $exec_gid does not match $EXEC_USER ($exec_expected_gid)"
  [[ "$exec_uid" != "$bridge_uid" ]] && pass "executor and bridge run as different uids" \
    || fail "executor and bridge share uid $exec_uid"
  groups_line="$(awk '/^Groups:/{sub(/^Groups:[[:space:]]*/, ""); print}' "/proc/$exec_pid/status")"
  [[ -n "$groups_line" ]] && pass "executor supplementary groups initialized: $groups_line" \
    || fail "executor has no supplementary groups; --init-groups did not take effect"
  exec_caps="$(awk '/^CapEff:/{print $2}' "/proc/$exec_pid/status")"
  exec_caps_dec=$((16#${exec_caps:-0}))
  [[ "$exec_caps_dec" == "0" ]] && pass "executor holds no effective capabilities (CapEff=0)" \
    || fail "executor holds effective capabilities (CapEff=$exec_caps)"
fi

# --- live mount namespace: workspace writable, secrets read-only -----------
if [[ -r "/proc/$MAIN_PID/mountinfo" ]]; then
  ro_policy="$(grep -F " $POLICY_PATH " "/proc/$MAIN_PID/mountinfo" 2>/dev/null | head -1 || true)"
  if [[ -z "$ro_policy" ]]; then
    ro_policy="$(grep -F " $(dirname "$POLICY_PATH") " "/proc/$MAIN_PID/mountinfo" 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$ro_policy" ]]; then
    [[ " $ro_policy " == *" ro "* ]] && pass "policy/config path is mounted read-only in the unit namespace" \
      || fail "policy/config path is not mounted read-only in the unit namespace"
  else
    echo "INFO: no explicit mount entry for $(dirname "$POLICY_PATH"); ProtectSystem=strict makes / read-only"
  fi
  ws_mount="$(grep -F " $WORKSPACE " "/proc/$MAIN_PID/mountinfo" 2>/dev/null | head -1 || true)"
  if [[ -n "$ws_mount" ]]; then
    [[ " $ws_mount " == *" rw "* ]] && pass "workspace is mounted read-write in the unit namespace" \
      || fail "workspace is not mounted read-write in the unit namespace"
  else
    echo "INFO: workspace has no explicit mount entry; ReadWritePaths exposes it through the root mount"
  fi
else
  echo "INFO: /proc/$MAIN_PID/mountinfo is unreadable; skipping namespace mount checks"
fi

# --- bridge readiness must come from the pinned release probe --------------
ready_json="$(node -e '
const port = process.argv[1];
fetch(`http://127.0.0.1:${port}/ready`).then(async (r) => {
  const body = await r.text();
  process.stdout.write(JSON.stringify({ status: r.status, body }));
}).catch((e) => { process.stdout.write(JSON.stringify({ status: 0, error: String(e && e.message || e) })); });
' "$BRIDGE_PORT" 2>/dev/null || echo '{"status":0}')"

node -e '
const parsed = JSON.parse(process.argv[1]);
let body;
try { body = JSON.parse(parsed.body); } catch { body = {}; }
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
const pass = (m) => console.log("PASS: " + m);
if (parsed.status !== 200 || body.ready !== true) {
  console.error("FAIL: bridge /ready is not 200/ready (status=" + parsed.status + ", notReady=" + JSON.stringify(body.notReady || []) + ")");
  process.exit(1);
}
pass("bridge /ready reports ready");
const local = body.local || {};
const readiness = local.readiness || {};
if (local.uidDrop?.configured !== true) fail("bridge did not report a configured uid drop");
pass("bridge reports a configured executor uid drop");
if (readiness.policy?.ok !== true) fail("local policy probe did not pass (" + (readiness.policy?.state || "unknown") + ")");
pass("pinned release loaded a usable policy");
if (readiness.sandbox?.ok !== true) fail("workload sandbox probe did not pass (" + (readiness.sandbox?.detail || "unknown") + ")");
pass("pinned release sandbox self-test: " + readiness.sandbox.detail);
' "$ready_json"
if [[ $? -ne 0 ]]; then failures=$((failures + 1)); fi

# --- real workload probe under the executor account -----------------------
probe_dir="$(mktemp -d /tmp/jc-systemd-verify.XXXXXXXX)" || precondition "cannot create probe directory"
chmod 0755 "$probe_dir"
canary="$STATE_DIR/.jc-systemd-verify-canary-$$"
cleanup() {
  rm -rf "$probe_dir"
  rm -f "$canary"
  rm -f "$WORKSPACE/.jc-systemd-verify-write"
}
trap cleanup EXIT

cat > "$probe_dir/probe.mjs" <<'PROBE'
/**
 * Runs inside a real bubblewrap sandbox as the executor uid. The policy is the
 * same one the service uses; the assertions are the boundary the operator
 * claims. Exit 0 only if every expectation holds.
 */
const [releaseDir, workspace, stateDir, policyPath, bridgeEnv, canary] = process.argv.slice(2);
const { pathToFileURL } = await import('node:url');
const { loadJcPolicy } = await import(pathToFileURL(`${releaseDir}/dist/local-policy.js`).href);
const { sandboxPolicyFromEnv, sandboxArgv } = await import(pathToFileURL(`${releaseDir}/dist/sandbox.js`).href);
const { spawnSync } = await import('node:child_process');
const path = await import('node:path');

const policy = loadJcPolicy({
  systemPath: policyPath,
  systemPathExplicit: true,
  userPath: path.join(stateDir, 'policy.user.json'),
  requireImmutable: true,
});
if (policy.state === 'invalid' || policy.immutable !== true) {
  console.error('policy is not usable under the executor account: ' + (policy.errors || []).join('; '));
  process.exit(10);
}
const sandbox = sandboxPolicyFromEnv({
  homeDir: process.env.HOME || '/home/jc',
  stateDir,
  fsRoots: policy.effective.fsRoots || [workspace],
  fsDeniedRoots: [policyPath, path.join(stateDir, 'policy.user.json')],
  managed: true,
});
const writeTarget = path.join(workspace, '.jc-systemd-verify-write');
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const probe = [
  'set -u',
  'ok=0',
  `touch ${quote(writeTarget)} && ok=$((ok+1)) || { echo workspace-not-writable; }`,
  'if touch /etc/.jc-verify 2>/dev/null; then echo etc-writable; else ok=$((ok+1)); fi',
  'if touch /.jc-verify 2>/dev/null; then echo root-writable; else ok=$((ok+1)); fi',
  `if test ! -e ${quote(canary)} 2>/dev/null; then ok=$((ok+1)); else echo state-canary-visible; fi`,
  `if grep -q . ${quote(bridgeEnv)} 2>/dev/null; then echo bridge-env-readable; else ok=$((ok+1)); fi`,
  `if grep -q jc.policy.v1 ${quote(policyPath)} 2>/dev/null; then echo policy-readable; else ok=$((ok+1)); fi`,
  'if sudo -n true >/dev/null 2>&1; then echo sudo-allowed; else ok=$((ok+1)); fi',
  'if mount -t tmpfs none /mnt >/dev/null 2>&1; then echo mount-allowed; else ok=$((ok+1)); fi',
  'caps=$(awk "/^CapEff:/{print \\$2}" /proc/self/status); if [ "$caps" = "0000000000000000" ]; then ok=$((ok+1)); else echo caps=$caps; fi',
  'echo "ok=$ok"',
].join('; ');
const argv = sandboxArgv(sandbox, ['/bin/sh', '-c', probe], '/');
const out = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '/home/jc' } });
const text = `${out.stdout || ''}${out.stderr || ''}`.trim();
if (out.status !== 0 || !text.includes('ok=9')) {
  console.error(`sandbox boundary probe failed (status=${out.status ?? out.signal}): ${text}`);
  process.exit(11);
}
console.log(text);
PROBE
chmod 0644 "$probe_dir/probe.mjs"

EXEC_HOME_RESOLVED="$(getent passwd "$EXEC_USER" | cut -d: -f6)"
EXEC_UID_RESOLVED="$(getent passwd "$EXEC_USER" | cut -d: -f3)"
EXEC_GID_RESOLVED="$(getent passwd "$EXEC_USER" | cut -d: -f4)"
printf 'control-plane\n' > "$canary" 2>/dev/null || true
chown "$EXEC_USER:$EXEC_USER" "$canary" 2>/dev/null || true
chmod 0600 "$canary" 2>/dev/null || true

# The probe plant is passed as an argument so the shell script can see it.
probe_out="$(setpriv --reuid="$EXEC_UID_RESOLVED" --regid="$EXEC_GID_RESOLVED" --init-groups \
  env -i PATH=/usr/bin:/bin HOME="$EXEC_HOME_RESOLVED" XDG_RUNTIME_DIR="/run/user/$EXEC_UID_RESOLVED" \
  node "$probe_dir/probe.mjs" "$RELEASE_DIR" "$WORKSPACE" "$STATE_DIR" "$POLICY_PATH" "$BRIDGE_ENV" "$canary" 2>&1)"
probe_status=$?
if [[ "$probe_status" == "0" ]]; then
  pass "real bubblewrap workload boundary: $probe_out"
else
  fail "real bubblewrap workload boundary probe failed (status=$probe_status): $probe_out"
fi

echo
if (( failures == 0 )); then
  echo "RESULT: PASS (all local-preset systemd boundary checks verified)"
  exit 0
fi
echo "RESULT: FAIL ($failures boundary check(s) failed)"
exit 3
