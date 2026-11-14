#!/usr/bin/env bash
# JC Kernel Witness V2 — Atomic Upgrade & Key Rotation Script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD_DIR="${REPO_ROOT}/apps/jace-commander/native/kernel-witness/build"

DRY_RUN=0
ROTATE_KEY=0
PREFIX=""
OLD_KEY_ID=""
NEW_KEY_ID=""

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
    --rotate-key)
      ROTATE_KEY=1
      shift
      ;;
    --old-key-id)
      OLD_KEY_ID="$2"
      shift 2
      ;;
    --new-key-id)
      NEW_KEY_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--prefix <dir>] [--rotate-key] [--old-key-id <id>] [--new-key-id <id>]" >&2
      exit 2
      ;;
  esac
done

LIB_DIR="${PREFIX}/usr/lib/jace-commander"
ETC_DIR="${PREFIX}/etc/jace-commander"
SIGNER_STATE_DIR="${PREFIX}/var/lib/jace-commander/witness-signer"
ACS_STATE_DIR="${PREFIX}/var/lib/acs-core"
DB_PATH="${ACS_STATE_DIR}/acs.sqlite"

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

apply_chown() {
  local owner_spec="$1"
  shift
  local user_part="${owner_spec%%:*}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] chown ${owner_spec} $*"
    return 0
  fi
  if [[ "${EUID}" -eq 0 ]] && id -u "${user_part}" >/dev/null 2>&1; then
    chown "${owner_spec}" "$@"
  fi
}

echo "=== JC Kernel Witness V2 Upgrade (dry_run=${DRY_RUN}, prefix='${PREFIX:-/}', rotate_key=${ROTATE_KEY}) ==="

# 1. Verify new build artifacts before touching installed files
"${BUILD_DIR}/jc-kernel-witness" check-bpf --bpf-obj "${BUILD_DIR}/witness.bpf.o"

# 2. Backup existing binaries, manifest, and SQLite DB
echo "[1/4] Backing up existing binaries, manifest, and SQLite database..."
for item in jc-kernel-witness jc-witness-signerd witness.bpf.o; do
  if [[ -f "${LIB_DIR}/${item}" ]]; then
    run_cmd cp -p "${LIB_DIR}/${item}" "${LIB_DIR}/${item}.prev"
  fi
done
if [[ -f "${ETC_DIR}/witness-manifest.sha256" ]]; then
  run_cmd cp -p "${ETC_DIR}/witness-manifest.sha256" "${ETC_DIR}/witness-manifest.sha256.prev"
fi
if [[ -f "${DB_PATH}" ]]; then
  BACKUP_PATH="${DB_PATH}.pre-upgrade.bak"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] Online SQLite backup ${DB_PATH} -> ${BACKUP_PATH}"
  else
    rm -f "${BACKUP_PATH}"
    node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      const escaped = process.argv[2].replace(/'\''/g, "'\'''\''");
      db.exec(`VACUUM INTO '\''${escaped}'\''`);
      db.close();
    ' "${DB_PATH}" "${BACKUP_PATH}"
    chmod 0600 "${BACKUP_PATH}"
    apply_chown acs-core:acs-core "${BACKUP_PATH}"
  fi
fi

# 3. Atomic swap of binaries
echo "[2/4] Atomically installing upgraded binaries..."
run_cmd install -m 0750 "${BUILD_DIR}/jc-kernel-witness" "${LIB_DIR}/jc-kernel-witness.new"
apply_chown root:acs-jc "${LIB_DIR}/jc-kernel-witness.new"
run_cmd mv -f "${LIB_DIR}/jc-kernel-witness.new" "${LIB_DIR}/jc-kernel-witness"
if [[ -f "${BUILD_DIR}/jc-witness-signerd" ]]; then
  run_cmd install -m 0750 "${BUILD_DIR}/jc-witness-signerd" "${LIB_DIR}/jc-witness-signerd.new"
  apply_chown root:jc-witness-signer "${LIB_DIR}/jc-witness-signerd.new"
  run_cmd mv -f "${LIB_DIR}/jc-witness-signerd.new" "${LIB_DIR}/jc-witness-signerd"
fi
run_cmd install -m 0640 "${BUILD_DIR}/witness.bpf.o" "${LIB_DIR}/witness.bpf.o.new"
apply_chown root:acs-jc "${LIB_DIR}/witness.bpf.o.new"
run_cmd mv -f "${LIB_DIR}/witness.bpf.o.new" "${LIB_DIR}/witness.bpf.o"

if [[ "${DRY_RUN}" -eq 0 ]]; then
  (
    cd "${LIB_DIR}"
    if [[ -f "${LIB_DIR}/jc-witness-signerd" ]]; then
      sha256sum jc-kernel-witness jc-witness-signerd witness.bpf.o > "${ETC_DIR}/witness-manifest.sha256"
    else
      sha256sum jc-kernel-witness witness.bpf.o > "${ETC_DIR}/witness-manifest.sha256"
    fi
  )
fi

# 4. Optional key rotation
echo "[3/4] Checking key rotation..."
if [[ "${ROTATE_KEY}" -eq 1 ]]; then
  run_cmd "${LIB_DIR}/jc-kernel-witness" key-admin rotate \
    --manifest "${SIGNER_STATE_DIR}/key-manifest.json" \
    --private-out "${SIGNER_STATE_DIR}/keys/active.priv.pem" \
    --public-out "${ETC_DIR}/observer.pub.pem"
  apply_chown jc-witness-signer:jc-witness-signer "${SIGNER_STATE_DIR}/key-manifest.json" "${SIGNER_STATE_DIR}/keys/active.priv.pem"
fi

# 5. Post-upgrade verification
echo "[4/4] Verifying upgraded installation..."
if [[ "${DRY_RUN}" -eq 0 ]]; then
  "${LIB_DIR}/jc-kernel-witness" check-bpf --bpf-obj "${LIB_DIR}/witness.bpf.o"
fi
echo "=== JC Kernel Witness V2 upgrade complete ==="
