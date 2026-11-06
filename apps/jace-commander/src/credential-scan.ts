/**
 * Jace Commander credential scanner and redactor (JC-owned).
 *
 * Defence in depth only: it never authorizes anything (ACS does). Used by
 * git_push (refuse pushing commits that add credentials) and by the structured
 * logger (redact anything that looks like a credential before it is written).
 * Findings report detector/category/location, never the raw value.
 */

export interface CredentialDetector {
  readonly id: string;
  readonly category: 'private_key' | 'token' | 'api_key' | 'cloud_credential' | 'password' | 'jwt' | 'env_secret';
  readonly pattern: RegExp;
  /** Capture group holding the sensitive value (0 = whole match). */
  readonly group?: number;
}

// Ordered most-specific first; each pattern must be global.
export const CREDENTIAL_DETECTORS: readonly CredentialDetector[] = Object.freeze([
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
]) as readonly CredentialDetector[];

export interface CredentialFinding {
  detector: string;
  category: CredentialDetector['category'];
  line: number;
  column: number;
  length: number;
}

interface RawMatch extends CredentialFinding {
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
  for (const detector of CREDENTIAL_DETECTORS) {
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
export function scanText(text: string): CredentialFinding[] {
  return rawMatches(text).map(({ start: _s, end: _e, ...finding }) => finding);
}

/** Replace every detected credential with a typed placeholder. */
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

const SENSITIVE_KEY = /(secret|token|password|passwd|passphrase|api_?key|private_?key|credential|authorization|cookie|signature|nonce|attestation)/i;

/** Deep-redact a JSON-like value: sensitive keys replaced wholesale, strings pattern-redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[REDACTED:depth]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) && entry !== null && entry !== undefined && typeof entry !== 'boolean'
        ? '[REDACTED:field]'
        : redactValue(entry, depth + 1),
    ]));
  }
  return value;
}

/**
 * Keeps only added-line content of a unified diff (line numbering preserved).
 * Inside a hunk EVERY '+' line is content; only a '+++ ' line directly after a
 * '--- ' line outside a hunk is a file header. Hunk extents come from @@ counts.
 */
export function addedLinesOnly(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\r$/, '');
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) { out.push(''); continue; }
      const op = line[0];
      if (op === '+') { newLeft -= 1; out.push(line.slice(1)); continue; }
      if (op === '-') { oldLeft -= 1; out.push(''); continue; }
      oldLeft -= 1;
      newLeft -= 1;
      out.push('');
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
      out.push('');
      continue;
    }
    const isFileHeader = line.startsWith('+++ ') && (lines[i - 1] ?? '').startsWith('--- ');
    out.push(line.startsWith('+') && !isFileHeader ? line.slice(1) : '');
  }
  return out.join('\n');
}

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export interface PatchScanResult {
  clean: boolean;
  findingCount: number;
  byCategory: Record<string, number>;
  findings: CredentialFinding[];
}

/** Scan the lines a patch would ADD. Throws above the scan bound (callers fail closed). */
export function scanPatch(patch: string): PatchScanResult {
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new RangeError(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
  const findings = scanText(addedLinesOnly(patch));
  const byCategory: Record<string, number> = {};
  for (const finding of findings) byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
  return { clean: findings.length === 0, findingCount: findings.length, byCategory, findings: findings.slice(0, 500) };
}
