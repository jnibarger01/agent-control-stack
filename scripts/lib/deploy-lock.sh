#!/usr/bin/env bash
# Deploy-lock directory selection for scripts/deploy-gateway-release.sh. Sourced by the script and by its sandbox test.
#
# The lock must be one file per service unit that every caller agrees on, in a directory only this account can write:
# otherwise another local user could pre-create the directory (or plant the lock file as a symlink) and have the
# deploy truncate a file it should never touch, or run a second deploy under a different lock.

# True when $1 is a real directory (not a symlink), owned by the current uid, with mode 700.
lock_dir_is_secure() {
  local dir="$1"
  [[ -d "$dir" && ! -L "$dir" && "$(stat -c %u "$dir")" == "$(id -u)" && "$(stat -c %a "$dir")" == "700" ]]
}

# choose_lock_dir <run_user_dir> <fallback_dir>
# Prints the directory to hold the lock. Prefers the account's runtime directory; otherwise creates the fallback with
# mode 700. An existing directory that is not private to this account is refused, never reused or "repaired".
choose_lock_dir() {
  local run_dir="$1" fallback="$2"
  if [[ -d "$run_dir" && -w "$run_dir" ]]; then
    lock_dir_is_secure "$run_dir" || { echo "refusing to lock in $run_dir: not a private directory owned by uid $(id -u)" >&2; return 1; }
    printf '%s\n' "$run_dir"
    return 0
  fi
  if [[ ! -e "$fallback" && ! -L "$fallback" ]]; then
    mkdir -m 700 "$fallback" || return 1
  fi
  lock_dir_is_secure "$fallback" || { echo "refusing to lock in $fallback: not a private directory owned by uid $(id -u)" >&2; return 1; }
  printf '%s\n' "$fallback"
}

# db_open_by_others <db path>
# Prints "pid(command)" for every other process that has the database, or its -wal/-shm/-journal sidecar, open. Reads
# /proc directly (no fuser/lsof dependency); processes this account cannot inspect are not visible, which is why the
# deploy also requires the unit itself to be stopped.
db_open_by_others() {
  local real fd pid
  real="$(realpath -m "$1")"
  while IFS= read -r fd; do
    pid="${fd#/proc/}"; pid="${pid%%/*}"
    [[ "$pid" == "$$" || "$pid" == "${BASHPID:-}" ]] && continue
    printf '%s(%s)\n' "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null || echo '?')"
  done < <(find /proc -maxdepth 3 -path '/proc/[0-9]*/fd/*' \
             \( -lname "$real" -o -lname "$real-wal" -o -lname "$real-shm" -o -lname "$real-journal" \) 2>/dev/null) | sort -u
}
