import type { AuditReadModel } from "@agent-control-stack/mission-control-contract";
import type { StoredAuditEvent } from "@agent-control-stack/work-items";
import { redactAttributes, redactSecrets } from "../redaction.js";

const MAX_ATTRS = 40;
const text = (value: unknown, max: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};
const nanosToIso = (nanos: string): string => {
  try {
    return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
  } catch {
    return "";
  }
};

/**
 * Pure projection of audit events: attributes are deep-redacted by the same rules as the classic
 * console (secret-named keys and secret-looking values), then coerced to bounded primitives. The raw
 * `body` is never forwarded; only the policy decision fields the Policy page renders are extracted.
 */
export function toAuditReadModel(events: StoredAuditEvent[], limit: number, now: Date = new Date()): AuditReadModel {
  const sorted = [...events].sort((a, b) => b.sequence - a.sequence);
  const page = sorted.slice(0, limit);
  const mapped = page.map((event) => {
    const redacted = redactAttributes(event.attributes ?? {}) as Record<string, unknown>;
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(redacted).slice(0, MAX_ATTRS)) {
      attributes[text(key, 120)] = typeof value === "number" || typeof value === "boolean" ? value : text(typeof value === "string" ? value : JSON.stringify(value), 300);
    }
    const body = event.body as Record<string, unknown> | undefined;
    const policy =
      event.name === "policy.decided" && body && typeof body.decision === "string"
        ? {
            decision: text(body.decision, 40),
            ...(typeof body.reason === "string" ? { reason: text(body.reason, 400) } : {}),
            matchedRules: Array.isArray(body.matchedRules) ? body.matchedRules.filter((r): r is string => typeof r === "string").slice(0, 32).map((r) => text(r, 120)) : [],
            ...(typeof body.requiredApprover === "string" ? { requiredApprover: text(body.requiredApprover, 120) } : {})
          }
        : undefined;
    return {
      sequence: event.sequence,
      id: event.id,
      name: text(event.name, 160),
      at: nanosToIso(event.timeUnixNano),
      attributes,
      ...(policy ? { policy } : {}),
      eventHash: text(event.eventHash, 128),
      previousHash: text(event.previousHash, 128)
    };
  });
  const oldest = mapped.at(-1)?.sequence;
  // A full page means there may be older events; a short page means we reached the start.
  const nextBefore = sorted.length >= limit && oldest !== undefined && oldest > 1 ? oldest : null;
  return { schemaVersion: 1, generatedAt: now.toISOString(), events: mapped, nextBefore };
}
