#!/usr/bin/env bash
# Post-deploy smoke for the ACS gateway: /livez then /readyz.
# Usage: ./scripts/gateway-post-deploy-healthcheck.sh [base-url]
# Default base URL: http://127.0.0.1:3000
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3000}"
BASE_URL="${BASE_URL%/}"
TIMEOUT_SEC="${ACS_HEALTHCHECK_TIMEOUT_SEC:-10}"

check() {
  local path="$1"
  echo "GET ${BASE_URL}${path}"
  curl -fsS --max-time "${TIMEOUT_SEC}" "${BASE_URL}${path}"
  echo
}

check /livez
check /readyz
echo "gateway post-deploy healthcheck OK"
