#!/usr/bin/env bash
# Build, seal, smoke-test and activate an immutable ACS gateway release for the local systemd user service.
#
#   scripts/deploy-gateway-release.sh [--ref <git-ref>] [--label <name>] [--no-activate] [--resume]
#
#   --resume  activate an already published release (same --ref/--label) without rebuilding. Use it after an
#             activation was interrupted once the database may already be migrated: the previous release can no
#             longer read that database, so the only way is forward.
#
# Phases (see docs/runbooks/release-integrity.md for the sealing rules):
#   1. stage    git archive of the exact commit -> releases/_staging, npm ci + build with the pinned Node
#   2. seal     release-integrity create + verify
#   3. smoke    run the staged gateway on a loopback port against a COPY of the live database, isolated HOME,
#               and check liveness, readiness, roster heartbeats and the Dispatch preview route
#   4. activate publish to releases/acs/<sha7>-<label>, back up the database and the current drop-in, install
#               the release + dispatch drop-ins, restart, health-check; roll the drop-ins back on failure
#
# Only committed content is built. Safety behavior to know before running it:
#   - One deploy at a time per service unit AND per database (lock files in the account's private /run/user/<uid>,
#     keyed by the unit name and by the database's canonical path).
#   - The live database is backed up before activation. If activation fails, rollback AUTOMATICALLY restores that
#     backup over the live database (using the previous release's db-ops, which understands the old schema; never
#     the new release's: with no previous db-ops it restores nothing and leaves the unit stopped),
#     because the failed release may already have migrated it and the previous release cannot read a migrated
#     database. Any write made between the backup and the rollback is LOST; the output names the backup.
#     With --resume there is no new backup and nothing is restored: only the drop-ins and unit are left as they are.
#   - Rollback also puts the previous drop-ins back, or removes the ones this run installed when none existed before
#     (a first deployment, or no dispatch drop-in yet). Before it restores the database it requires the unit to be
#     really stopped and no other process to hold the database open; otherwise it restores nothing, starts nothing and
#     leaves everything for an operator. If the database restore itself fails, the unit is LEFT STOPPED (starting the
#     previous release against a possibly migrated database would serve and could mutate it); restore the database by
#     hand, then start the unit.
#   - The installed dispatch drop-in sets ACS_AGENT_DISPATCH_ENABLED from ACS_DEPLOY_DISPATCH_ENABLED (0 or 1,
#     default 0): the installed gateway launches host coding CLIs only when the operator opts in.
set -euo pipefail

REF="HEAD"
LABEL="heartbeat-dispatch"
ACTIVATE=1
RESUME=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --no-activate) ACTIVATE=0; shift ;;
    --resume) RESUME=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid --label" >&2; exit 2; }

# The sandbox test is the only caller allowed to relocate state (lock directory) or skip phases (prebuilt stage). It must
# say so (ACS_DEPLOY_TEST_MODE=1) AND run under a HOME that is not the real account home, so neither can happen in a real
# operator environment even if the variables leak into it.
real_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
IN_SANDBOX=0
if [[ "${ACS_DEPLOY_TEST_MODE:-}" == "1" && "$HOME" != "$real_home" ]]; then IN_SANDBOX=1; fi

# ACS_DEPLOY_PREBUILT_STAGE skips the build, seal and smoke-test phases and publishes the given directory as is.
if [[ -n "${ACS_DEPLOY_PREBUILT_STAGE:-}" && "$IN_SANDBOX" -ne 1 ]]; then
  echo "ACS_DEPLOY_PREBUILT_STAGE is only honored by the sandbox test (ACS_DEPLOY_TEST_MODE=1 and a non-account HOME); refusing" >&2
  exit 2
fi

REPO="$(git rev-parse --show-toplevel)"
RELEASES="${ACS_RELEASES_DIR:-$HOME/releases}"
NODE_BIN_DIR="${ACS_RELEASE_NODE_DIR:-$RELEASES/_node/v24.18.0/bin}"
UNIT="${ACS_GATEWAY_UNIT:-acs-gateway.service}"
UNIT_DIR="$HOME/.config/systemd/user"
DROPIN_DIR="$UNIT_DIR/$UNIT.d"
ENV_FILE="${ACS_GATEWAY_ENV_FILE:-$HOME/.config/agent-control-stack/gateway.env}"
DISPATCH_ROOTS="${ACS_AGENT_REPO_ROOTS:-$HOME/projects}"
# Whether the INSTALLED gateway may launch host coding CLIs. Off unless the operator says so; the smoke test always runs
# with dispatch on (it uses a copy of the database and an isolated HOME) so the route stays covered.
DISPATCH_ENABLED="${ACS_DEPLOY_DISPATCH_ENABLED:-0}"
[[ "$DISPATCH_ENABLED" == "0" || "$DISPATCH_ENABLED" == "1" ]] || { echo "ACS_DEPLOY_DISPATCH_ENABLED must be 0 or 1" >&2; exit 2; }
SMOKE_PORT="${ACS_SMOKE_PORT:-3999}"
# The PATH the systemd drop-in installs; the smoke test uses the same one to prove the CLIs are visible to the service.
# Defined here, not in the build block, because --resume installs the drop-in without building.
AGENT_PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# One deploy at a time per service unit. The lock is keyed by the unit and lives in the account's private runtime directory,
# NOT under the (configurable) releases directory: two invocations with different ACS_RELEASES_DIR still target the same
# unit, drop-ins and database and must exclude each other. Two same-label runs once raced on the publish step.
# The directory is derived from the account, never from caller-controlled environment (TMPDIR, XDG_RUNTIME_DIR). Only the
# sandbox may relocate it, and an existing directory that is not private to this account is refused (see lib/deploy-lock.sh).
# shellcheck source=lib/deploy-lock.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-lock.sh"
if [[ "$IN_SANDBOX" -eq 1 && -n "${XDG_RUNTIME_DIR:-}" ]]; then
  LOCK_DIR="$XDG_RUNTIME_DIR"
else
  LOCK_DIR="$(choose_lock_dir "/run/user/$(id -u)" "/tmp/acs-deploy-$(id -u)")" || exit 1
fi
LOCK_FILE="$LOCK_DIR/acs-deploy-$UNIT.lock"
[[ ! -L "$LOCK_FILE" ]] || { echo "refusing to lock: $LOCK_FILE is a symlink" >&2; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another deploy of $UNIT is already running (lock: $LOCK_FILE)" >&2; exit 1; }

SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
RELEASE_NAME="$SHORT-$LABEL"
FINAL="$RELEASES/acs/$RELEASE_NAME"
# ACS_DEPLOY_PREBUILT_STAGE (tests): treat this directory as an already built, sealed and smoke-tested stage.
STAGE="${ACS_DEPLOY_PREBUILT_STAGE:-$RELEASES/_staging/$RELEASE_NAME.$$}"
SMOKE_DIR=""
SMOKE_PID=""

log() { printf '\n==> %s\n' "$*"; }
cleanup() {
  # Must return 0: this is the EXIT trap, and a false last test would turn a successful run into exit 1.
  if [[ -n "$SMOKE_PID" ]]; then kill "$SMOKE_PID" 2>/dev/null || true; fi
  if [[ -n "$SMOKE_DIR" ]]; then rm -rf "$SMOKE_DIR"; fi
  return 0
}
trap cleanup EXIT

[[ -x "$NODE_BIN_DIR/node" ]] || { echo "pinned node not found: $NODE_BIN_DIR/node" >&2; exit 1; }
if [[ "$RESUME" -eq 1 ]]; then
  [[ -d "$FINAL" ]] || { echo "--resume: no published release at $FINAL" >&2; exit 1; }
else
  [[ ! -e "$FINAL" ]] || { echo "release already exists: $FINAL (pick another --label, or use --resume)" >&2; exit 1; }
fi
[[ -f "$ENV_FILE" ]] || { echo "gateway env file not found: $ENV_FILE" >&2; exit 1; }
export PATH="$NODE_BIN_DIR:$PATH"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
LIVE_DB="${ACS_DB_PATH:?ACS_DB_PATH missing from $ENV_FILE}"
# The gateway resolves a relative ACS_DB_PATH against its systemd WorkingDirectory, which this deploy changes to the new
# release directory. The lock, backup and automatic restore below would then act on a different file than the live
# database (a rollback could "succeed" while the real database stays migrated). Refuse before touching anything.
if [[ "$LIVE_DB" != /* ]]; then
  echo "ACS_DB_PATH in $ENV_FILE must be an absolute path (got '$LIVE_DB'): a relative path resolves differently for the gateway than for this deploy" >&2
  exit 2
fi

# Second lock, keyed by the database itself. Two different units (or env files) can point at one database; each would
# take its own unit lock, yet both back up, migrate and possibly restore that database. Key it by the canonical path.
DB_KEY="$(printf '%s' "$(realpath -m "$LIVE_DB")" | sha256sum | cut -c1-16)"
DB_LOCK_FILE="$LOCK_DIR/acs-deploy-db-$DB_KEY.lock"
[[ ! -L "$DB_LOCK_FILE" ]] || { echo "refusing to lock: $DB_LOCK_FILE is a symlink" >&2; exit 1; }
exec 8>"$DB_LOCK_FILE"
flock -n 8 || { echo "another deploy using database $LIVE_DB is already running (lock: $DB_LOCK_FILE)" >&2; exit 1; }

if [[ "$RESUME" -eq 0 && -z "${ACS_DEPLOY_PREBUILT_STAGE:-}" ]]; then
log "stage $RELEASE_NAME from $SHA"
mkdir -p "$STAGE"
git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE"
# The gateway env file (sourced above for LIVE_DB and the smoke test) sets NODE_ENV=production, which would make
# npm ci skip the dev dependencies the build needs. Build with it unset.
(cd "$STAGE" && env -u NODE_ENV npm ci --no-audit --no-fund && env -u NODE_ENV npm run build)

log "seal"
(cd "$STAGE" \
  && node scripts/release-integrity.mjs create "$STAGE" "$SHA" "$NODE_BIN_DIR/node" acs \
  && node scripts/release-integrity.mjs verify "$STAGE" --allow-staging)

# ---- smoke ----------------------------------------------------------------------------------------------
log "smoke test on 127.0.0.1:$SMOKE_PORT against a copy of the live database"
SMOKE_DIR="$(mktemp -d)"
sqlite3 "$LIVE_DB" ".backup '$SMOKE_DIR/control.db'"

SMOKE_TOKEN="${ACS_GATEWAY_TOKEN:-}"
(
  cd "$STAGE"
  # No Desktop Commander or tunnel wiring: the smoke gateway must not contend with the live runtime.
  for name in $(compgen -e | grep -E '^ACS_(DESKTOP_COMMANDER|JACE_COMMANDER)_'); do unset "$name"; done
  export HOME="$SMOKE_DIR/home" && mkdir -p "$HOME"
  export ACS_DB_PATH="$SMOKE_DIR/control.db" HOST=127.0.0.1 PORT="$SMOKE_PORT"
  unset ACS_EXECUTION_BACKEND
  export ACS_AGENT_DISPATCH_ENABLED=1 ACS_AGENT_REPO_ROOTS="$DISPATCH_ROOTS" ACS_ACTOR_DISCOVERY_INTERVAL_MS=2000
  export PATH="$AGENT_PATH"
  exec "$NODE_BIN_DIR/node" apps/gateway/dist/cli.js
) >"$SMOKE_DIR/gateway.log" 2>&1 &
SMOKE_PID=$!

base="http://127.0.0.1:$SMOKE_PORT"
for _ in $(seq 1 60); do curl -fsS -m 2 "$base/livez" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 5 "$base/livez" >/dev/null || { echo "smoke gateway did not come up:" >&2; tail -30 "$SMOKE_DIR/gateway.log" >&2; exit 1; }
auth=(-H "authorization: Bearer $SMOKE_TOKEN")

# Heartbeats: the in-process loop must bring CLIs online without anything else running. Discovery probes the CLIs
# concurrently, so one sweep is bounded by a single probe timeout (10s); allow several sweeps' worth of headroom.
online=0
for _ in $(seq 1 "${ACS_SMOKE_ROSTER_WAIT_SEC:-45}"); do
  online="$(curl -fsS -m 5 "${auth[@]}" "$base/api/agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents??[];console.log(a.filter(x=>x.status==="AVAILABLE").length)})')"
  [[ "$online" -gt 0 ]] && break
  sleep 1
done
[[ "$online" -gt 0 ]] || { echo "smoke FAILED: no agent became AVAILABLE (heartbeat loop or PATH)" >&2; tail -30 "$SMOKE_DIR/gateway.log" >&2; exit 1; }
echo "smoke: $online agent(s) AVAILABLE"

repo_probe="$(find "$DISPATCH_ROOTS" -maxdepth 2 -name .git -prune -print -quit 2>/dev/null | xargs -r dirname)"
[[ -n "$repo_probe" ]] || { echo "smoke FAILED: no git repository under $DISPATCH_ROOTS" >&2; exit 1; }
code="$(curl -sS -m 20 -o "$SMOKE_DIR/preview.json" -w '%{http_code}' "${auth[@]}" -H 'content-type: application/json' \
  -d "{\"agentId\":\"codex\",\"repo\":\"$repo_probe\",\"mode\":\"read-only\",\"prompt\":\"smoke preview\"}" "$base/api/agent-runs/preview")"
[[ "$code" == "200" ]] || { echo "smoke FAILED: dispatch preview returned HTTP $code: $(head -c 300 "$SMOKE_DIR/preview.json")" >&2; exit 1; }
echo "smoke: dispatch preview OK for $repo_probe"
kill "$SMOKE_PID" 2>/dev/null || true; SMOKE_PID=""

if [[ "$ACTIVATE" -eq 0 ]]; then
  log "smoke passed; --no-activate: release left in $STAGE"
  trap - EXIT; rm -rf "$SMOKE_DIR"
  exit 0
fi

fi

# ---- activate -------------------------------------------------------------------------------------------
if [[ "$RESUME" -eq 0 ]]; then
  log "publish $FINAL"
  mkdir -p "$RELEASES/acs"
  [[ ! -e "$FINAL" ]] || { echo "refusing to publish: $FINAL appeared while this deploy was running" >&2; exit 1; }
  mv -T "$STAGE" "$FINAL"
fi
node "$FINAL/scripts/release-integrity.mjs" verify "$FINAL"

log "back up database and drop-ins"
BACKUP_DB=""
if [[ "$RESUME" -eq 0 ]]; then
  BACKUP_DB="$LIVE_DB.pre-$SHORT-$STAMP"
  sqlite3 "$LIVE_DB" ".backup '$BACKUP_DB'"
  # Rollback-journal mode: the restore tool verifies the backup first, and opening a WAL-mode file leaves -wal/-shm
  # sidecars that the tool's own sidecar check then rejects.
  sqlite3 "$BACKUP_DB" "pragma journal_mode=delete" >/dev/null
  chmod 600 "$BACKUP_DB"
else
  echo "--resume: no new database backup (the database may already be migrated; keep the earlier pre-$SHORT backup)"
fi
RELEASE_DROPIN="$DROPIN_DIR/40-immutable-release.conf"
DISPATCH_DROPIN="$DROPIN_DIR/50-agent-dispatch.conf"
# Remember what existed before this deploy. On a first deployment there is no release drop-in to restore, and rollback must
# then REMOVE the one this run installs, or it would start the failed release again.
HAD_RELEASE_DROPIN=0
HAD_DISPATCH_DROPIN=0
if [[ -f "$RELEASE_DROPIN" ]]; then HAD_RELEASE_DROPIN=1; cp -p "$RELEASE_DROPIN" "$RELEASE_DROPIN.pre-$SHORT-$STAMP"; fi
if [[ -f "$DISPATCH_DROPIN" ]]; then HAD_DISPATCH_DROPIN=1; cp -p "$DISPATCH_DROPIN" "$DISPATCH_DROPIN.pre-$SHORT-$STAMP"; fi
# The release the unit runs today (from the base unit or the current drop-in), for the rollback's database tool.
PREV_WORKDIR="$(systemctl --user show -p WorkingDirectory --value "$UNIT" 2>/dev/null || true)"

BASE_URL="http://127.0.0.1:${PORT:-3000}"

# Wait for the unit to start listening. Startup verifies the release, migrates the database and boots, so
# /livez is not reachable the moment systemctl returns. Give up early if systemd is crash-looping the unit.
# NRestarts is cumulative: restarts from an earlier incident would otherwise look like a crash loop on the very first
# miss and trigger a destructive rollback. Measure increments against the value taken just before this (re)start.
restart_count() {
  local n
  n="$(systemctl --user show -p NRestarts --value "$UNIT" 2>/dev/null || true)"
  printf '%s\n' "${n:-0}"
}
RESTARTS_BASE=0

wait_live() {
  local deadline=$((SECONDS + ${ACS_DEPLOY_WAIT_SEC:-180})) restarts
  until curl -fsS -m 3 "$BASE_URL/livez" >/dev/null 2>&1; do
    restarts=$(( $(restart_count) - RESTARTS_BASE ))
    if (( restarts >= 3 )); then echo "unit is crash-looping ($restarts restarts since this activation began)" >&2; return 1; fi
    if (( SECONDS > deadline )); then echo "timed out waiting for $BASE_URL/livez" >&2; return 1; fi
    sleep 2
  done
}

# Same wait, but on /readyz: a previous release started against a schema it cannot read still answers /livez and only
# reports the problem through readiness.
wait_ready() {
  local deadline=$((SECONDS + ${ACS_DEPLOY_WAIT_SEC:-180})) restarts
  until curl -fsS -m 3 "$BASE_URL/readyz" >/dev/null 2>&1; do
    restarts=$(( $(restart_count) - RESTARTS_BASE ))
    if (( restarts >= 3 )); then echo "unit is crash-looping ($restarts restarts since this activation began)" >&2; return 1; fi
    if (( SECONDS > deadline )); then echo "timed out waiting for $BASE_URL/readyz" >&2; return 1; fi
    sleep 2
  done
}

rollback() {
  journalctl --user -u "$UNIT" --since "-3min" --no-pager 2>/dev/null | tail -25 >&2 || true
  if [[ -z "$BACKUP_DB" ]]; then
    echo "NOT rolling back: --resume has no pre-activation backup, and the previous release cannot read a migrated database." >&2
    return 0
  fi
  echo "ROLLING BACK. If the failed release got far enough to migrate the database, the previous release cannot read it," >&2
  echo "so the database is restored from $BACKUP_DB (writes since that backup are lost) - but only once nothing else can write it." >&2

  # --writers-stopped is an attestation, so earn it: the unit must really be stopped and no other process may hold the
  # database. Otherwise an idle writer could slip past the restore tool's momentary lock check and keep writing the
  # replaced database (or its old inode). Failing any of this leaves everything stopped for an operator.
  local stop_ok=1 holders="" restored=0 reason=""
  systemctl --user stop "$UNIT" || stop_ok=0
  if systemctl --user is-active --quiet "$UNIT"; then stop_ok=0; fi
  if [[ "$stop_ok" -eq 1 ]]; then holders="$(db_open_by_others "$LIVE_DB")"; fi

  if [[ "$stop_ok" -eq 0 ]]; then
    reason="$UNIT did not stop. Not restoring the database and not starting anything"
  elif [[ -n "$holders" ]]; then
    reason="the database is still open by other process(es): $(printf '%s' "$holders" | tr '\n' ' '). Leaving $UNIT STOPPED"
  else
    # Restore with the PREVIOUS release's tool: it verifies the backup against the numbering that release wrote.
    # The new release's tool rejects a pre-migration backup as migration_missing.
    local prev_dir="$PREV_WORKDIR"
    if [[ ( -z "$prev_dir" || ! -f "$prev_dir/scripts/db-ops.mjs" ) && -f "$RELEASE_DROPIN.pre-$SHORT-$STAMP" ]]; then
      prev_dir="$(sed -n 's/^WorkingDirectory=//p' "$RELEASE_DROPIN.pre-$SHORT-$STAMP" | head -1)"
    fi
    # Never fall back to the NEW release's tool ($FINAL): it is the release that just failed. Without a previous
    # release's db-ops, fail closed and leave the restore to an operator.
    if [[ "$prev_dir" == "$FINAL" ]]; then prev_dir=""; fi
    if [[ -z "$prev_dir" || ! -f "$prev_dir/scripts/db-ops.mjs" ]]; then
      reason="no previous release db-ops was found (the new release's tool is never used for rollback). Leaving $UNIT STOPPED"
    elif node "$prev_dir/scripts/db-ops.mjs" restore "$BACKUP_DB" "$LIVE_DB" --replace --writers-stopped; then
      restored=1
    else
      reason="the restore failed. Leaving $UNIT STOPPED"
    fi
  fi

  if [[ "$HAD_RELEASE_DROPIN" -eq 1 ]]; then cp -p "$RELEASE_DROPIN.pre-$SHORT-$STAMP" "$RELEASE_DROPIN"; else rm -f "$RELEASE_DROPIN"; fi
  if [[ "$HAD_DISPATCH_DROPIN" -eq 1 ]]; then cp -p "$DISPATCH_DROPIN.pre-$SHORT-$STAMP" "$DISPATCH_DROPIN"; else rm -f "$DISPATCH_DROPIN"; fi
  systemctl --user daemon-reload

  if [[ "$restored" -eq 0 ]]; then
    # Fail closed: the previous release cannot safely run against a database the failed release may have migrated. It
    # would still answer /livez and could mutate that database. Leave the unit for an operator.
    echo "DATABASE NOT RESTORED (backup: $BACKUP_DB): $reason. The previous drop-ins are back in place." >&2
    echo "Once nothing else uses the database: restore it by hand from the backup, then: systemctl --user start $UNIT" >&2
    return 0
  fi
  RESTARTS_BASE="$(restart_count)"
  systemctl --user start "$UNIT" || true
  wait_ready || echo "previous release did not become ready; inspect: journalctl --user -u $UNIT" >&2
}

log "install drop-ins"
cat >"$RELEASE_DROPIN" <<EOF
[Service]
WorkingDirectory=$FINAL
ExecStartPre=
ExecStartPre=$RELEASES/_node/v24.18.0/bin/node $FINAL/scripts/release-integrity.mjs verify $FINAL
ExecStart=
ExecStart=$RELEASES/_node/v24.18.0/bin/node $FINAL/apps/gateway/dist/cli.js
EOF
cat >"$DISPATCH_DROPIN" <<EOF
[Service]
# The gateway must see the agent CLIs (Homebrew and ~/.local/bin are not on a systemd user service's default PATH).
Environment=PATH=$AGENT_PATH
Environment=ACS_AGENT_DISPATCH_ENABLED=$DISPATCH_ENABLED
Environment=ACS_AGENT_REPO_ROOTS=$DISPATCH_ROOTS
EOF

log "restart $UNIT"
systemctl --user daemon-reload
RESTARTS_BASE="$(restart_count)"
if ! systemctl --user restart "$UNIT" || ! wait_live || ! "$REPO/scripts/gateway-post-deploy-healthcheck.sh" "$BASE_URL"; then
  rollback
  exit 1
fi

log "verify live roster"
sleep 5
live_online="$(curl -fsS -m 5 -H "authorization: Bearer ${ACS_GATEWAY_TOKEN:-}" "$BASE_URL/api/agents" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents??[];console.log(a.filter(x=>x.status==="AVAILABLE").length)})' || echo 0)"
echo "live gateway: $live_online agent(s) AVAILABLE"
echo
echo "Deployed $RELEASE_NAME. Database backup: $BACKUP_DB"
if [[ "$HAD_RELEASE_DROPIN" -eq 1 ]]; then rel_step="restore $RELEASE_DROPIN.pre-$SHORT-$STAMP over $RELEASE_DROPIN"; else rel_step="remove $RELEASE_DROPIN"; fi
if [[ "$HAD_DISPATCH_DROPIN" -eq 1 ]]; then disp_step="restore $DISPATCH_DROPIN.pre-$SHORT-$STAMP over $DISPATCH_DROPIN"; else disp_step="remove $DISPATCH_DROPIN"; fi
echo "Rollback: $rel_step, $disp_step, systemctl --user daemon-reload && systemctl --user restart $UNIT"
