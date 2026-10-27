#!/usr/bin/env bash
# Migrate the Jace Commander service set to its canonical identities. DRY-RUN BY DEFAULT.
#
#   migrate-acs-jc-identities.sh                       print the plan, change nothing
#   sudo migrate-acs-jc-identities.sh --apply          install identities, executor state dir, units; writes a manifest
#   sudo migrate-acs-jc-identities.sh --rollback DIR   restore replaced units from DIR and remove what --apply added
#
# --apply never enables or starts a service, never edits an existing account, and never overwrites an existing
# secret file or unit without first copying the unit into the backup directory. Live cutover is a separate, approved step.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_DIR=/etc/systemd/system
SECRETS_DIR=/etc/acs-secrets
MODE=dry-run
BACKUP_ROOT=/var/backups/acs-jc
ROLLBACK_DIR=""
UNITS="acs-jc-public-ingress.service acs-jc-edge.service acs-jc-bridge.service"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE=apply; shift ;;
    --rollback) MODE=rollback; ROLLBACK_DIR="$2"; shift 2 ;;
    --systemd-dir) SYSTEMD_DIR="$2"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# write_template_if_absent PATH MANIFEST < template: writes a root-owned 0600 placeholder file, never overwrites.
write_template_if_absent() {
  local path="$1" manifest="$2"
  if [ -e "$path" ]; then
    say "kept existing $path (not overwritten)"
    cat > /dev/null
    return 0
  fi
  install -m 0600 -o root -g root /dev/null "$path"
  cat > "$path"
  echo "added $path" >> "$manifest"
  say "created placeholder $path: fill it in as root before any start"
}

plan() {
  say "PLAN (dry-run; nothing changed)"
  say "  1. systemd-sysusers $HERE/acs-jc.sysusers.conf                 -> acs-ingress, acs-edge, acs-jc, acs-jc-exec (if absent)"
  say "  2. systemd-tmpfiles --create $HERE/acs-jc.tmpfiles.conf        -> /var/lib/acs-jc-exec (0700, owned by acs-jc-exec)"
  say "  3. install units to $SYSTEMD_DIR (existing copies backed up first):"
  for u in $UNITS; do say "       $u"; done
  say "  4. placeholder secret files in $SECRETS_DIR only where NONE exists (never overwritten; mode 0600)"
  say "  5. write a manifest under $BACKUP_ROOT for rollback"
  say "  NOT done: enable, start, restart, rotate tokens, change any existing account, change firewall or Funnel."
}

apply() {
  if [ "$(id -u)" -ne 0 ]; then say "apply needs root; refusing"; exit 1; fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_ROOT/$stamp"
  install -d -m 0700 "$backup"
  manifest="$backup/manifest"
  : > "$manifest"

  systemd-sysusers "$HERE/acs-jc.sysusers.conf"
  systemd-tmpfiles --create "$HERE/acs-jc.tmpfiles.conf"

  for u in $UNITS; do
    dest="$SYSTEMD_DIR/$u"
    if [ -e "$dest" ]; then
      cp -p "$dest" "$backup/$u"
      echo "replaced $dest" >> "$manifest"
    else
      echo "added $dest" >> "$manifest"
    fi
    install -m 0644 -o root -g root "$HERE/$u" "$dest"
  done

  install -d -m 0755 -o root -g root "$SECRETS_DIR"
  write_template_if_absent "$SECRETS_DIR/acs-edge.env" "$manifest" <<'TEMPLATE'
# Placeholders only. Generate real values with a CSPRNG. Read only by acs-jc-edge.service.
SIGNING_KEY=REPLACE_WITH_32_PLUS_BYTE_RANDOM
CONSENT_PASSPHRASE=REPLACE_WITH_CONSENT_PASSPHRASE
GATEWAY_EXECUTION_TOKEN=REPLACE_WITH_ATTESTATION_SECRET
ACS_GATEWAY_URL=http://127.0.0.1:REPLACE_ACS_PORT
ACS_JC_GATEWAY_TOKEN=REPLACE_WITH_JC_GATEWAY_TOKEN
PUBLIC_ORIGIN=https://REPLACE_PUBLIC_HOST
JC_ENABLED=1
JC_UPSTREAM=http://127.0.0.1:8003
TEMPLATE
  write_template_if_absent "$SECRETS_DIR/acs-jc.env" "$manifest" <<'TEMPLATE'
# Placeholders only. The bridge never holds the gateway's OAuth key, consent passphrase, or ACS JC gateway token.
# Read only by acs-jc-bridge.service. The Ed25519 PRIVATE key stays here; the executor gets only the derived public key.
DC_GATEWAY_EXECUTION_TOKEN=REPLACE_WITH_ATTESTATION_SECRET
DC_GATEWAY_ATTESTATION_SIGNING_KEY=REPLACE_WITH_ED25519_PRIVATE_KEY_PEM_ON_ONE_LINE
ACS_GATEWAY_URL=http://127.0.0.1:REPLACE_ACS_PORT
ACS_WORKER_TOKEN=REPLACE_WITH_BRIDGE_WORKER_TOKEN
JC_ACS_PUBLIC_KEY=REPLACE_WITH_ACS_PUBLIC_KEY_PEM
JC_ACS_KEY_ID=REPLACE_WITH_KEY_ID
JC_RUNTIME_ID=REPLACE_WITH_RUNTIME_ID
TEMPLATE
  write_template_if_absent "$SECRETS_DIR/acs-ingress.env" "$manifest" <<'TEMPLATE'
# No secrets belong here. Read only by acs-jc-public-ingress.service.
JC_PUBLIC_HOST=REPLACE_PUBLIC_HOST
JC_RESOURCE=https://REPLACE_PUBLIC_HOST/jc/mcp
PUBLIC_INGRESS_PORT=8011
GATEWAY_PORT=8010
TEMPLATE

  systemctl daemon-reload
  say "applied. Manifest: $manifest"
  say "NOT enabled or started. Next: fill the secret files, run preflight.sh until it reports PASS, then start by explicit approval."
}

rollback() {
  if [ "$(id -u)" -ne 0 ]; then say "rollback needs root; refusing"; exit 1; fi
  manifest="$ROLLBACK_DIR/manifest"
  [ -f "$manifest" ] || { say "no manifest in $ROLLBACK_DIR; refusing"; exit 1; }
  while read -r action path; do
    case "$action" in
      replaced) cp -p "$ROLLBACK_DIR/$(basename "$path")" "$path" ;;
      added) rm -f -- "$path" ;;   # only what this migration added
    esac
  done < "$manifest"
  systemctl daemon-reload
  say "rolled back units and placeholder secret files from $ROLLBACK_DIR"
  say "Accounts, the executor state directory, and any existing secret files were NOT removed (do that by explicit decision)."
}

case "$MODE" in
  dry-run) plan ;;
  apply) apply ;;
  rollback) rollback ;;
esac
