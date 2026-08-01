#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: send-pushcut.sh --notification NAME --payload FILE [--execute]

Dry-run is the default. --execute performs one POST and requires
PUSHCUT_API_KEY in the environment. No automatic retries are performed.
USAGE
}

notification=''
payload=''
execute=0

while (($#)); do
  case "$1" in
    --notification)
      [[ $# -ge 2 ]] || { echo 'missing value for --notification' >&2; exit 2; }
      notification=$2
      shift 2
      ;;
    --payload)
      [[ $# -ge 2 ]] || { echo 'missing value for --payload' >&2; exit 2; }
      payload=$2
      shift 2
      ;;
    --execute)
      execute=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n $notification ]] || { echo '--notification is required' >&2; exit 2; }
[[ -n $payload ]] || { echo '--payload is required' >&2; exit 2; }
[[ -f $payload ]] || { echo 'payload file not found' >&2; exit 2; }

python3 - "$payload" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
try:
    if path.stat().st_size > 262_144:
        raise ValueError("payload exceeds 256 KiB")
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
except (OSError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid payload: {error}") from None
if not isinstance(value, dict):
    raise SystemExit("payload must be a JSON object")
PY

encoded_notification=$(python3 - "$notification" <<'PY'
import sys
import urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=""))
PY
)
endpoint="https://api.pushcut.io/v1/notifications/${encoded_notification}"

if ((execute == 0)); then
  printf 'DRY RUN\nmethod: POST\nendpoint: %s\npayload: %s\nauth: API-Key from PUSHCUT_API_KEY (not displayed)\n' "$endpoint" "$payload"
  exit 0
fi

: "${PUSHCUT_API_KEY:?PUSHCUT_API_KEY is required with --execute}"
[[ $PUSHCUT_API_KEY =~ ^[A-Za-z0-9._-]{8,512}$ ]] || {
  echo 'PUSHCUT_API_KEY contains unexpected characters' >&2
  exit 2
}

header_file=$(mktemp)
trap 'rm -f -- "$header_file"' EXIT
chmod 600 "$header_file"
printf 'API-Key: %s\n' "$PUSHCUT_API_KEY" >"$header_file"

curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 15 \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "@${header_file}" \
  --data-binary "@${payload}" \
  "$endpoint"
