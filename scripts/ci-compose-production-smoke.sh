#!/usr/bin/env bash
# CI / local smoke: boot compose.production.yml on loopback and run the
# post-deploy healthcheck. Does not call Vercel or touch ignoreCommand.
#
# Prerequisites: Docker + Compose, and an image tagged
#   agent-control-stack:${ACS_IMAGE_TAG:-local}
# (the check workflow builds this before invoking the script).
#
# Usage: ./scripts/ci-compose-production-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ACS_IMAGE_TAG="${ACS_IMAGE_TAG:-local}"
ACS_PORT="${ACS_PORT:-3000}"
BASE_URL="http://127.0.0.1:${ACS_PORT}"

# Synthetic test credentials for CI only — not production secrets.
export ACS_IMAGE_TAG
export ACS_PORT
export ACS_GATEWAY_CREDENTIALS_JSON="${ACS_GATEWAY_CREDENTIALS_JSON:-$(
  printf '%s' '[{"id":"ci-smoke","token":"ci-compose-smoke-token-32chars-min","actor":"operator","actorId":"ci-smoke","roles":["operator"],"scopes":["acs:read","acs:write"]}]'
)}"
export ACS_MCP_ALLOWED_ORIGINS="${ACS_MCP_ALLOWED_ORIGINS:-http://127.0.0.1:${ACS_PORT}}"
export ACS_OAUTH_ISSUER="${ACS_OAUTH_ISSUER:-https://issuer.example}"
export ACS_OAUTH_AUDIENCE="${ACS_OAUTH_AUDIENCE:-https://acs.example/mcp}"
export ACS_OAUTH_JWKS_URI="${ACS_OAUTH_JWKS_URI:-https://issuer.example/jwks}"

COMPOSE=(docker compose -f compose.production.yml)

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "compose.production smoke: image=agent-control-stack:${ACS_IMAGE_TAG} publish=${BASE_URL}"

# Validate compose + required env before starting (catches broken service config).
"${COMPOSE[@]}" config --quiet

# Use the already-built image; do not rebuild inside this smoke.
"${COMPOSE[@]}" up -d --no-build

echo "waiting for gateway /livez on ${BASE_URL}..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "${BASE_URL}/livez" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "${ready}" -ne 1 ]]; then
  echo "gateway did not become live within 60s" >&2
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=200 gateway || true
  exit 1
fi

./scripts/gateway-post-deploy-healthcheck.sh "${BASE_URL}"
echo "compose.production smoke OK"
