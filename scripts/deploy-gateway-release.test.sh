#!/usr/bin/env bash
# Sandbox test for scripts/deploy-gateway-release.sh: the activation wait, rollback and --resume paths.
# Runs with a temporary HOME and stub systemctl/curl/journalctl/node, so it never touches the real service,
# database or releases. Build and smoke phases are covered by a real dry run, not here.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_NODE="$(command -v node)"
TMP_ROOT="$(mktemp -d)"
trap '[[ -n "${KEEP_SANDBOX:-}" ]] || rm -rf "$TMP_ROOT"' EXIT
failures=0
SHORT="$(git -C "$ROOT" rev-parse --short=7 HEAD)"
export ROOT SHORT

fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
expect() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ok: $desc"; else fail "$desc"; fi; }

# --- stubs --------------------------------------------------------------------------------------------------
make_stubs() {
  local shims="$1" nodebin="$2"
  mkdir -p "$shims" "$nodebin"
  cat >"$shims/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$SANDBOX/calls.log"
case "$*" in
  *NRestarts*) echo "${SHIM_NRESTARTS:-0}"; exit 0 ;;
  *" restart "*) echo new >"$SANDBOX/mode" ;;
  *" start "*) echo old >"$SANDBOX/mode" ;;
esac
exit 0
EOF
  cat >"$shims/curl" <<'EOF'
#!/usr/bin/env bash
url=""; out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
mode="$(cat "$SANDBOX/mode" 2>/dev/null || echo old)"
echo "curl $url mode=$mode" >>"$SANDBOX/calls.log"
if [[ "$mode" == "new" && "${SHIM_NEW_BROKEN:-0}" == "1" ]]; then exit 7; fi
if [[ "$url" == */livez ]]; then
  n=$(($(cat "$SANDBOX/live-count" 2>/dev/null || echo 0) + 1)); echo "$n" >"$SANDBOX/live-count"
  if (( n <= ${SHIM_LIVE_FAIL_FIRST:-0} )); then exit 7; fi
fi
[[ -n "$out" ]] && echo '{"ok":true}' >"$out"
[[ -z "$out" ]] && echo '{"agents":[{"status":"AVAILABLE"}]}'
exit 0
EOF
  cat >"$shims/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "journal line from stub"
EOF
  cat >"$nodebin/node" <<EOF
#!/usr/bin/env bash
case "\$1" in
  *db-ops.mjs) echo "db-ops \$*" >>"\$SANDBOX/calls.log"; [[ "\${SHIM_DBOPS_FAIL:-0}" == 1 ]] && exit 1; [[ "\$2" == restore ]] && cp "\$3" "\$4"; exit 0 ;;
  *release-integrity.mjs) echo "integrity \$*" >>"\$SANDBOX/calls.log"; exit 0 ;;
esac
exec "$REAL_NODE" "\$@"
EOF
  chmod +x "$shims"/* "$nodebin/node"
}

# --- one sandbox per case -----------------------------------------------------------------------------------
setup() {
  SANDBOX="$TMP_ROOT/$1"; export SANDBOX
  export HOME="$SANDBOX/home"
  # Hard isolation: even if a stub were bypassed, a real systemctl could not reach the user's service manager.
  export XDG_RUNTIME_DIR="$SANDBOX/xdg"; mkdir -p "$XDG_RUNTIME_DIR"
  unset DBUS_SESSION_BUS_ADDRESS
  mkdir -p "$HOME/.config/systemd/user/acs-gateway.service.d" "$HOME/.config/agent-control-stack" \
           "$HOME/releases/acs" "$SANDBOX/store" "$SANDBOX/stage/scripts"
  : >"$SANDBOX/calls.log"
  make_stubs "$SANDBOX/shims" "$HOME/releases/_node/v24.18.0/bin"
  sqlite3 "$SANDBOX/store/control.db" "pragma journal_mode=wal; create table schema_migrations(version integer); insert into schema_migrations values (47);" >/dev/null
  printf 'ACS_DB_PATH=%s\nPORT=3000\nACS_GATEWAY_TOKEN=test\n' "$SANDBOX/store/control.db" >"$HOME/.config/agent-control-stack/gateway.env"
  PREV="$HOME/releases/acs/prev-release"; export PREV
  mkdir -p "$PREV/scripts"; touch "$PREV/scripts/db-ops.mjs"
  printf '[Service]\n# OLD-RELEASE\nWorkingDirectory=%s\n' "$PREV" >"$HOME/.config/systemd/user/acs-gateway.service.d/40-immutable-release.conf"
  touch "$SANDBOX/stage/scripts/release-integrity.mjs" "$SANDBOX/stage/scripts/db-ops.mjs"
  FINAL="$HOME/releases/acs/$SHORT-test"
  DROPINS="$HOME/.config/systemd/user/acs-gateway.service.d"
  export FINAL DROPINS
}

run_deploy() {
  [[ "$(PATH="$SANDBOX/shims:$PATH" command -v systemctl)" == "$SANDBOX/shims/systemctl" ]] || { echo "refusing to run: systemctl stub is not first on PATH" >&2; exit 2; }
  ( cd "$ROOT" && PATH="$SANDBOX/shims:$PATH" ACS_DEPLOY_PREBUILT_STAGE="$SANDBOX/stage" ACS_DEPLOY_TEST_MODE=1 \
      ACS_RELEASE_NODE_DIR="$HOME/releases/_node/v24.18.0/bin" ACS_AGENT_REPO_ROOTS="$HOME" \
      scripts/deploy-gateway-release.sh --ref HEAD --label test "$@" ) >"$SANDBOX/out.log" 2>&1
  echo $? >"$SANDBOX/exit"
}

exit_code() { cat "$SANDBOX/exit"; }
called() { grep -q -- "$1" "$SANDBOX/calls.log"; }
out_has() { grep -q -- "$1" "$SANDBOX/out.log"; }

# --- A: slow startup must be waited out, not rolled back ----------------------------------------------------
echo "A: slow startup is waited out"
setup A
SHIM_LIVE_FAIL_FIRST=4 ACS_DEPLOY_WAIT_SEC=40 run_deploy
expect "exit 0" test "$(exit_code)" -eq 0
expect "new release drop-in installed" grep -q "$FINAL" "$DROPINS/40-immutable-release.conf"
expect "dispatch drop-in installed with PATH and flags" grep -q "ACS_AGENT_DISPATCH_ENABLED=1" "$DROPINS/50-agent-dispatch.conf"
expect "never stopped the unit" bash -c '! grep -q "systemctl --user stop" "$SANDBOX/calls.log"'
expect "never restored the database" bash -c '! grep -q "db-ops" "$SANDBOX/calls.log"'
expect "polled livez more than the 4 initial failures" test "$(grep -c '/livez' "$SANDBOX/calls.log")" -gt 4

# --- B: new release never healthy: stop, restore DB, restore drop-ins, start --------------------------------
echo "B: unhealthy new release rolls back the database and drop-ins"
setup B
SHIM_NEW_BROKEN=1 ACS_DEPLOY_WAIT_SEC=4 run_deploy
expect "exit 1" test "$(exit_code)" -eq 1
expect "unit stopped before the restore" bash -c 'awk "/systemctl --user stop/{s=NR} /db-ops.mjs restore/{r=NR} END{exit !(s&&r&&s<r)}" "$SANDBOX/calls.log"'
expect "database restored from the pre-activation backup" grep -qE "db-ops .*db-ops.mjs restore .*control.db.pre-$SHORT-.* .*control.db --replace --writers-stopped|db-ops .*restore .*control.db.pre-$SHORT-" "$SANDBOX/calls.log"
expect "backup file exists" bash -c 'ls "$SANDBOX"/store/control.db.pre-* >/dev/null'
expect "restore used the PREVIOUS release's tool" grep -q "db-ops $PREV/scripts/db-ops.mjs restore" "$SANDBOX/calls.log"
expect "backup is in rollback-journal mode (no WAL sidecars for the tool to trip on)" bash -c '[ "$(sqlite3 "$(ls "$SANDBOX"/store/control.db.pre-* | head -1)" "pragma journal_mode")" = delete ]'
expect "previous release drop-in restored" grep -q "OLD-RELEASE" "$DROPINS/40-immutable-release.conf"
expect "dispatch drop-in removed" test ! -e "$DROPINS/50-agent-dispatch.conf"
expect "unit started again after restore" bash -c 'awk "/db-ops.mjs restore/{r=NR} /systemctl --user start/{s=NR} END{exit !(r&&s&&r<s)}" "$SANDBOX/calls.log"'
expect "checked readiness of the restored release, not just liveness" grep -q "readyz mode=old" "$SANDBOX/calls.log"
expect "tells the operator writes since the backup are lost" grep -q "writes since that backup are lost" "$SANDBOX/out.log"

# --- C: crash loop is detected without burning the whole wait -----------------------------------------------
echo "C: a crash-looping unit fails fast"
setup C
start=$SECONDS
SHIM_NEW_BROKEN=1 SHIM_NRESTARTS=5 ACS_DEPLOY_WAIT_SEC=120 run_deploy
expect "exit 1" test "$(exit_code)" -eq 1
expect "reported the crash loop" grep -q "crash-looping" "$SANDBOX/out.log"
expect "gave up well before the 120s wait" test $((SECONDS - start)) -lt 30

# --- D: --resume never restores a database -----------------------------------------------------------------
echo "D: --resume failure does not roll back"
setup D
mkdir -p "$FINAL/scripts"; touch "$FINAL/scripts/release-integrity.mjs" "$FINAL/scripts/db-ops.mjs"
SHIM_NEW_BROKEN=1 ACS_DEPLOY_WAIT_SEC=4 run_deploy --resume
expect "exit 1" test "$(exit_code)" -eq 1
expect "no database restore" bash -c '! grep -q "db-ops" "$SANDBOX/calls.log"'
expect "no new backup taken" bash -c '! ls "$SANDBOX"/store/control.db.pre-* >/dev/null 2>&1'
expect "explains why it did not roll back" grep -q "NOT rolling back" "$SANDBOX/out.log"
expect "resume refuses a release that was never published" bash -c '
  rm -rf "$FINAL"; ( cd "$ROOT" && PATH="$SANDBOX/shims:$PATH" ACS_RELEASE_NODE_DIR="$HOME/releases/_node/v24.18.0/bin" \
    scripts/deploy-gateway-release.sh --ref HEAD --label test --resume ) >/dev/null 2>&1; [ $? -ne 0 ]'

# --- B2: a failed DB restore must fail closed: previous drop-ins back, unit LEFT STOPPED ------------------
echo "B2: failed database restore leaves the unit stopped"
setup B2
SHIM_NEW_BROKEN=1 SHIM_DBOPS_FAIL=1 ACS_DEPLOY_WAIT_SEC=4 run_deploy
expect "exit 1" test "$(exit_code)" -eq 1
expect "warns that the database restore failed and the unit is left stopped" grep -q "DATABASE RESTORE FAILED.*STOPPED" "$SANDBOX/out.log"
expect "previous release drop-in still restored for a manual start" grep -q "OLD-RELEASE" "$DROPINS/40-immutable-release.conf"
expect "the unit was stopped" grep -q "systemctl --user stop" "$SANDBOX/calls.log"
expect "the previous release was NOT started against the unrestored database" bash -c '! grep -q "systemctl --user start" "$SANDBOX/calls.log"'
expect "tells the operator how to recover" grep -q "systemctl --user start acs-gateway.service" "$SANDBOX/out.log"

# --- F: concurrent deploys are refused, existing releases are never overwritten ----------------------------
echo "F: a second deploy is refused while one holds the lock"
setup F
LOCK="$XDG_RUNTIME_DIR/acs-deploy-acs-gateway.service.lock"
flock "$LOCK" -c "sleep 8" &
holder=$!
sleep 1
ACS_DEPLOY_WAIT_SEC=4 run_deploy
wait "$holder" 2>/dev/null
expect "exit non-zero" test "$(exit_code)" -ne 0
expect "says another deploy is running" grep -q "another deploy of acs-gateway.service is already running" "$SANDBOX/out.log"
expect "changed nothing" bash -c '! grep -q "systemctl" "$SANDBOX/calls.log"'

echo "F2: an existing release directory is never published over"
setup F2
mkdir -p "$FINAL/keep"; touch "$FINAL/keep/me"
ACS_DEPLOY_WAIT_SEC=4 run_deploy
expect "exit non-zero" test "$(exit_code)" -ne 0
expect "existing release untouched" test -f "$FINAL/keep/me"
expect "no nested stage inside it" bash -c '[ "$(ls "$FINAL" | wc -l)" -eq 1 ]'

echo "F3: the lock does not depend on ACS_RELEASES_DIR"
setup F3
LOCK="$XDG_RUNTIME_DIR/acs-deploy-acs-gateway.service.lock"
flock "$LOCK" -c "sleep 8" &
holder=$!
sleep 1
ACS_RELEASES_DIR="$SANDBOX/a-different-releases-dir" ACS_DEPLOY_WAIT_SEC=4 run_deploy
wait "$holder" 2>/dev/null
expect "refused although the releases directory differs" grep -q "already running" "$SANDBOX/out.log"
expect "changed nothing" bash -c '! grep -q "systemctl" "$SANDBOX/calls.log"'

echo "F4: two units sharing one database exclude each other"
setup F4
DBKEY="$(printf '%s' "$(realpath -m "$SANDBOX/store/control.db")" | sha256sum | cut -c1-16)"
flock "$XDG_RUNTIME_DIR/acs-deploy-db-$DBKEY.lock" -c "sleep 8" &
holder=$!
sleep 1
ACS_GATEWAY_UNIT=acs-other-gateway.service ACS_DEPLOY_WAIT_SEC=4 run_deploy
wait "$holder" 2>/dev/null
expect "refused although the unit differs" grep -q "another deploy using database" "$SANDBOX/out.log"
expect "changed nothing" bash -c '! grep -q "systemctl" "$SANDBOX/calls.log"'

# --- G: the prebuilt-stage hook cannot be used outside the sandbox test ----------------------------------
echo "G: ACS_DEPLOY_PREBUILT_STAGE is refused in a real operator environment"
setup G
REAL_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
# Even if the guard were broken, this cannot reach production: fake unit, sandboxed releases/runtime dirs, stub tools.
guarded() {
  ( cd "$ROOT" && env HOME="$1" PATH="$SANDBOX/shims:$PATH" XDG_RUNTIME_DIR="$SANDBOX/xdg" ACS_RELEASES_DIR="$SANDBOX/rel" \
      ACS_GATEWAY_UNIT=acs-sandbox-test.service ACS_DEPLOY_PREBUILT_STAGE="$SANDBOX/stage" ${2:+ACS_DEPLOY_TEST_MODE=1} \
      scripts/deploy-gateway-release.sh --ref HEAD --label test ) >"$SANDBOX/out.log" 2>&1
  echo $? >"$SANDBOX/exit"
}
guarded "$REAL_HOME" with-test-mode
expect "refused with the real account HOME even in test mode" test "$(exit_code)" -eq 2
expect "says it is test-only" grep -q "only honored by the sandbox test" "$SANDBOX/out.log"
guarded "$HOME" ""
expect "refused in a sandbox HOME without test mode" test "$(exit_code)" -eq 2
expect "touched no service" bash -c '! grep -q "systemctl" "$SANDBOX/calls.log"'

# --- H: the lock directory cannot be steered by caller environment ----------------------------------------
echo "H: lock directory is derived from the account"
expect "no TMPDIR in the lock path (code, not comments)" bash -c '! sed -n "/^IN_SANDBOX=0/,/^exec 9>/p" "$ROOT/scripts/deploy-gateway-release.sh" | grep -v "^[[:space:]]*#" | grep -q TMPDIR'
expect "XDG_RUNTIME_DIR is only used inside the sandbox" bash -c 'grep -B1 "LOCK_DIR=\"\$XDG_RUNTIME_DIR\"" "$ROOT/scripts/deploy-gateway-release.sh" | grep -q "IN_SANDBOX"'
expect "falls back to the account runtime dir" grep -q 'choose_lock_dir "/run/user/\$(id -u)"' "$ROOT/scripts/deploy-gateway-release.sh"

# --- I: lock directory hardening (pure helper, temp directories only) --------------------------------------
echo "I: lock directory is private to the account"
# shellcheck source=lib/deploy-lock.sh
source "$ROOT/scripts/lib/deploy-lock.sh"
# bash -c subshells below must see the helpers, or a negated call would pass vacuously ("command not found").
export -f choose_lock_dir lock_dir_is_secure
LD="$TMP_ROOT/lockdirs"; mkdir -p "$LD"
pick() { choose_lock_dir "$1" "$2" 2>/dev/null; }

mkdir -m 700 "$LD/run-ok"
expect "uses a private runtime directory" test "$(pick "$LD/run-ok" "$LD/fb-unused")" = "$LD/run-ok"
expect "(control) the helper is visible to subshells and accepts a private dir" bash -c 'choose_lock_dir "$0" "$1" >/dev/null 2>&1' "$LD/run-ok" "$LD/fb-unused"
mkdir -m 755 "$LD/run-open"
expect "refuses a runtime directory that is not mode 700" bash -c '! choose_lock_dir "$0" "$1" >/dev/null 2>&1' "$LD/run-open" "$LD/fb-unused"
expect "creates a missing fallback with mode 700" bash -c 'out="$(choose_lock_dir "$0" "$1" 2>/dev/null)" && [ "$out" = "$1" ] && [ "$(stat -c %a "$1")" = 700 ]' "$LD/no-run" "$LD/fb-new"
mkdir -m 777 "$LD/fb-planted"
expect "refuses a pre-existing fallback with loose permissions (never repairs it)" bash -c '! choose_lock_dir "$0" "$1" >/dev/null 2>&1 && [ "$(stat -c %a "$1")" = 777 ]' "$LD/no-run" "$LD/fb-planted"
mkdir -m 700 "$LD/real-target"; ln -s "$LD/real-target" "$LD/fb-link"
expect "refuses a symlinked fallback directory" bash -c '! choose_lock_dir "$0" "$1" >/dev/null 2>&1' "$LD/no-run" "$LD/fb-link"
expect "the deploy script refuses a symlinked lock file" grep -q 'is a symlink' "$ROOT/scripts/deploy-gateway-release.sh"
expect "test-mode relocation requires the sandbox identity (non-account HOME), not just the flag" bash -c '
  grep -q "IN_SANDBOX=1" "$ROOT/scripts/deploy-gateway-release.sh" &&
  grep -q "\"\$HOME\" != \"\$real_home\"" "$ROOT/scripts/deploy-gateway-release.sh" &&
  grep -q "\"\$IN_SANDBOX\" -eq 1 && -n \"\${XDG_RUNTIME_DIR" "$ROOT/scripts/deploy-gateway-release.sh"'

# --- K: first deployment (no previous release drop-in) must not leave the failed release in place ----------
echo "K: rollback of a first deployment removes the new drop-in"
setup K
rm -f "$DROPINS/40-immutable-release.conf"
SHIM_NEW_BROKEN=1 ACS_DEPLOY_WAIT_SEC=4 run_deploy
expect "exit 1" test "$(exit_code)" -eq 1
expect "failed release drop-in removed (nothing existed before)" test ! -e "$DROPINS/40-immutable-release.conf"
expect "dispatch drop-in removed" test ! -e "$DROPINS/50-agent-dispatch.conf"
expect "unit started again on its base configuration" bash -c 'awk "/systemctl --user stop/{s=NR} /systemctl --user start/{t=NR} END{exit !(s&&t&&s<t)}" "$SANDBOX/calls.log"'
expect "never restarted the failed release" bash -c '! grep -q "$FINAL/apps/gateway" "$DROPINS"/*.conf 2>/dev/null'

# --- E: the build must not inherit the gateway's NODE_ENV=production -------------------------------------
echo "E: build step is immune to the gateway env file"
expect "npm ci and the build run with NODE_ENV unset" bash -c '
  grep -n "npm ci" "$ROOT/scripts/deploy-gateway-release.sh" | grep -q "env -u NODE_ENV npm ci" &&
  grep -n "npm run build" "$ROOT/scripts/deploy-gateway-release.sh" | grep -q "env -u NODE_ENV npm run build"'

echo
if [[ "$failures" -eq 0 ]]; then echo "deploy script sandbox test: all checks passed"; else echo "deploy script sandbox test: $failures check(s) FAILED"; fi
exit "$failures"
