#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
gateway=acs-recovery.service
display=acs-computer-use-xvfb.service
bridge=jace-commander-mcp.service
proxy=jace-commander-auth-proxy.service
target=acs-stack.target
managed=("$gateway" "$display" "$bridge" "$proxy")
excluded=(cue-app.service cue-worker-local.service hermes-gateway.service openclaw-gateway.service)
export FIXTURE_GATEWAY="$gateway" FIXTURE_BRIDGE="$bridge" FIXTURE_PROXY="$proxy"
export FIXTURE_WANTS="${managed[*]}"
unset DBUS_SESSION_BUS_ADDRESS ACS_STACK_GATEWAY_URL ACS_STACK_MCP_URL ACS_STACK_PROXY_URL ACS_STACK_X_DISPLAY ACS_STACK_X_AUTHORITY
mkdir -- "$tmp/shims"

cat >"$tmp/shims/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --user ]]
while [[ "$1" == --* ]]; do shift; done
printf '%s\n' "$*" >> "$TRACE"
case "$1" in
  start|stop) [[ "$*" != "${FAIL_JOB:-}" ]] ;;
  is-active) [[ "$3" != "${INACTIVE_UNIT:-}" ]] ;;
  daemon-reload)
    count=$(cat "$TRACE.reloads")
    count=$((count + 1))
    printf '%s\n' "$count" > "$TRACE.reloads"
    [[ "$count" != "${FAIL_RELOAD:-}" ]]
    ;;
  show)
    case "$*" in
      'show --property=Version --value') printf 'fixture\n' ;;
      'show acs-stack.target --property=LoadState --value') printf 'not-found\n' ;;
      *'--property=LoadState --value') printf 'loaded\n' ;;
      'show acs-stack.target --property=FragmentPath --value')
        printf '%s/systemd/user/acs-stack.target\n' "$XDG_CONFIG_HOME"
        ;;
      'show acs-stack.target --property=DropInPaths --value') printf '\n' ;;
      'show default.target --property=Wants --value')
        [[ -L "$XDG_CONFIG_HOME/systemd/user/default.target.wants/acs-stack.target" ]]
        printf 'acs-stack.target\n'
        ;;
      'show acs-stack.target --property=Wants --value')
        printf '%s\n' "${FIXTURE_WANTS_OVERRIDE:-$FIXTURE_WANTS}"
        ;;
      'show acs-stack.target --property=After --value') printf '%s\n' "$FIXTURE_WANTS" ;;
      "show $FIXTURE_PROXY --property=After --value")
        printf '%s\n' "${PROXY_AFTER:-$FIXTURE_GATEWAY $FIXTURE_BRIDGE}"
        ;;
      *'--property=ActiveState --value') printf 'inactive\n' ;;
      *'--property=RequiredBy,RequisiteOf,BoundBy,ConsistsOf,PropagatesStopTo')
        if [[ "$2" == "$FIXTURE_GATEWAY" ]]; then printf '%s\n' "${STOP_RELATION:-}"; fi
        ;;
    esac
    ;;
  *) exit 99 ;;
esac
SHIM
cat >"$tmp/shims/curl" <<'SHIM'
#!/usr/bin/env bash
printf 'probe %s\n' "${!#}" >> "$TRACE"
printf '%s\n' "${HTTP_STATUS:-200}"
SHIM
cat >"$tmp/shims/xdpyinfo" <<'SHIM'
#!/usr/bin/env bash
printf 'X11 %s %s\n' "$XAUTHORITY" "$*" >> "$TRACE"
SHIM
cat >"$tmp/shims/journalctl" <<'SHIM'
#!/usr/bin/env bash
printf 'journal %s\n' "$*" >> "$TRACE"
SHIM
chmod +x "$tmp/shims/"*
export PATH="$tmp/shims:$PATH"
[[ $(command -v systemctl) == "$tmp/shims/systemctl" ]]

fixture() {
  # Explicitly isolate both the systemd unit lookup and the user bus.
  export HOME="$tmp/$1/home"
  export XDG_CONFIG_HOME="$tmp/$1/config" XDG_STATE_HOME="$tmp/$1/state" XDG_RUNTIME_DIR="$tmp/$1/run"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/isolated"
  export TRACE="$tmp/$1/trace"
  units="$XDG_CONFIG_HOME/systemd/user"
  boot="$units/default.target.wants"
  command_path="$HOME/.local/bin/acs-stack"
  export SYSTEMD_UNIT_PATH="$units:"
  mkdir -p -- "$HOME" "$boot" "$XDG_RUNTIME_DIR" "$units/other.target.wants"
  : >"$TRACE"
  echo 0 >"$TRACE.reloads"
  for unit in "${managed[@]}" "${excluded[@]}"; do
    printf '[Service]\nExecStart=/usr/bin/true\nRestart=on-failure\n' >"$units/$unit"
    ln -s "../$unit" "$boot/$unit"
  done
  printf '[Unit]\nWants=%s %s\nAfter=%s %s\n' "$gateway" "$bridge" "$gateway" "$bridge" >"$units/$proxy"
  printf '[Service]\nExecStart=/usr/bin/true\nRestart=on-failure\n' >>"$units/$proxy"
  printf '[Unit]\nDescription=Test user default target\n' >"$units/default.target"
  printf '[Unit]\nDescription=Test alternate target\n' >"$units/other.target"
  ln -s "../$gateway" "$units/other.target.wants/$gateway"
  # Exercise restoring an absent boot link as well as restoring existing symlinks.
  rm -- "$boot/$display"
  find "$units" -type f -print0 | sort -z | xargs -0 sha256sum >"$TRACE.units"
  snapshot_links >"$TRACE.links"
}

snapshot_links() {
  find "$units" -type l -printf '%P -> %l\n' | sort
}

assert_original() {
  sha256sum --quiet -c "$TRACE.units"
  snapshot_links | diff -u "$TRACE.links" -
  [[ ! -e "$units/$target" && ! -e "$command_path" && ! -e "$XDG_STATE_HOME/acs-stack" ]]
}

assert_install_boundary() {
  sha256sum --quiet -c "$TRACE.units"
  [[ -L "$units/other.target.wants/$gateway" ]]
  for unit in "${excluded[@]}"; do
    [[ $(readlink -- "$boot/$unit") == "../$unit" ]]
    if grep -Fq -- "$unit" "$TRACE"; then
      printf 'Unexpected access to excluded unit %s\n' "$unit" >&2
      return 1
    fi
  done
  if grep -Eq '^(start|stop|restart|disable|mask) ' "$TRACE"; then
    printf 'Installer issued an out-of-scope systemctl operation\n' >&2
    return 1
  fi
}

expect_status() {
  local expected=$1 actual=0
  shift
  "$@" >"$TRACE.output" 2>&1 || actual=$?
  if [[ "$expected" != "$actual" ]]; then
    cat "$TRACE.output" >&2
    printf 'Expected exit %s, got %s. Command: %s\n' "$expected" "$actual" "$*" >&2
    return 1
  fi
}

echo 'Checking target dependencies and installation'
fixture install
installer="$source_dir/install.sh"
expect_status 0 "$installer" install
[[ -x "$command_path" && -f "$XDG_STATE_HOME/acs-stack/installed" ]]
[[ $(readlink -- "$boot/$target") == "$units/$target" ]]
for unit in "${managed[@]}"; do [[ ! -L "$boot/$unit" ]]; done
assert_install_boundary
systemd-analyze --user verify "$units/$target" default.target
for property in Wants After; do
  diff -u <(printf '%s\n' "${managed[@]}" | sort) \
    <(sed -n "s/^${property}=//p" "$units/$target" | tr ' ' '\n' | sort)
done
grep -qx 'WantedBy=default.target' "$units/$target"
if grep -Eq '^(Requires|BindsTo|PartOf|PropagatesStopTo)=' "$units/$target"; then exit 1; fi
expect_status 0 "$installer" install
[[ $(cat "$TRACE.reloads") == 2 ]]
XDG_CONFIG_HOME="$tmp/different-config" expect_status 1 "$installer" uninstall
grep -Fq 'same account and configuration paths' "$TRACE.output"
expect_status 0 "$installer" uninstall
assert_original
expect_status 0 "$installer" uninstall
[[ $(cat "$TRACE.reloads") == 3 ]]
assert_install_boundary

echo 'Checking installer rollback and conflict handling'
fixture cutover-failure
FAIL_RELOAD=2 expect_status 1 "$installer" install
grep -Fq 'Previous startup links restored' "$TRACE.output"
assert_original
assert_install_boundary

fixture graph-failure
FIXTURE_WANTS_OVERRIDE="$FIXTURE_WANTS outside.service" expect_status 1 "$installer" install
assert_original

fixture ordering-failure
PROXY_AFTER="$gateway" expect_status 1 "$installer" install
assert_original
[[ $(cat "$TRACE.reloads") == 0 ]]

fixture edited-installation
expect_status 0 "$installer" install
cp "$command_path" "$TRACE.original"
printf '# operator edit\n' >>"$command_path"
expect_status 1 "$installer" uninstall
grep -Fq 'Refusing to remove an edited or foreign file' "$TRACE.output"
[[ -L "$boot/$target" && -d "$XDG_STATE_HOME/acs-stack" ]]
cp "$TRACE.original" "$command_path"
expect_status 0 "$installer" uninstall
assert_original

fixture retry-rollback
expect_status 0 "$installer" install
FAIL_RELOAD=3 expect_status 1 "$installer" uninstall
[[ -d "$XDG_STATE_HOME/acs-stack" ]]
expect_status 0 "$installer" uninstall
assert_original

echo 'Checking CLI commands, health probes, and order'
fixture cli
cli="$source_dir/acs-stack.sh"
start_jobs=$(printf 'start %s %s %s\nstart %s\nstart %s\n' "$gateway" "$display" "$bridge" "$proxy" "$target")
stop_jobs=$(printf 'stop %s\n' "$proxy" "$bridge" "$display" "$gateway" "$target")
job_trace() { grep -E '^(start|stop) ' "$TRACE"; }

ACS_STACK_X_DISPLAY=:10 ACS_STACK_X_AUTHORITY="$HOME/auth dir/Xauthority" expect_status 0 "$cli" start
[[ $(job_trace) == "$start_jobs" ]]
diff -u <(printf '%s\n' "start $gateway $display $bridge" 'probe http://127.0.0.1:3000/readyz' \
  "X11 $HOME/auth dir/Xauthority -display :10" 'probe http://127.0.0.1:8003/healthz' \
  "start $proxy" 'probe http://127.0.0.1:8010/jc/ready' "start $target") \
  <(grep -E '^(start|probe|X11) ' "$TRACE")

: >"$TRACE"
expect_status 0 "$cli" stop
[[ $(job_trace) == "$stop_jobs" ]]
: >"$TRACE"
expect_status 0 "$cli" restart
[[ $(job_trace) == "$stop_jobs"$'\n'"$start_jobs" ]]
: >"$TRACE"
FAIL_JOB="stop $bridge" expect_status 1 "$cli" restart
[[ $(job_trace) == "stop $proxy"$'\n'"stop $bridge" ]]
: >"$TRACE"
STOP_RELATION=outside.service expect_status 1 "$cli" stop
if job_trace; then exit 1; fi

: >"$TRACE"
FAIL_JOB="start $gateway $display $bridge" expect_status 1 "$cli" start
[[ $(job_trace) == "start $gateway $display $bridge" ]]
expect_status 0 "$cli" status
grep -Fq 'HTTP 200' "$TRACE.output"
HTTP_STATUS=503 expect_status 1 "$cli" status
INACTIVE_UNIT="$target" expect_status 1 "$cli" status
ACS_STACK_GATEWAY_URL='http://192.0.2.1:1234/readyz' expect_status 1 "$cli" status
grep -Fq 'Expected a loopback HTTP health URL' "$TRACE.output"
ACS_STACK_GATEWAY_URL='http://[::1]:1234/readyz' expect_status 0 "$cli" status
expect_status 0 "$cli" logs
expect_status 0 "$cli" logs --follow
grep -Fqx "journal --no-pager --output=with-unit --lines=100 --user-unit=$gateway --user-unit=$display --user-unit=$bridge --user-unit=$proxy --follow" "$TRACE"
expect_status 0 "$cli" --help
expect_status 2 "$cli" logs --unexpected
for unit in "${excluded[@]}"; do
  if grep -Fq -- "$unit" "$TRACE"; then exit 1; fi
done

echo 'ACS startup controller tests passed'
