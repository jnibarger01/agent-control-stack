import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { NON_RETRYABLE_FAILURES, type FailureCategory } from "@agent-control-stack/coding-mission";
import type { NormalizedFailure } from "./contract.js";

const MAX_NATIVE = 500;

export function scrubNative(value: unknown): string {
  const text =
    typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(redactValue(value));
  const redacted = redactValue({ message: text }) as { message: string };
  return redacted.message.replace(/\s+/gu, " ").slice(0, MAX_NATIVE);
}

/** Pick a category from a ControlStackError code or an error name. Anything unrecognized is `unknown`, never guessed. */
export function categoryForError(error: unknown): FailureCategory {
  const code = error instanceof ControlStackError ? error.code : error instanceof Error ? error.name : "";
  const text = `${code} ${error instanceof Error ? error.message : ""}`.toLowerCase();
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (/(timeout|timed out|etimedout)/u.test(text)) return "timeout";
  // A refusal always wins over a more specific-sounding cause: a denied lease is a policy denial, not a lost lease.
  if (/(denied|forbidden|unauthorized|not_authorized|policy)/u.test(text)) return "policy_denied";
  if (/(expired|expiry)/u.test(text)) return "authority_expired";
  if (/(lease|fencing|claim_conflict)/u.test(text)) return "lease_lost";
  if (/(unavailable|econnrefused|enoent|spawn)/u.test(text)) return "worker_unavailable";
  if (/(invalid|malformed|schema)/u.test(text)) return "invalid_output";
  return "unknown";
}

/**
 * Normalize a failure. `sideEffectsPossible` is the worker's honest answer to "could this have changed something
 * outside ACS?". It defaults to true, so a retry is only ever declared safe when the worker positively says it is.
 */
export function normalizeFailure(input: {
  category: FailureCategory;
  nativeCode?: string;
  nativeMessage?: unknown;
  sideEffectsPossible?: boolean;
}): NormalizedFailure {
  const sideEffectsPossible = input.sideEffectsPossible ?? true;
  return {
    category: input.category,
    ...(input.nativeCode ? { nativeCode: input.nativeCode.slice(0, 128) } : {}),
    ...(input.nativeMessage === undefined ? {} : { nativeMessage: scrubNative(input.nativeMessage) }),
    retrySafe: !sideEffectsPossible && !NON_RETRYABLE_FAILURES.has(input.category)
  };
}

export function failureFromError(error: unknown, sideEffectsPossible = true): NormalizedFailure {
  return normalizeFailure({
    category: categoryForError(error),
    nativeCode: error instanceof ControlStackError ? error.code : error instanceof Error ? error.name : "thrown",
    nativeMessage: error,
    sideEffectsPossible
  });
}
