/**
 * Redacts tokens, private keys, PKCE verifiers, and DPoP proofs from logs,
 * error messages, and CLI output so secrets never leak to stdout/stderr.
 */

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const PEM_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHZ_HEADER_RE = /\b(Authorization\s*:\s*(?:Bearer|DPoP)\s+)[^\s"',}]+/gi;
const DPOP_HEADER_RE = /\b(DPoP\s*:\s*)[^\s"',}]+/gi;
const JSON_SECRET_RE = /("(?:access_token|refresh_token|code_verifier|client_secret|refresh_proof|device_signature|id_token)"\s*:\s*")([^"]+)(")/gi;
const FORM_SECRET_RE = /\b((?:access_token|refresh_token|code_verifier|client_secret|refresh_proof|device_signature|id_token)=)([^&\s"']+)/gi;

export function redactSecrets(input: string, knownSecrets?: Iterable<string | undefined>): string {
  let out = input;
  if (knownSecrets) {
    for (const secret of knownSecrets) {
      if (typeof secret === 'string' && secret.length >= 4) {
        out = out.split(secret).join('[REDACTED]');
      }
    }
  }
  out = out.replace(PEM_KEY_RE, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(JWT_RE, '[REDACTED_JWT]');
  out = out.replace(AUTHZ_HEADER_RE, '$1[REDACTED]');
  out = out.replace(DPOP_HEADER_RE, '$1[REDACTED]');
  out = out.replace(JSON_SECRET_RE, '$1[REDACTED]$3');
  out = out.replace(FORM_SECRET_RE, '$1[REDACTED]');
  return out;
}

export function safeErrorMessage(error: unknown, knownSecrets?: Iterable<string | undefined>): string {
  const msg = error instanceof Error ? error.message : String(error);
  return redactSecrets(msg, knownSecrets);
}
