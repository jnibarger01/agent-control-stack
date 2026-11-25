#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly target=acs-stack.target
readonly gateway=acs-recovery.service
readonly display=acs-computer-use-xvfb.service
readonly bridge=jace-commander-mcp.service
readonly proxy=jace-commander-auth-proxy.service
readonly -a services=("$gateway" "$display" "$bridge" "$proxy")
readonly -a ctl=(systemctl --user --no-ask-password --no-pager)

usage() {
  cat <<'USAGE'
Usage: acs-stack {start|stop|restart|status|logs [--follow]}

  start     Start upstream services, check readiness, and start the proxy.
  stop      Stop the proxy, MCP bridge, Xvfb, ACS gateway, and target.
  restart   Stop the managed stack, then start it and verify readiness.
  status    Show service state, enablement, PIDs, restart counts, and health.
  logs      Show the last 100 combined journal entries. Use --follow to stream.

Health probe overrides: ACS_STACK_GATEWAY_URL, ACS_STACK_MCP_URL,
ACS_STACK_PROXY_URL, ACS_STACK_X_DISPLAY, ACS_STACK_X_AUTHORITY.
Exit status: 0 on success, 1 on operation or health failure, 2 on usage error.
USAGE
}

fail() {
  printf 'acs-stack: %s\n' "$*" >&2
  return 1
}

ensure_manager() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID}"
  if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} && -S "$XDG_RUNTIME_DIR/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  if ! "${ctl[@]}" show --property=Version --value >/dev/null; then
    fail "cannot reach the user systemd manager for UID $UID (runtime: $XDG_RUNTIME_DIR)"
  fi
}

http_probe() {
  local url=$1 code
  if [[ ! "$url" =~ ^http://(127[.]0[.]0[.]1|\[::1\])(:[0-9]+)?/[a-zA-Z0-9._~/-]*$ ]]; then
    printf 'Expected a loopback HTTP health URL (127.0.0.1 or [::1])\n'
    return 1
  fi
  if ! code=$(curl -q --globoff --proto '=http' --noproxy '*' --silent --max-time 4 --output /dev/null --write-out '%{http_code}' "$url"); then
    printf '%s unreachable\n' "$url"
    return 1
  fi
  printf '%s HTTP %s\n' "$url" "$code"
  [[ "$code" == 2[0-9][0-9] ]]
}

probe() {
  if ! "${ctl[@]}" is-active --quiet "$1"; then
    printf '%s is not active\n' "$1"
    return 1
  fi
  case "$1" in
    "$gateway") http_probe "${ACS_STACK_GATEWAY_URL:-http://127.0.0.1:3000/readyz}" ;;
    "$bridge") http_probe "${ACS_STACK_MCP_URL:-http://127.0.0.1:8003/healthz}" ;;
    "$proxy") http_probe "${ACS_STACK_PROXY_URL:-http://127.0.0.1:8010/jc/ready}" ;;
    "$display")
      local x_display=${ACS_STACK_X_DISPLAY:-}
      if [[ -z "$x_display" ]]; then
        printf 'Active (set ACS_STACK_X_DISPLAY to probe X11)\n'
      elif [[ ! "$x_display" =~ ^:[0-9]+([.][0-9]+)?$ ]]; then
        printf 'Expected a local X display, such as :10\n'
        return 1
      elif XAUTHORITY="${ACS_STACK_X_AUTHORITY:-${XAUTHORITY:-$HOME/.Xauthority}}" \
        timeout 4s xdpyinfo -display "$x_display" >/dev/null 2>&1; then
        printf 'X11 display %s responded\n' "$x_display"
      else
        printf 'X11 display %s did not respond to an authorized query\n' "$x_display"
        return 1
      fi
      ;;
  esac
}

recent_failures() {
  journalctl --no-pager --boot --user-unit="$1" --priority=warning --lines=5 --output=with-unit
}

wait_ready() {
  local unit=$1 result deadline=$((SECONDS + 30))
  while ! result=$(probe "$unit"); do
    if ((SECONDS >= deadline)); then
      printf '%s: %s\n' "$unit" "$result" >&2
      recent_failures "$unit" >&2 || true
      fail "$unit did not become ready"
      return 1
    fi
    sleep 1
  done
  printf '%s: %s\n' "$unit" "$result"
}

start_stack() {
  if ! "${ctl[@]}" start "$gateway" "$display" "$bridge"; then
    fail 'could not start the upstream services'
    return 1
  fi
  local unit
  for unit in "$gateway" "$display" "$bridge"; do
    wait_ready "$unit" || return 1
  done
  if ! "${ctl[@]}" start "$proxy"; then
    fail "could not start $proxy"
    return 1
  fi
  wait_ready "$proxy" || return 1
  if ! "${ctl[@]}" start "$target" || ! "${ctl[@]}" is-active --quiet "$target"; then
    fail "could not activate $target"
    return 1
  fi
  for unit in "${services[@]}"; do
    if ! "${ctl[@]}" is-active --quiet "$unit"; then
      fail "$unit is no longer active"
      return 1
    fi
  done
  printf '%s active\n' "$target"
}

stop_stack() {
  local unit state relations dependent
  local -a related
  # Check the current manager graph before taking down the stack.
  for unit in "${services[@]}" "$target"; do
    relations=$("${ctl[@]}" show "$unit" --value \
      --property=RequiredBy,RequisiteOf,BoundBy,ConsistsOf,PropagatesStopTo) || return 1
    while IFS= read -r -a related; do
      for dependent in "${related[@]}"; do
        if [[ " ${services[*]} $target " != *" $dependent "* ]]; then
          fail "stopping $unit could stop unmanaged unit $dependent"
          return 1
        fi
      done
    done <<<"$relations"
  done

  for unit in "$proxy" "$bridge" "$display" "$gateway" "$target"; do
    if ! "${ctl[@]}" stop "$unit"; then
      fail "could not stop $unit"
      return 1
    fi
    if ! state=$("${ctl[@]}" show "$unit" --property=ActiveState --value) || [[ "$state" != inactive && "$state" != failed ]]; then
      fail "$unit did not stop (state: ${state:-unknown})"
      return 1
    fi
    printf '%s: %s\n' "$unit" "$state"
  done
}

show_status() {
  local unit result=0
  "${ctl[@]}" show "$target" "${services[@]}" \
    --property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,NRestarts,Result || result=1
  printf '\nHealth\n'
  for unit in "${services[@]}"; do
    printf '  %s: ' "$unit"
    probe "$unit" || result=1
  done
  "${ctl[@]}" is-active --quiet "$target" || result=1
  printf '\nWarnings and failures from this boot (up to five per service)\n'
  for unit in "${services[@]}"; do
    printf '\n%s\n' "$unit"
    recent_failures "$unit" || result=1
  done
  return "$result"
}

show_logs() {
  local unit
  local -a filters=()
  for unit in "${services[@]}"; do
    filters+=("--user-unit=$unit")
  done
  journalctl --no-pager --output=with-unit --lines=100 "${filters[@]}" "$@"
}

main() {
  local action=${1:-}
  case "$action" in
    -h | --help | help)
      if (($# == 1)); then
        usage
        return 0
      fi
      ;;
    start | stop | restart | status)
      if (($# == 1)); then
        ensure_manager || return 1
        case "$action" in
          status) show_status ;;
          *)
            exec 9>"$XDG_RUNTIME_DIR/acs-stack.lock"
            flock --exclusive --timeout 120 9 || {
              fail 'another stack operation holds the lock'
              return 1
            }
            case "$action" in
              start) start_stack ;;
              stop) stop_stack ;;
              restart) stop_stack && start_stack ;;
            esac
            ;;
        esac
        return $?
      fi
      ;;
    logs)
      if (($# == 1)) || { (($# == 2)) && [[ "$2" == --follow ]]; }; then
        shift
        show_logs "$@"
        return $?
      fi
      ;;
  esac
  usage >&2
  return 2
}

main "$@"
