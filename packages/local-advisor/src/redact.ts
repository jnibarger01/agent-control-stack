/**
 * Best-effort credential redaction applied to evidence BEFORE it is hashed, sent to a model, or recorded.
 * Redaction is defense in depth; callers must still avoid sending secrets in evidence.
 */
const PATTERNS: readonly { readonly name: string; readonly pattern: RegExp; readonly replace: string }[] = [
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    replace: "[REDACTED:private_key]"
  },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, replace: "[REDACTED:aws_key]" },
  { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/gu, replace: "[REDACTED:github_token]" },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu, replace: "[REDACTED:github_token]" },
  { name: "slack_refresh_token", pattern: /\bxoxe\.xox[a-z]-[A-Za-z0-9-]{10,}/gu, replace: "[REDACTED:slack_token]" },
  { name: "slack_token", pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}/gu, replace: "[REDACTED:slack_token]" },
  { name: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/gu, replace: "[REDACTED:gitlab_token]" },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu, replace: "[REDACTED:npm_token]" },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/gu, replace: "[REDACTED:google_api_key]" },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
    replace: "[REDACTED:jwt]"
  },
  {
    name: "url_password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/giu,
    replace: "$1[REDACTED:url_password]@"
  },
  { name: "basic_auth", pattern: /\bBasic\s+[A-Za-z0-9+/]{8,}=*/gu, replace: "Basic [REDACTED:basic_auth]" },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/giu, replace: "Bearer [REDACTED:bearer]" },
  { name: "provider_key", pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/gu, replace: "[REDACTED:api_key]" },
  {
    name: "quoted_assignment",
    pattern: /((?:api[_-]?key|secret|token|passw(?:or)?d|auth)[\w-]*\s*[:=]\s*)(["'])[^"'\n]*\s[^"'\n]*\2/giu,
    replace: "$1$2[REDACTED:assignment]$2"
  },
  {
    name: "assignment",
    pattern: /((?:api[_-]?key|secret|token|passw(?:or)?d|auth)[\w-]*\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/giu,
    replace: "$1$2[REDACTED:assignment]$2"
  },
  { name: "home_path", pattern: /(?:\/home|\/Users)\/[^/\s]+/gu, replace: "~" }
];

export interface RedactionResult {
  readonly text: string;
  /** Count of replacements per pattern name, so telemetry can say "1 secret redacted" without the secret. */
  readonly counts: Readonly<Record<string, number>>;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  const counts: Record<string, number> = {};
  for (const { name, pattern, replace } of PATTERNS) {
    const matches = text.match(pattern)?.length ?? 0;
    if (matches > 0) {
      counts[name] = matches;
      text = text.replace(pattern, replace);
    }
  }
  return { text, counts };
}
