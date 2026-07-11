import type { Redactor } from "@agent-control-stack/moa-orchestrator";
import { redactValue } from "@agent-control-stack/shared";

const inlinePatterns: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]"],
  [/\b(password|passwd|api_key|apikey|secret|token)\s*[=:]\s*["']?[^\s"']{4,}["']?/gi, "$1=[REDACTED]"]
];

export function createSharedRedactor(): Redactor {
  return {
    redact(text: string): string {
      const inline = inlinePatterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
      const checked = redactValue(inline);
      return typeof checked === "string" ? checked : inline;
    }
  };
}
