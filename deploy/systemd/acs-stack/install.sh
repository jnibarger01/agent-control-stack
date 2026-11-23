#!/usr/bin/env bash
set -euo pipefail
umask 077

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly source_dir
readonly unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
readonly bin_dir="$HOME/.local/bin"
readonly receipt="${XDG_STATE_HOME:-$HOME/.local/state}/acs-stack"
readonly target=acs-stack.target
readonly target_link="$unit_dir/default.target.wants/$target"
readonly command_path="$bin_dir/acs-stack"
readonly proxy=jace-commander-auth-proxy.service
readonly -a services=(acs-recovery.service acs-computer-use-xvfb.service jace-commander-mcp.service "$proxy")
readonly -a ctl=(systemctl --user --no-ask-password --no-pager)

fail() {
  printf 'acs-stack installer: %s\n' "$*" >&2
  exit 1
}

exists() {
  [[ -e "$1" || -L "$1" ]]
}

same_link() {
  [[ -L "$2" && "$(readlink -- "$2")" == "$(readlink -- "$1")" ]]
}

owned_file() {
  [[ -f "$2" && ! -L "$2" ]] && cmp -s -- "$1" "$2"
}

check_receipt_paths() {
  cmp -s -- "$receipt/paths" <(printf '%s\0' "$unit_dir" "$command_path") ||
    fail "use the same account and configuration paths as the original installation"
}

verify_layout() {
  local unit
  owned_file "$source_dir/$target" "$unit_dir/$target" || fail "different target already installed"
  owned_file "$source_dir/acs-stack.sh" "$command_path" && [[ -x "$command_path" ]] ||
    fail "different or non-executable operator command already installed"
  [[ -L "$target_link" && "$(readlink -- "$target_link")" == "$unit_dir/$target" ]] ||
    fail "unexpected startup link for $target"
  for unit in "${services[@]}"; do
    if exists "$unit_dir/default.target.wants/$unit"; then
      fail "direct startup link still exists for $unit"
    fi
  done
}

verify_graph() {
  local unit wants after default_wants fragment drop_ins
  fragment=$("${ctl[@]}" show "$target" --property=FragmentPath --value) || return 1
  drop_ins=$("${ctl[@]}" show "$target" --property=DropInPaths --value) || return 1
  [[ "$fragment" == "$unit_dir/$target" && -z "$drop_ins" ]] || return 1
  wants=$("${ctl[@]}" show "$target" --property=Wants --value) || return 1
  after=$("${ctl[@]}" show "$target" --property=After --value) || return 1
  default_wants=$("${ctl[@]}" show default.target --property=Wants --value) || return 1
  for unit in "${services[@]}"; do
    [[ " $wants " == *" $unit "* && " $after " == *" $unit "* ]] || return 1
  done
  # Reject any additional wanted unit, including one injected by a drop-in.
  [[ $(wc -w <<<"$wants") -eq ${#services[@]} && " $default_wants " == *" $target "* ]]
}

restore() {
  local unit link
  for unit in "$target" acs-stack.sh; do
    case "$unit" in
      "$target") link="$unit_dir/$target" ;;
      acs-stack.sh) link="$command_path" ;;
    esac
    if exists "$link" && ! owned_file "$receipt/$unit" "$link"; then
      printf 'Refusing to remove an edited or foreign file at %s\n' "$link" >&2
      return 1
    fi
  done
  if exists "$target_link" && [[ ! -L "$target_link" || "$(readlink -- "$target_link")" != "$unit_dir/$target" ]]; then
    printf 'Refusing to remove a foreign link at %s\n' "$target_link" >&2
    return 1
  fi
  for unit in "${services[@]}"; do
    [[ -L "$receipt/$unit" ]] || continue
    link="$unit_dir/default.target.wants/$unit"
    if exists "$link" && ! same_link "$receipt/$unit" "$link"; then
      printf 'Cannot restore %s over an existing entry\n' "$link" >&2
      return 1
    fi
  done
  for unit in "${services[@]}"; do
    link="$unit_dir/default.target.wants/$unit"
    if [[ -L "$receipt/$unit" ]] && ! exists "$link"; then
      cp -P -- "$receipt/$unit" "$link" || return 1
    fi
  done
  rm -f -- "$target_link" "$unit_dir/$target" "$command_path" || return 1
  "${ctl[@]}" daemon-reload || return 1

  # Retire the receipt only after systemd has loaded the restored startup layout.
  mv -T -- "$receipt" "$scratch/receipt" || return 1
}

finish() {
  local result=$1
  trap - EXIT HUP INT TERM
  if ((result != 0 && installing)); then
    if restore; then
      printf 'Previous startup links restored.\n' >&2
    else
      printf 'Automatic rollback incomplete. Preserve %s and retry uninstall.\n' "$receipt" >&2
    fi
  fi
  rm -rf -- "$scratch"
  exit "$result"
}

install_file() {
  local source=$1 dest=$2 mode=$3 tmp result=0
  tmp=$(mktemp --tmpdir="$(dirname -- "$dest")" .acs-stack.XXXXXXXX)
  install -m "$mode" -- "$source" "$tmp" && ln -T -- "$tmp" "$dest" || result=1
  rm -f -- "$tmp"
  return "$result"
}

install_controller() {
  local path unit link after
  if exists "$receipt"; then
    [[ -d "$receipt" && ! -L "$receipt" && -f "$receipt/installed" ]] ||
      fail "an incomplete installation exists; run uninstall to recover"
    check_receipt_paths
    verify_layout
    verify_graph || fail "the installed startup graph has changed"
    printf 'ACS startup controller already installed.\n'
    return
  fi

  for path in "$unit_dir/$target" "$command_path" "$target_link"; do
    if exists "$path"; then fail "refusing to overwrite $path"; fi
  done
  [[ $("${ctl[@]}" show "$target" --property=LoadState --value) == not-found ]] ||
    fail "a target with the same name already exists"
  for unit in "${services[@]}"; do
    [[ $("${ctl[@]}" show "$unit" --property=LoadState --value) == loaded ]] ||
      fail "$unit must be installed and loadable"
  done
  after=$("${ctl[@]}" show "$proxy" --property=After --value)
  [[ " $after " == *" acs-recovery.service "* && " $after " == *" jace-commander-mcp.service "* ]] ||
    fail "$proxy must be ordered after the ACS gateway and MCP bridge"

  bash -n "$source_dir/acs-stack.sh"
  systemd-analyze --user verify "$source_dir/$target"
  mkdir -- "$scratch/before"
  cp -- "$source_dir/$target" "$source_dir/acs-stack.sh" "$scratch/before/"
  printf '%s\0' "$unit_dir" "$command_path" >"$scratch/before/paths"
  for unit in "${services[@]}"; do
    link="$unit_dir/default.target.wants/$unit"
    if exists "$link"; then
      [[ -L "$link" && -f "$link" && "$(basename -- "$(readlink -- "$link")")" == "$unit" ]] ||
        fail "unexpected startup entry at $link"
      cp -P -- "$link" "$scratch/before/$unit"
    fi
  done
  mv -T -- "$scratch/before" "$receipt"
  installing=1

  mkdir -p -- "$unit_dir/default.target.wants" "$bin_dir"
  install_file "$source_dir/$target" "$unit_dir/$target" 644
  install_file "$source_dir/acs-stack.sh" "$command_path" 755
  ln -sT -- "$unit_dir/$target" "$target_link"
  "${ctl[@]}" daemon-reload
  systemd-analyze --user verify "$unit_dir/$target" default.target
  verify_graph || fail "new startup graph failed verification"

  for unit in "${services[@]}"; do
    link="$unit_dir/default.target.wants/$unit"
    if [[ -L "$receipt/$unit" ]]; then
      same_link "$receipt/$unit" "$link" || fail "startup entry changed at $link"
      rm -- "$link"
    fi
  done
  "${ctl[@]}" daemon-reload
  verify_layout
  verify_graph || fail "startup graph failed verification after cutover"
  touch -- "$receipt/installed"
  installing=0
  printf 'Enabled %s and installed %s. Prior startup links saved in %s.\n' "$target" "$command_path" "$receipt"
}

main() {
  if (($# != 1)) || [[ "$1" != install && "$1" != uninstall ]]; then
    printf 'Usage: %s {install|uninstall}\n' "${0##*/}" >&2
    exit 2
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID}"
  if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} && -S "$XDG_RUNTIME_DIR/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  "${ctl[@]}" show --property=Version --value >/dev/null || fail "cannot reach the user systemd manager"
  exec 9>"$XDG_RUNTIME_DIR/acs-stack.lock"
  flock --exclusive --timeout 120 9 || fail "another stack operation holds the lock"

  if [[ "$1" == uninstall ]]; then
    if ! exists "$receipt"; then
      printf 'No installer receipt; no files changed.\n'
      return
    fi
    [[ -d "$receipt" && ! -L "$receipt" && -f "$receipt/$target" && -f "$receipt/acs-stack.sh" ]] ||
      fail "installation receipt is missing expected files"
    check_receipt_paths
  fi
  mkdir -p -- "$(dirname -- "$receipt")"
  scratch=$(mktemp -d --tmpdir="$(dirname -- "$receipt")" .acs-stack.XXXXXXXX)
  installing=0
  trap 'finish "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  case "$1" in
    install) install_controller ;;
    uninstall)
      restore || fail "rollback could not complete; preserve $receipt"
      printf 'Restored prior startup links and removed controller files.\n'
      ;;
  esac
}

main "$@"
