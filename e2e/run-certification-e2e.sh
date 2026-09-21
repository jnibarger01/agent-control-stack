#!/usr/bin/env bash
# Certification E2E orchestrator.
# Chain: Mission Router -> ACS webhook -> MCP gateway (OAuth leg)
#        -> managed bridge -> managed Desktop Commander -> ACS result/evidence.
# Every service runs from real built artifacts on loopback with a fresh ACS DB.
set -uo pipefail
cd "$(dirname "$0")/.."

ROOT="$(mktemp -d /tmp/acs-cert-XXXXXX)"
mkdir -p "$ROOT/workspace" "$ROOT/dc-state" "$ROOT/router" "$ROOT/logs"
chmod 700 "$ROOT" "$ROOT/dc-state" "$ROOT/router"
LOG="$ROOT/logs"
export MISSION_ROUTER_HOME="$ROOT/router"
export DESKTOP_COMMANDER_STATE_DIR="$ROOT/dc-state"
FAILURES=0

ACS_PORT=8971; BRIDGE_PORT=8972; GW_PORT=8973
WORKSPACE="$ROOT/workspace"
note() { echo "[cert] $*"; }

# 1. Capability signing keys (throwaway, fresh per run).
node -e "
const { generateKeyPairSync } = require('node:crypto');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const fs = require('fs');
fs.writeFileSync('$WORKSPACE/acs.cap.private', privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'), {mode:0o600});
fs.writeFileSync('$WORKSPACE/acs.cap.public', publicKey.export({format:'der',type:'spki'}).toString('base64url'), {mode:0o600});
"
ACS_PRIVATE_KEY=$(cat "$WORKSPACE/acs.cap.private")
ACS_PUBLIC_KEY_B64=$(cat "$WORKSPACE/acs.cap.public")
DC_ENTRYPOINT="/home/jacen/projects/desktop-commander/dist/index.js"
DC_ENTRY_FINGERPRINT=$(sha256sum "$DC_ENTRYPOINT" | cut -d' ' -f1)
MR_TOKEN="mr-service-token-0123456789abcdef"
SVC_TOKEN="svc-gateway-token-0123456789abcdef"
WORKER_TOKEN="bridge-worker-token"
EXEC_TOKEN="gw-exec-hmac-0123456789abcdef"
export ACS_GATEWAY_CREDENTIALS_JSON=$(node -e "
console.log(JSON.stringify([
 {id:'mr',token:'$MR_TOKEN',actor:'system',actorId:'mission-router',roles:['service'],scopes:['acs:read','acs:write']},
 {id:'svc',token:'$SVC_TOKEN',actor:'system',actorId:'acs-gateway-service',roles:['service'],scopes:['acs:read','acs:write']},
 {id:'dc-bridge',token:'$WORKER_TOKEN',actor:'agent',actorId:'acs-dc-bridge',roles:['service','worker'],scopes:['acs:read','acs:write','acs:worker']}
]));")

ACS_ENV=(
  ACS_PORT="$ACS_PORT" ACS_DB_PATH="$ROOT/acs.db" ACS_E2E_WORKSPACE_ROOT="$WORKSPACE"
  ACS_GATEWAY_CREDENTIALS_JSON="$ACS_GATEWAY_CREDENTIALS_JSON"
  ACS_EXECUTION_BACKEND=desktop_commander
  ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS="$WORKSPACE"
  ACS_DESKTOP_COMMANDER_RUNTIME_ID="dc-e2e-runtime"
  ACS_DESKTOP_COMMANDER_RUNTIME_IDENTITY_CONFIG_FINGERPRINT="$DC_ENTRY_FINGERPRINT"
  ACS_DESKTOP_COMMANDER_RUNTIME_SCOPES_JSON='["fs.read","fs.write","process.exec","process.spawn"]'
  ACS_DESKTOP_COMMANDER_CAPABILITY_KEY_ID="e2e-capability-key"
  ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY="$ACS_PRIVATE_KEY"
)

# 2. ACS gateway.
env "${ACS_ENV[@]}" node e2e/acs-server.mjs >"$LOG/acs.log" 2>&1 &
ACS_PID=$!
sleep 2
if ! curl -sf "http://127.0.0.1:${ACS_PORT}/livez" >/dev/null; then
  note "ACS gateway FAILED"; cat "$LOG/acs.log"; kill $ACS_PID $BRIDGE_PID $GW_PID 2>/dev/null; exit 1
fi
note "ACS gateway up (pid $ACS_PID)"

# 3. Bridge (managed).
ACS_MANAGED_MODE=1 ACS_GATEWAY_URL="http://127.0.0.1:${ACS_PORT}" \
ACS_WORKER_TOKEN="$WORKER_TOKEN" ACS_WORKER_ID="acs-dc-bridge" \
ACS_DC_PUBLIC_KEY="$ACS_PUBLIC_KEY_B64" ACS_DC_KEY_ID="e2e-capability-key" \
ACS_DC_RUNTIME_SCOPES="fs.read,fs.write,process.exec,process.spawn" \
DESKTOP_COMMANDER_STATE_DIR="$ROOT/dc-state" \
BRIDGE_PORT="$BRIDGE_PORT" DC_GATEWAY_EXECUTION_TOKEN="$EXEC_TOKEN" \
DC_CMD="$(which node)" \
DC_ARGS="/home/jacen/projects/desktop-commander/dist/index.js" \
node bridge.js >"$LOG/bridge.log" 2>&1 &
BRIDGE_PID=$!
sleep 2
if ! curl -sf "http://127.0.0.1:${BRIDGE_PORT}/healthz" >/dev/null; then
  note "bridge FAILED"; cat "$LOG/bridge.log"; kill $ACS_PID $BRIDGE_PID $GW_PID 2>/dev/null; exit 1
fi
note "bridge (managed) up (pid $BRIDGE_PID)"

# 4. MCP gateway (managed OAuth edge).
ACS_MANAGED_MODE=1 ACS_GATEWAY_URL="http://127.0.0.1:${ACS_PORT}" \
ACS_GATEWAY_TOKEN="$SVC_TOKEN" \
ACS_DC_RUNTIME_SCOPES="fs.read,fs.write,process.exec,process.spawn" \
DESKTOP_COMMANDER_STATE_DIR="$ROOT/dc-state" \
GATEWAY_PORT="$GW_PORT" PUBLIC_ORIGIN="http://127.0.0.1:${GW_PORT}" \
CONSENT_PASSPHRASE="cert-e2e-passphrase" SIGNING_KEY="$(printf 'a%.0s' $(seq 1 64))" \
GATEWAY_EXECUTION_TOKEN="$EXEC_TOKEN" \
UPSTREAM="http://127.0.0.1:${BRIDGE_PORT}" \
node server.js >"$LOG/gateway.log" 2>&1 &
GW_PID=$!
sleep 2
if ! curl -sf "http://127.0.0.1:${GW_PORT}/healthz" >/dev/null; then
  note "mcp-gateway FAILED"; cat "$LOG/gateway.log"; kill $ACS_PID $BRIDGE_PID $GW_PID 2>/dev/null; exit 1
fi
note "mcp-gateway (managed) up (pid $GW_PID)"

# 5. Mission Router -> ACS webhook (the real compatibility path).
MR_SUBMIT=$(ACS_GATEWAY_URL="http://127.0.0.1:${ACS_PORT}" ACS_GATEWAY_TOKEN="$MR_TOKEN" \
  node /home/jacen/projects/mission-router/src/cli.mjs submit --goal "read the certification notes file" --origin cli --workspace "$WORKSPACE" 2>&1)
echo "$MR_SUBMIT" | tail -25
MISSION_ID=$(echo "$MR_SUBMIT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=d.indexOf('{');try{const j=JSON.parse(d.slice(i));console.log(j.mission?.id||j.id||'')}catch{console.log('')}})")
note "mission id: ${MISSION_ID:-<parse-failed>}"

# 6. OAuth leg: register -> PKCE authorize/consent -> token.
CLIENT=$(curl -sf -X POST "http://127.0.0.1:${GW_PORT}/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"cert-e2e","redirect_uris":["http://127.0.0.1/callback"],"grant_types":["authorization_code"],"token_endpoint_auth_method":"none","response_types":["code"]}')
CLIENT_ID=$(echo "$CLIENT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).client_id))")
VERIFIER=$(head -c 48 /dev/urandom | base64 | tr -d '=+/\n' | head -c 64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '=\n')
LOCATION=$(curl -s -o /dev/null -D - -X POST "http://127.0.0.1:${GW_PORT}/authorize/consent" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=http://127.0.0.1/callback" \
  --data-urlencode "scope=mcp" --data-urlencode "state=cert123" \
  --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=http://127.0.0.1:${GW_PORT}/mcp" \
  --data-urlencode "passphrase=cert-e2e-passphrase" | grep -i '^location:' | tr -d '\r' | cut -d' ' -f2)
CODE=$(node -e "const u=new URL(process.argv[1]);console.log(u.searchParams.get('code'))" "$LOCATION")
TOKENS=$(curl -sf -X POST "http://127.0.0.1:${GW_PORT}/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=http://127.0.0.1/callback")
ACCESS=$(echo "$TOKENS" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).access_token))")
note "OAuth leg complete (access token ${#ACCESS} chars)"

# 7. MCP initialize through the full chain (managed bootstrap inside).
curl -s -D "$LOG/init-headers.txt" -X POST "http://127.0.0.1:${GW_PORT}/mcp" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cert-e2e","version":"1"}}}' > "$LOG/init.json"
SESSION=$(grep -i '^mcp-session-id:' "$LOG/init-headers.txt" | tr -d '\r' | cut -d' ' -f2)
note "initialize -> session ${SESSION:-NONE}"
head -c 500 "$LOG/init.json"; echo
if [ -z "$SESSION" ]; then note "BLOCKED: no session"; fi
curl -s -o /dev/null -X POST "http://127.0.0.1:${GW_PORT}/mcp" -H "Authorization: Bearer $ACCESS" -H "Mcp-Session-Id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

printf 'certification e2e payload\n' > "$WORKSPACE/notes.txt"
RESULT=$(curl -s -X POST "http://127.0.0.1:${GW_PORT}/mcp" -H "Authorization: Bearer $ACCESS" -H "Mcp-Session-Id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"$WORKSPACE/notes.txt\"}}}")
note "tools/call read_file ->"
echo "$RESULT" | head -c 1000; echo
echo "$RESULT" > "$LOG/e2e-result.json"

note "EVIDENCE-START"
note "workspace=$WORKSPACE logs=$LOG"
note "pids: acs=$ACS_PID bridge=$BRIDGE_PID gateway=$GW_PID"
wait
