import type { MoaAuditEvent } from "./ports.js";
import type { AggregatorDecision, AdvisorOutput } from "./types.js";
import { sha256, stableStringify } from "./util.js";

export interface MoaAuditSanitizeOptions {
  debugRawPayloads?: boolean;
}

export function sanitizeMoaAuditPayload(
  type: MoaAuditEvent["type"],
  data: Record<string, unknown>,
  options: MoaAuditSanitizeOptions = {}
): Record<string, unknown> {
  const safe = sanitizeKnownPayload(type, data);
  if (!options.debugRawPayloads || type === "moa_advisor_completed") {
    return safe;
  }
  return { ...safe, debug_raw_sha256: hashValue(data) };
}

function sanitizeKnownPayload(type: MoaAuditEvent["type"], data: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "moa_run_started":
      return {
        advisor_ids: data.advisor_ids,
        aggregator_id: data.aggregator_id,
        declared_risk: data.declared_risk,
        kind: data.kind,
        goal_sha256: hashValue(data.goal)
      };
    case "moa_advisor_completed": {
      const output = data.output as AdvisorOutput | undefined;
      return {
        advisor_id: data.advisor_id,
        verdict: output?.verdict,
        confidence: output?.confidence,
        input_sha256: data.input_sha256,
        output_sha256: data.output_sha256 ?? hashValue(output),
        context_truncated: data.context_truncated
      };
    }
    case "moa_advisor_failed":
      return { advisor_id: data.advisor_id, reason_sha256: hashValue(data.reason) };
    case "moa_aggregator_decision": {
      const decision = data.decision as AggregatorDecision | undefined;
      return {
        aggregator_id: data.aggregator_id,
        decision: decision?.decision,
        risk: decision?.risk,
        proposed_action_category: decision?.proposed_action?.category,
        proposed_action_sha256: hashValue(decision?.proposed_action),
        decision_sha256: hashValue(decision),
        input_sha256: data.input_sha256,
        output_sha256: data.output_sha256 ?? hashValue(decision)
      };
    }
    case "moa_acs_action":
      return pick(data, [
        "action",
        "work_item_id",
        "requires_approval",
        "aggregator_requested",
        "escalated",
        "category",
        "expected_action_hash",
        "decision"
      ]);
    case "moa_execution_blocked":
      return {
        work_item_id: data.work_item_id,
        status: data.status,
        expected_action_hash: data.expected_action_hash,
        reason_sha256: hashValue(data.reason)
      };
    case "moa_run_completed":
      return pick(data, ["decision", "acs_work_item_id"]);
    case "moa_run_failed_closed":
      return { stage: data.stage, failed_advisors: data.failed_advisors, reason_sha256: hashValue(data.reason) };
  }
}

function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

function hashValue(value: unknown): string {
  return sha256(typeof value === "string" ? value : stableStringify(value));
}
