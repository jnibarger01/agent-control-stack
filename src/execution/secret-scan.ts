/**
 * Defence-in-depth secret detection and redaction.
 *
 * A preflight/sanitisation control only: it never decides whether an operation
 * is allowed (ACS does). Findings report type/category/location, never the
 * raw secret. The same redactor sanitises execution events and diagnostics.
 */

export interface SecretDetector {
  readonly id: string;
  readonly category: 'private_key' | 'token' | 'api_key' | 'cloud_credential' | 'password' | 'jwt' | 'env_secret';
  readonly pattern: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  readonly group?: number;
}

// Ordered most-specific first; each pattern must be global.
export const SECRET_DETECTORS: readonly SecretDetector[] = Object.freeze([
  { id: 'private_key_block', category: 'private_key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { id: 'github_token', category: 'token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github_fine_grained_pat', category: 'token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: 'gitlab_token', category: 'token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack_token', category: 'token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'anthropic_api_key', category: 'api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai_api_key', category: 'api_key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'stripe_key', category: 'api_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'google_api_key', category: 'api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm_token', category: 'token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'aws_access_key_id', category: 'cloud_credential', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'aws_secret_access_key', category: 'cloud_credential', pattern: /\baws_?secret_?access_?key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi, group: 1 },
  { id: 'azure_storage_key', category: 'cloud_credential', pattern: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g, group: 1 },
  { id: 'jwt', category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'bearer_token', category: 'token', pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{16,}=*)/g, group: 1 },
  { id: 'authorization_header', category: 'token', pattern: /\bauthorization\s*[:=]\s*["']?(?:basic|token)\s+([A-Za-z0-9._~+/-]{12,}=*)/gi, group: 1 },
  { id: 'url_credentials', category: 'password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, group: 1 },
  {
    id: 'env_secret_assignment',
    category: 'env_secret',
    pattern: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|SIGNING_?KEY|PASSPHRASE)[A-Z0-9_]*[ \t]*=[ \t]*["']?([^\s"'#]{8,})["']?/gim,
    group: 1,
  },
  {
    id: 'json_secret_field',
    category: 'env_secret',
    pattern: /"(?:[A-Za-z0-9_]*(?:secret|token|password|api_?key|private_?key|credential)[A-Za-z0-9_]*)"\s*:\s*"([^"\\]{8,})"/gi,
    group: 1,
  },
]) as readonly SecretDetector[];

export interface SecretFinding {
  detector: string;
  category: SecretDetector['category'];
  line: number;
  column: number;
  length: number;
}

interface RawMatch extends SecretFinding {
  start: number;
  end: number;
}

function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: index - lastBreak };
}

function rawMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const detector of SECRET_DETECTORS) {
    detector.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = detector.pattern.exec(text)) !== null) {
      const value = detector.group ? match[detector.group] : match[0];
      if (value === undefined || value.length === 0) {
        if (match[0].length === 0) detector.pattern.lastIndex += 1;
        continue;
      }
      const offset = detector.group ? match.index + match[0].indexOf(value) : match.index;
      const { line, column } = lineColumn(text, offset);
      matches.push({ detector: detector.id, category: detector.category, line, column, length: value.length, start: offset, end: offset + value.length });
      if (match[0].length === 0) detector.pattern.lastIndex += 1;
    }
  }
  // Keep the first (most specific) detector for overlapping spans.
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: RawMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.start >= cursor) {
      kept.push(m);
      cursor = m.end;
    }
  }
  return kept;
}

/** Findings without raw values. */
export function scanText(text: string): SecretFinding[] {
  return rawMatches(text).map(({ start: _s, end: _e, ...finding }) => finding);
}

/** Replace every detected secret with a typed placeholder. */
export function redactText(text: string): string {
  const matches = rawMatches(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[REDACTED:${m.detector}]`;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

const SENSITIVE_KEY = /(secret|token|password|passwd|passphrase|api_?key|private_?key|credential|authorization|cookie|signature|nonce)/i;
/** Exact non-secret literals allowed under a sensitive-looking key (nothing else is). */
const SAFE_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({ authorization: Object.freeze(['external']) });

/**
 * Deep-redact an arbitrary JSON-like value: sensitive keys are replaced
 * wholesale, strings are pattern-redacted. Used for diagnostics and events.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[REDACTED:depth]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) && entry !== null && entry !== undefined && typeof entry !== 'boolean'
        && !(typeof entry === 'string' && SAFE_FIELD_VALUES[key]?.includes(entry))
        ? '[REDACTED:field]'
        : redactValue(entry, depth + 1),
    ]));
  }
  return value;
}
