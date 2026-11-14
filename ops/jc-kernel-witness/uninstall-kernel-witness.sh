#!/usr/bin/env bash
# JC Kernel Witness V2 — Uninstall Script
# Preserves durable Black Box SQLite and WORM evidence vault unless --purge-state is passed.
set -euo pipefail

DRY_RUN=0
PURGE_STATE=0
PREFIX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --prefix)
      PREFIX="${2%/}"
      shift 2
      ;;
    --purge-state)
      PURGE_STATE=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--prefix <dir>] [--purge-state]" >&2
      exit 2
      ;;
  esac
done

LIB_DIR="${PREFIX}/usr/lib/jace-commander"
ETC_DIR="${PREFIX}/etc/jace-commander"
SYSTEMD_DIR="${PREFIX}/etc/systemd/system"
SIGNER_RUN_DIR="${PREFIX}/run/jc-witness-signer"

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

reject_symlink() {
  local target="$1"
  if [[ -L "${target}" ]]; then
    echo "ERROR: refusing to delete symlink: ${target}" >&2
    exit 1
  fi
}

echo "=== JC Kernel Witness V2 Uninstall (dry_run=${DRY_RUN}, prefix='${PREFIX:-/}', purge_state=${PURGE_STATE}) ==="

for item in jc-kernel-witness jc-kernel-witness.prev jc-witness-signerd jc-witness-signerd.prev witness.bpf.o witness.bpf.o.prev; do
  reject_symlink "${LIB_DIR}/${item}"
  if [[ -f "${LIB_DIR}/${item}" ]]; then
    run_cmd rm -f "${LIB_DIR}/${item}"
  fi
done

for unit in jc-witness-signerd.service acs-jc-bridge.service acs-core.service; do
  reject_symlink "${SYSTEMD_DIR}/${unit}"
  if [[ -f "${SYSTEMD_DIR}/${unit}" ]]; then
    run_cmd rm -f "${SYSTEMD_DIR}/${unit}"
  fi
done

reject_symlink "${SIGNER_RUN_DIR}"
if [[ -d "${SIGNER_RUN_DIR}" ]]; then
  run_cmd rm -rf "${SIGNER_RUN_DIR}"
fi

if [[ "${PURGE_STATE}" -eq 1 ]]; then
  echo "  - Purging state directories (--purge-state)..."
  for pdir in "${ETC_DIR}" "${PREFIX}/var/lib/jace-commander/witness-signer" "${PREFIX}/var/lib/acs-jc/witness-receipts" "${PREFIX}/var/lib/acs-jc/witness-seen"; do
    reject_symlink "${pdir}"
  done
  run_cmd rm -rf "${ETC_DIR}" "${PREFIX}/var/lib/jace-commander/witness-signer" "${PREFIX}/var/lib/acs-jc/witness-receipts" "${PREFIX}/var/lib/acs-jc/witness-seen"
else
  echo "  - Preserving durable Black Box SQLite, WORM vault, and public keys for historical verification."
fi

echo "=== JC Kernel Witness V2 uninstall complete ==="
