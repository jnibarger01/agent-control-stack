#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:-$(git rev-parse --show-toplevel)}
facts_file=${2:-"$repo_root/docs/platform-facts.md"}
plan_file=${3:-"$repo_root/fable5-build-prompts-v2.md"}
failures=0

if [[ ! -f "$facts_file" ]]; then
  printf 'FAIL missing %s\n' "$facts_file" >&2
  exit 1
fi

required_terms=(
  'Claude Fable 5'
  'claude-fable-5'
  'Claude Sonnet 5'
  '/goal'
  '/loop'
  'Stop hooks'
  'Auto mode'
  'Dynamic workflows'
  'Routines'
  'Outcomes'
  'Claude Managed Agents'
  'Appendix reconciliation'
  '30-day data retention'
  'not available under zero data retention'
  'usage credits'
  '30 days'
)

for term in "${required_terms[@]}"; do
  if ! rg -F -q "$term" "$facts_file"; then
    printf 'FAIL required term: %s\n' "$term" >&2
    failures=$((failures + 1))
  fi
done

if [[ -f "$plan_file" ]] && rg -q '^## Appendix\b' "$plan_file"; then
  if rg -n -i 'appendix (table )?(is|was) (not present|absent)' "$facts_file"; then
    printf 'FAIL facts ledger claims the controlling appendix is absent\n' >&2
    failures=$((failures + 1))
  fi

  appendix_rows=$(awk '
    /^## Appendix([[:space:]]|$)/ { in_appendix = 1; next }
    in_appendix && /^## / { exit }
    in_appendix && /^\|/ && $0 !~ /^\| Feature / && $0 !~ /^\|---/ { rows++ }
    END { print rows + 0 }
  ' "$plan_file")
  if (( appendix_rows == 0 )); then
    printf 'FAIL controlling appendix has no seed rows: %s\n' "$plan_file" >&2
    failures=$((failures + 1))
  fi
fi

while IFS= read -r line; do
  if [[ "$line" == *'| CONFIRMED |'* && "$line" != *'https://'* ]]; then
    printf 'FAIL CONFIRMED row lacks URL: %s\n' "$line" >&2
    failures=$((failures + 1))
  fi
  if [[ "$line" == *'| NOT FOUND |'* && "$line" != *'Fallback plan:'* ]]; then
    printf 'FAIL NOT FOUND row lacks fallback: %s\n' "$line" >&2
    failures=$((failures + 1))
  fi
done < "$facts_file"

bad_table_lines=$(awk '/^\|/ { count = gsub(/\|/, "|"); if (count != 6) print NR }' "$facts_file")
if [[ -n "$bad_table_lines" ]]; then
  printf 'FAIL malformed table rows: %s\n' "$bad_table_lines" >&2
  failures=$((failures + 1))
fi

if rg -n -i 'UNVERIFIED|TBD|TODO|citation needed' "$facts_file"; then
  printf 'FAIL unsupported-status marker present\n' >&2
  failures=$((failures + 1))
fi

cadence_values=$(
  tr '\n' ' ' < "$facts_file" |
    sed -nE 's/.*This edition was verified on[[:space:]]+\*\*([0-9]{4}-[0-9]{2}-[0-9]{2})\*\*[[:space:]]+and is due again by[[:space:]]+\*\*([0-9]{4}-[0-9]{2}-[0-9]{2})\*\*.*/\1 \2/p'
)
read -r edition_date due_date <<< "$cadence_values"

if [[ -z "${edition_date:-}" || -z "${due_date:-}" ]]; then
  printf 'FAIL missing edition or due date in cadence policy\n' >&2
  failures=$((failures + 1))
else
  expected_due=$(date -u -d "$edition_date +30 days" +%F)
  if [[ "$due_date" != "$expected_due" ]]; then
    printf 'FAIL due date %s is not 30 days after %s (expected %s)\n' \
      "$due_date" "$edition_date" "$expected_due" >&2
    failures=$((failures + 1))
  fi

  row_dates=$(awk -F '|' '
    /^\|/ {
      status = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
      if (status == "CONFIRMED" || status == "CHANGED" || status == "NOT FOUND") {
        verified = $6
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", verified)
        print verified
      }
    }
  ' "$facts_file" | sort -u)
  row_date_count=$(printf '%s\n' "$row_dates" | sed '/^$/d' | wc -l)
  if (( row_date_count != 1 )) || [[ "$row_dates" != "$edition_date" ]]; then
    printf 'FAIL row verification dates do not all match edition %s: %s\n' \
      "$edition_date" "$row_dates" >&2
    failures=$((failures + 1))
  fi
fi

while IFS= read -r url; do
  case "$url" in
    https://docs.claude.com/*|https://code.claude.com/docs/*|https://claude.com/blog*|https://www.anthropic.com/news*) ;;
    *)
      printf 'FAIL non-official source: %s\n' "$url" >&2
      failures=$((failures + 1))
      continue
      ;;
  esac

  target=${url%%#*}
  if ! status=$(curl -LsS --max-time 30 -o /dev/null -w '%{http_code}' "$target"); then
    printf 'FAIL unreachable source: %s\n' "$url" >&2
    failures=$((failures + 1))
  elif [[ "$status" != '200' ]]; then
    printf 'FAIL HTTP %s: %s\n' "$status" "$url" >&2
    failures=$((failures + 1))
  fi
done < <(rg -o 'https://[^)> ]+' "$facts_file" | sed 's/[.,]$//' | sort -u)

if (( failures > 0 )); then
  printf 'FAIL platform-facts checks: %d\n' "$failures" >&2
  exit 1
fi

printf 'PASS platform-facts structure, fallbacks, required rows, and live links\n'
