#!/usr/bin/env bash
# JC Kernel Witness V2 — Production Installer (supports --dry-run and --prefix)
# Safety rule: Never mutates host state when --dry-run is passed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD_DIR="${REPO_ROOT}/apps/jace-commander/native/kernel-witness/build"

DRY_RUN=0
SKIP_SYSTEMD=0
SKIP_USERADD=0
PREFIX=""
OBSERVER_ID="jc-witness-prod-1"
KEY_ID=""
DB_PATH=""
WORM_DIR=""

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
    --observer-id)
      OBSERVER_ID="$2"
      shift 2
      ;;
    --key-id)
      KEY_ID="$2"
      shift 2
      ;;
    --db-path)
      DB_PATH="$2"
      shift 2
      ;;
    --worm-dir)
      WORM_DIR="$2"
      shift 2
      ;;
    --skip-systemd)
      SKIP_SYSTEMD=1
      shift
      ;;
    --skip-useradd)
      SKIP_USERADD=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--prefix <dir>] [--observer-id <id>] [--key-id <id>] [--db-path <path>] [--worm-dir <path>] [--skip-systemd] [--skip-useradd]" >&2
      exit 2
      ;;
  esac
done

LIB_DIR="${PREFIX}/usr/lib/jace-commander"
ETC_DIR="${PREFIX}/etc/jace-commander"
SECRETS_DIR="${PREFIX}/etc/acs-secrets"
SIGNER_STATE_DIR="${PREFIX}/var/lib/jace-commander/witness-signer"
SIGNER_RUN_DIR="${PREFIX}/run/jc-witness-signer"
JC_STATE_DIR="${PREFIX}/var/lib/acs-jc"
ACS_STATE_DIR="${PREFIX}/var/lib/acs-core"
SYSTEMD_DIR="${PREFIX}/etc/systemd/system"
DB_PATH="${DB_PATH:-${ACS_STATE_DIR}/acs.sqlite}"
WORM_DIR="${WORM_DIR:-${ACS_STATE_DIR}/worm-vault}"

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
    echo "ERROR: refusing to operate on symlink: ${target}" >&2
    exit 1
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
  if [[ "${EUID}" -eq 0 && "${SKIP_USERADD}" -eq 0 ]] && id -u "${user_part}" >/dev/null 2>&1; then
    chown "${owner_spec}" "$@"
  fi
}

apply_chown_recursive() {
  local owner_spec="$1"
  shift
  local user_part="${owner_spec%%:*}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] chown -R ${owner_spec} $*"
    return 0
  fi
  if [[ "${EUID}" -eq 0 && "${SKIP_USERADD}" -eq 0 ]] && id -u "${user_part}" >/dev/null 2>&1; then
    chown -R "${owner_spec}" "$@"
  fi
}

echo "=== JC Kernel Witness V2 Installer (dry_run=${DRY_RUN}, prefix='${PREFIX:-/}') ==="

# 1. Preflight checks
echo "[1/7] Running kernel & toolchain preflight checks..."
UNAME_R="$(uname -r)"
echo "  - Kernel release: ${UNAME_R}"
if [[ ! -r /sys/kernel/btf/vmlinux ]]; then
  echo "ERROR: /sys/kernel/btf/vmlinux is missing or unreadable (CONFIG_DEBUG_INFO_BTF=y required)" >&2
  exit 1
fi
if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "ERROR: unified cgroup v2 hierarchy not mounted at /sys/fs/cgroup" >&2
  exit 1
fi
if ! command -v bwrap >/dev/null 2>&1; then
  echo "ERROR: bubblewrap (bwrap) not found in PATH" >&2
  exit 1
fi

WITNESS_BIN="${BUILD_DIR}/jc-kernel-witness"
SIGNERD_BIN="${BUILD_DIR}/jc-witness-signerd"
BPF_OBJ="${BUILD_DIR}/witness.bpf.o"

for artifact in "${WITNESS_BIN}" "${BPF_OBJ}"; do
  if [[ ! -f "${artifact}" ]]; then
    echo "ERROR: Build artifact missing: ${artifact}. Run cmake --build first." >&2
    exit 1
  fi
done

echo "  - Verifying CO-RE eBPF object (${BPF_OBJ})..."
"${WITNESS_BIN}" check-bpf --bpf-obj "${BPF_OBJ}"

# 2. Provision service identities
echo "[2/7] Provisioning service identities (acs-core, acs-jc, jc-witness-signer)..."
if [[ "${SKIP_USERADD}" -eq 0 ]]; then
  for svc_user in acs-core acs-jc jc-witness-signer; do
    if ! id -u "${svc_user}" >/dev/null 2>&1; then
      run_cmd groupadd --system "${svc_user}"
      run_cmd useradd --system --gid "${svc_user}" --home-dir "/var/lib/${svc_user}" --shell /usr/sbin/nologin "${svc_user}"
    fi
  done
  run_cmd usermod -a -G jc-witness-signer acs-jc
else
  echo "  - Skipping useradd/groupadd (--skip-useradd)"
fi

# 3. Create directories with strict permissions
echo "[3/7] Creating state, runtime, and configuration directories..."
for dir_check in "${LIB_DIR}" "${ETC_DIR}" "${SECRETS_DIR}" "${SIGNER_STATE_DIR}" "${SIGNER_RUN_DIR}" "${JC_STATE_DIR}" "${ACS_STATE_DIR}" "${WORM_DIR}"; do
  reject_symlink "${dir_check}"
done
run_cmd install -d -m 0755 "${LIB_DIR}"
run_cmd install -d -m 0755 "${ETC_DIR}"
run_cmd install -d -m 0700 "${SECRETS_DIR}"
run_cmd install -d -m 0700 "${SIGNER_STATE_DIR}" "${SIGNER_STATE_DIR}/keys"
run_cmd install -d -m 0750 "${SIGNER_RUN_DIR}"
run_cmd install -d -m 0700 "${JC_STATE_DIR}" "${JC_STATE_DIR}/witness-receipts" "${JC_STATE_DIR}/witness-seen"
run_cmd install -d -m 0700 "${ACS_STATE_DIR}" "${WORM_DIR}"

# 4. Install binaries & SHA-256 manifest
echo "[4/7] Installing binaries and generating SHA-256 manifest..."
reject_symlink "${LIB_DIR}/jc-kernel-witness"
reject_symlink "${LIB_DIR}/jc-witness-signerd"
reject_symlink "${LIB_DIR}/witness.bpf.o"
run_cmd install -m 0750 "${WITNESS_BIN}" "${LIB_DIR}/jc-kernel-witness"
apply_chown root:acs-jc "${LIB_DIR}/jc-kernel-witness"
if [[ -f "${SIGNERD_BIN}" ]]; then
  run_cmd install -m 0750 "${SIGNERD_BIN}" "${LIB_DIR}/jc-witness-signerd"
  apply_chown root:jc-witness-signer "${LIB_DIR}/jc-witness-signerd"
fi
run_cmd install -m 0640 "${BPF_OBJ}" "${LIB_DIR}/witness.bpf.o"
apply_chown root:acs-jc "${LIB_DIR}/witness.bpf.o"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[DRY-RUN] sha256sum ${LIB_DIR}/jc-kernel-witness ${LIB_DIR}/witness.bpf.o > ${ETC_DIR}/witness-manifest.sha256"
else
  (
    cd "${LIB_DIR}"
    if [[ -f "${LIB_DIR}/jc-witness-signerd" ]]; then
      sha256sum jc-kernel-witness jc-witness-signerd witness.bpf.o > "${ETC_DIR}/witness-manifest.sha256"
    else
      sha256sum jc-kernel-witness witness.bpf.o > "${ETC_DIR}/witness-manifest.sha256"
    fi
    chmod 0644 "${ETC_DIR}/witness-manifest.sha256"
  )
fi

# 5. Provision isolated Ed25519 signing key & path HMAC key
echo "[5/7] Provisioning isolated Ed25519 observer signing key and path HMAC key..."
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[DRY-RUN] Provision Ed25519 key in ${SIGNER_STATE_DIR} and export public key to ${ETC_DIR}/observer.pub.pem"
  echo "[DRY-RUN] Generate 32-byte path HMAC key at ${SECRETS_DIR}/witness-path-hmac.key (0600)"
else
  if [[ ! -f "${ETC_DIR}/observer.pub.pem" ]]; then
    "${WITNESS_BIN}" key-admin register \
      --manifest "${SIGNER_STATE_DIR}/key-manifest.json" \
      --private-out "${SIGNER_STATE_DIR}/keys/active.priv.pem" \
      --public-out "${ETC_DIR}/observer.pub.pem" > "${SIGNER_STATE_DIR}/initial-key.json"
    chmod 0600 "${SIGNER_STATE_DIR}/keys/active.priv.pem" "${SIGNER_STATE_DIR}/initial-key.json"
    chmod 0644 "${ETC_DIR}/observer.pub.pem"
  fi
  if [[ ! -f "${SECRETS_DIR}/witness-path-hmac.key" ]]; then
    reject_symlink "${SECRETS_DIR}/witness-path-hmac.key"
    install -m 0600 /dev/null "${SECRETS_DIR}/witness-path-hmac.key"
    (
      umask 077
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${SECRETS_DIR}/witness-path-hmac.key"
    )
    chmod 0600 "${SECRETS_DIR}/witness-path-hmac.key"
  fi
fi
apply_chown_recursive jc-witness-signer:jc-witness-signer "${SIGNER_STATE_DIR}"
apply_chown jc-witness-signer:acs-jc "${SIGNER_RUN_DIR}"
apply_chown_recursive acs-jc:acs-jc "${JC_STATE_DIR}"
apply_chown acs-jc:acs-jc "${SECRETS_DIR}/witness-path-hmac.key"

# 6. Apply SQLite durable Black Box migrations
echo "[6/7] Applying SQLite Black Box durable & WORM schema migrations to ${DB_PATH}..."
for mig in "${REPO_ROOT}/storage/migrations/079_black_box_durable.sql" "${REPO_ROOT}/storage/migrations/080_black_box_transactional_worm_v2.sql"; do
  if [[ -f "${mig}" ]]; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      echo "[DRY-RUN] Apply migration $(basename "${mig}") to ${DB_PATH}"
    else
      node -e '
        const fs = require("node:fs");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        const sql = fs.readFileSync(process.argv[2], "utf8");
        try { db.exec(sql); } catch (e) {
          if (!String(e.message).includes("duplicate column name") && !String(e.message).includes("already exists")) throw e;
        }
        db.close();
      ' "${DB_PATH}" "${mig}"
    fi
  fi
done

# 7. Install systemd units
echo "[7/7] Installing hardened systemd units..."
apply_chown_recursive acs-core:acs-core "${ACS_STATE_DIR}" "${WORM_DIR}"
if [[ "${DRY_RUN}" -eq 0 && -f "${DB_PATH}" ]]; then
  apply_chown acs-core:acs-core "${DB_PATH}"
fi
if [[ "${SKIP_SYSTEMD}" -eq 0 ]]; then
  run_cmd install -d -m 0755 "${SYSTEMD_DIR}"
  for unit in jc-witness-signerd.service acs-jc-bridge.service acs-core.service; do
    reject_symlink "${SYSTEMD_DIR}/${unit}"
    run_cmd install -m 0644 "${SCRIPT_DIR}/systemd/${unit}" "${SYSTEMD_DIR}/${unit}"
  done
  for env_tpl in jc-witness-signerd.env acs-jc.env acs-core.env; do
    reject_symlink "${SECRETS_DIR}/${env_tpl}"
    if [[ ! -f "${SECRETS_DIR}/${env_tpl}" ]]; then
      run_cmd install -m 0600 "${SCRIPT_DIR}/config/${env_tpl}.example" "${SECRETS_DIR}/${env_tpl}"
    fi
  done
  apply_chown jc-witness-signer:jc-witness-signer "${SECRETS_DIR}/jc-witness-signerd.env"
  apply_chown acs-jc:acs-jc "${SECRETS_DIR}/acs-jc.env"
  apply_chown acs-core:acs-core "${SECRETS_DIR}/acs-core.env"
else
  echo "  - Skipping systemd unit installation (--skip-systemd)"
fi

echo "=== JC Kernel Witness V2 installation complete (dry_run=${DRY_RUN}) ==="
