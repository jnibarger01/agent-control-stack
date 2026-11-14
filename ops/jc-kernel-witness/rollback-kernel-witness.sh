#!/usr/bin/env bash
# JC Kernel Witness V2 — Atomic Rollback Script
# Restores previous binaries and manifest without destroying durable Black Box or WORM evidence.
set -euo pipefail

DRY_RUN=0
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
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--prefix <dir>]" >&2
      exit 2
      ;;
  esac
done

LIB_DIR="${PREFIX}/usr/lib/jace-commander"
ETC_DIR="${PREFIX}/etc/jace-commander"

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

echo "=== JC Kernel Witness V2 Rollback (dry_run=${DRY_RUN}, prefix='${PREFIX:-/}') ==="

if [[ ! -f "${LIB_DIR}/jc-kernel-witness.prev" || ! -f "${LIB_DIR}/witness.bpf.o.prev" ]]; then
  echo "ERROR: Rollback backup (.prev) artifacts not found in ${LIB_DIR}" >&2
  exit 1
fi

for item in jc-kernel-witness jc-witness-signerd witness.bpf.o; do
  if [[ -f "${LIB_DIR}/${item}.prev" ]]; then
    run_cmd cp -p "${LIB_DIR}/${item}.prev" "${LIB_DIR}/${item}.restore"
    run_cmd mv -f "${LIB_DIR}/${item}.restore" "${LIB_DIR}/${item}"
  fi
done

if [[ -f "${ETC_DIR}/witness-manifest.sha256.prev" ]]; then
  run_cmd cp -p "${ETC_DIR}/witness-manifest.sha256.prev" "${ETC_DIR}/witness-manifest.sha256"
fi

if [[ "${DRY_RUN}" -eq 0 ]]; then
  "${LIB_DIR}/jc-kernel-witness" check-bpf --bpf-obj "${LIB_DIR}/witness.bpf.o"
fi

echo "=== JC Kernel Witness V2 rollback complete (durable evidence preserved) ==="
