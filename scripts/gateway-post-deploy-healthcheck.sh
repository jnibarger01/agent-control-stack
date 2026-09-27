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
readyz_response=""
for attempt in $(seq 1 "${READYZ_ATTEMPTS}"); do
  if readyz_response="$(curl -fsS --max-time "${TIMEOUT_SEC}" "${BASE_URL}/readyz" 2>/dev/null)"; then
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

# Do not re-probe /readyz here: the retry loop above already accepted a
# successful response within budget. Print it instead of issuing another
# un-retried request, which could flap (503 -> 200 -> 503) and falsely
# fail the deployment.
echo "GET ${BASE_URL}/readyz"
printf '%s\n' "${readyz_response}"
echo
echo "gateway post-deploy healthcheck OK"
