#!/usr/bin/env bash
# Post-deploy smoke for the ACS gateway: /livez then /readyz.
# Usage: ./scripts/gateway-post-deploy-healthcheck.sh [base-url]
# Default base URL: http://127.0.0.1:3000
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3000}"
BASE_URL="${BASE_URL%/}"
TIMEOUT_SEC="${ACS_HEALTHCHECK_TIMEOUT_SEC:-10}"
READYZ_ATTEMPTS="${ACS_HEALTHCHECK_READYZ_ATTEMPTS:-10}"

check() {
  local path="$1"
  echo "GET ${BASE_URL}${path}"
  curl -fsS --max-time "${TIMEOUT_SEC}" "${BASE_URL}${path}"
  echo
}

check /livez

# Readiness can lag liveness briefly after a deploy (dependency warm-up, store
# migration). Retry /readyz a bounded number of times before failing the check.
ready=0
for attempt in $(seq 1 "${READYZ_ATTEMPTS}"); do
  if curl -fsS --max-time "${TIMEOUT_SEC}" "${BASE_URL}/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [[ "${attempt}" -lt "${READYZ_ATTEMPTS}" ]]; then
    sleep 1
  fi
done

if [[ "${ready}" -ne 1 ]]; then
  echo "GET ${BASE_URL}/readyz did not succeed within ${READYZ_ATTEMPTS} attempts" >&2
  exit 1
fi

check /readyz
echo "gateway post-deploy healthcheck OK"
