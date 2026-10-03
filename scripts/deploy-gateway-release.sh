#!/usr/bin/env bash
# Build, seal, smoke-test and activate an immutable ACS gateway release for the local systemd user service.
#
#   scripts/deploy-gateway-release.sh [--ref <git-ref>] [--label <name>] [--no-activate]
#
# Phases (see docs/runbooks/release-integrity.md for the sealing rules):
#   1. stage    git archive of the exact commit -> releases/_staging, npm ci + build with the pinned Node
#   2. seal     release-integrity create + verify
#   3. smoke    run the staged gateway on a loopback port against a COPY of the live database, isolated HOME,
#               and check liveness, readiness, roster heartbeats and the Dispatch preview route
#   4. activate publish to releases/acs/<sha7>-<label>, back up the database and the current drop-in, install
#               the release + dispatch drop-ins, restart, health-check; roll the drop-ins back on failure
#
# Only committed content is built. The live database is backed up before activation and never restored
# automatically (a newer schema may already have been applied); the rollback message names the backup.
set -euo pipefail

REF="HEAD"
LABEL="heartbeat-dispatch"
ACTIVATE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --no-activate) ACTIVATE=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid --label" >&2; exit 2; }

REPO="$(git rev-parse --show-toplevel)"
RELEASES="${ACS_RELEASES_DIR:-$HOME/releases}"
NODE_BIN_DIR="${ACS_RELEASE_NODE_DIR:-$RELEASES/_node/v24.18.0/bin}"
UNIT="${ACS_GATEWAY_UNIT:-acs-gateway.service}"
UNIT_DIR="$HOME/.config/systemd/user"
DROPIN_DIR="$UNIT_DIR/$UNIT.d"
ENV_FILE="${ACS_GATEWAY_ENV_FILE:-$HOME/.config/agent-control-stack/gateway.env}"
DISPATCH_ROOTS="${ACS_AGENT_REPO_ROOTS:-$HOME/projects}"
SMOKE_PORT="${ACS_SMOKE_PORT:-3999}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
RELEASE_NAME="$SHORT-$LABEL"
FINAL="$RELEASES/acs/$RELEASE_NAME"
STAGE="$RELEASES/_staging/$RELEASE_NAME.$$"
SMOKE_DIR=""
SMOKE_PID=""

log() { printf '\n==> %s\n' "$*"; }
cleanup() {
  [[ -n "$SMOKE_PID" ]] && kill "$SMOKE_PID" 2>/dev/null || true
  [[ -n "$SMOKE_DIR" ]] && rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

[[ -x "$NODE_BIN_DIR/node" ]] || { echo "pinned node not found: $NODE_BIN_DIR/node" >&2; exit 1; }
[[ ! -e "$FINAL" ]] || { echo "release already exists: $FINAL (pick another --label)" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "gateway env file not found: $ENV_FILE" >&2; exit 1; }
export PATH="$NODE_BIN_DIR:$PATH"

log "stage $RELEASE_NAME from $SHA"
mkdir -p "$STAGE"
git -C "$REPO" archive "$SHA" | tar -x -C "$STAGE"
(cd "$STAGE" && npm ci --no-audit --no-fund && npm run build)

log "seal"
(cd "$STAGE" \
  && node scripts/release-integrity.mjs create "$STAGE" "$SHA" "$NODE_BIN_DIR/node" acs \
  && node scripts/release-integrity.mjs verify "$STAGE" --allow-staging)

# ---- smoke ----------------------------------------------------------------------------------------------
log "smoke test on 127.0.0.1:$SMOKE_PORT against a copy of the live database"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
LIVE_DB="${ACS_DB_PATH:?ACS_DB_PATH missing from $ENV_FILE}"
SMOKE_DIR="$(mktemp -d)"
sqlite3 "$LIVE_DB" ".backup '$SMOKE_DIR/control.db'"

SMOKE_TOKEN="${ACS_GATEWAY_TOKEN:-}"
# Same PATH the systemd drop-in installs, so the smoke test proves the CLIs are visible to the service.
AGENT_PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
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

# Heartbeats: the in-process loop must bring CLIs online without anything else running.
online=0
for _ in $(seq 1 20); do
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

# ---- activate -------------------------------------------------------------------------------------------
log "publish $FINAL"
mkdir -p "$RELEASES/acs"
mv "$STAGE" "$FINAL"
node "$FINAL/scripts/release-integrity.mjs" verify "$FINAL"

log "back up database and drop-ins"
BACKUP_DB="$LIVE_DB.pre-$SHORT-$STAMP"
sqlite3 "$LIVE_DB" ".backup '$BACKUP_DB'"
chmod 600 "$BACKUP_DB"
RELEASE_DROPIN="$DROPIN_DIR/40-immutable-release.conf"
DISPATCH_DROPIN="$DROPIN_DIR/50-agent-dispatch.conf"
[[ -f "$RELEASE_DROPIN" ]] && cp -p "$RELEASE_DROPIN" "$RELEASE_DROPIN.pre-$SHORT-$STAMP"
[[ -f "$DISPATCH_DROPIN" ]] && cp -p "$DISPATCH_DROPIN" "$DISPATCH_DROPIN.pre-$SHORT-$STAMP"

rollback() {
  echo "ROLLING BACK drop-ins; database backup (not restored automatically): $BACKUP_DB" >&2
  if [[ -f "$RELEASE_DROPIN.pre-$SHORT-$STAMP" ]]; then cp -p "$RELEASE_DROPIN.pre-$SHORT-$STAMP" "$RELEASE_DROPIN"; fi
  if [[ -f "$DISPATCH_DROPIN.pre-$SHORT-$STAMP" ]]; then cp -p "$DISPATCH_DROPIN.pre-$SHORT-$STAMP" "$DISPATCH_DROPIN"; else rm -f "$DISPATCH_DROPIN"; fi
  systemctl --user daemon-reload
  systemctl --user restart "$UNIT" || true
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
Environment=ACS_AGENT_DISPATCH_ENABLED=1
Environment=ACS_AGENT_REPO_ROOTS=$DISPATCH_ROOTS
EOF

log "restart $UNIT"
systemctl --user daemon-reload
if ! systemctl --user restart "$UNIT" || ! "$REPO/scripts/gateway-post-deploy-healthcheck.sh" "http://127.0.0.1:${PORT:-3000}"; then
  rollback
  exit 1
fi

log "verify live roster"
sleep 5
live_online="$(curl -fsS -m 5 -H "authorization: Bearer ${ACS_GATEWAY_TOKEN:-}" "http://127.0.0.1:${PORT:-3000}/api/agents" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents??[];console.log(a.filter(x=>x.status==="AVAILABLE").length)})' || echo 0)"
echo "live gateway: $live_online agent(s) AVAILABLE"
echo
echo "Deployed $RELEASE_NAME. Database backup: $BACKUP_DB"
echo "Rollback: restore $RELEASE_DROPIN.pre-$SHORT-$STAMP over $RELEASE_DROPIN, remove $DISPATCH_DROPIN, systemctl --user daemon-reload && systemctl --user restart $UNIT"
