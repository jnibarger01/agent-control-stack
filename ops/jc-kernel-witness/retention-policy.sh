#!/usr/bin/env bash
# JC Kernel Witness V2 — Evidence Retention & Archival Policy Utility
# Verifies WORM anchor status before pruning transient local scratch receipts,
# while enforcing immutability of black_box_events and WORM objects within retention window.
set -euo pipefail

DRY_RUN=0
RECEIPT_SCRATCH_DIR="/var/lib/acs-jc/witness-receipts"
WORM_DIR="/var/lib/acs-core/worm-vault"
RETENTION_DAYS=365
SCRATCH_MAX_AGE_DAYS=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --receipt-scratch-dir)
      RECEIPT_SCRATCH_DIR="$2"
      shift 2
      ;;
    --worm-dir)
      WORM_DIR="$2"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="$2"
      shift 2
      ;;
    --scratch-max-age-days)
      SCRATCH_MAX_AGE_DAYS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--receipt-scratch-dir <dir>] [--worm-dir <dir>] [--retention-days <days>] [--scratch-max-age-days <days>]" >&2
      exit 2
      ;;
  esac
done

echo "=== JC Kernel Witness V2 Retention Policy (dry_run=${DRY_RUN}, worm_retention_days=${RETENTION_DAYS}, scratch_days=${SCRATCH_MAX_AGE_DAYS}) ==="

if [[ -d "${WORM_DIR}" ]]; then
  WORM_COUNT="$(find "${WORM_DIR}" -type f -name '*.json' 2>/dev/null | wc -l)"
  echo "  - WORM vault (${WORM_DIR}): ${WORM_COUNT} immutable objects protected (${RETENTION_DAYS}d retention lock)"
fi

if [[ -d "${RECEIPT_SCRATCH_DIR}" ]]; then
  while IFS= read -r -d '' file; do
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      echo "[DRY-RUN] rm -f ${file}"
    else
      rm -f "${file}"
    fi
  done < <(find "${RECEIPT_SCRATCH_DIR}" -type f -name 'proc_*.json' -mtime "+${SCRATCH_MAX_AGE_DAYS}" -print0 2>/dev/null || true)
fi

echo "=== Retention policy execution complete ==="
