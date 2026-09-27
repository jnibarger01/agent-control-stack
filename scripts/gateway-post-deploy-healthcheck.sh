#!/usr/bin/env bash
# Post-deploy smoke for the ACS gateway: /livez then /readyz.
# Usage: ./scripts/gateway-post-deploy-healthcheck.sh [base-url]
# Default base URL: http://127.0.0.1:3000
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3000}"
BASE_URL="${BASE_URL%/}"
TIMEOUT_SEC="${ACS_HEALTHCHECK_TIMEOUT_SEC:-10}"
READYZ_ATTEMPTS="${ACS_HEALTHCHECK_READYZ_ATTEMPTS:-10}"

if [[ ! "${READYZ_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || (( READYZ_ATTEMPTS > 60 )); then
  echo "ACS_HEALTHCHECK_READYZ_ATTEMPTS must be an integer from 1 to 60" >&2
  exit 2
fi

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
readyz_response_file="$(mktemp)"
trap 'rm -f "${readyz_response_file}"' EXIT
for ((attempt = 1; attempt <= READYZ_ATTEMPTS; attempt += 1)); do
  : >"${readyz_response_file}"
  if curl -fsS --max-time "${TIMEOUT_SEC}" --max-filesize 65536 -o "${readyz_response_file}" "${BASE_URL}/readyz" 2>/dev/null; then
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
cat "${readyz_response_file}"
printf '\n'
echo "gateway post-deploy healthcheck OK"
