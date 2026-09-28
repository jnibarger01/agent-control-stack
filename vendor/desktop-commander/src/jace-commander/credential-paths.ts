/**
 * Credential / secret-path recognition for Jace Commander's own filesystem
 * containment. Dependency-free so the root drift test can import it.
 *
 * RESTRICTED_PATH mirrors ACS's canonical pattern
 * (packages/desktop-commander-adapter/src/containment.ts `restrictedPathPattern`)
 * so standalone mode, which has no ACS in front of it, refuses the same
 * paths ACS refuses in managed mode. CREDENTIAL_BASENAME adds JC's
 * stricter basename rules (keys, .pem, .pgpass, *.env, …). The drift test
 * checks that every path ACS denies is also denied here.
 */
import path from 'node:path';

export const RESTRICTED_PATH =
  /(^|\/)(\.env(\.|$)|\.git\/config$|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.gnupg(\/|$)|\.aws\/credentials$|\.aws\/config$|\.kube\/config$|\.npmrc$|\.netrc$|credentials(\.json)?$|token(\.json)?$|\.docker\/config\.json$)/i;

export const CREDENTIAL_BASENAME =
  /^(\.env(\..*)?|.*\.env|\.netrc|\.npmrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|token(\.json)?|.*\.pem|.*\.key)$/i;

/** True when an absolute path names a credential or secret location. */
export function isCredentialPath(absolute: string): boolean {
  const normalized = absolute.split(path.sep).join('/');
  return RESTRICTED_PATH.test(normalized) || CREDENTIAL_BASENAME.test(path.basename(absolute));
}
