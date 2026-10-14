import {
  contentHash,
  EVIDENCE_SCHEMA_VERSION,
  eventId,
  evidenceEventSchema,
  stageOf,
  type EvidenceEvent
} from "@agent-control-stack/looptrace-query";
import { type AdvisorResponse } from "./contracts.js";
import { redactText } from "./redact.js";

export type AdvisorAuthorizationOutcome = "not_applicable" | "evidence_only" | "fail_closed";

const FACT = 200;

function clip(value: string): string {
  const redacted = redactText(value).text;
  return redacted.length <= FACT ? redacted : `${redacted.slice(0, FACT - 1)}…`;
}

/**
 * One LoopTrace `advisor.recorded` event. Trust is `asserted` and the stage is `lifecycle`,
 * matching JC events: the record can be correlated, and it cannot satisfy an ACS stage or
 * produce a LoopTrace PASS. Raw prompts are not stored. Findings are redacted and clipped.
 */
export function advisorTraceEvent(
  response: AdvisorResponse,
  input: { observedAt: string; authorizationOutcome: AdvisorAuthorizationOutcome }
): EvidenceEvent {
  const facts: Record<string, string | number | boolean | null> = {
    advisor_schema: response.schemaVersion,
    operation: response.operation,
    status: response.status,
    reason: response.reason ?? null,
    verdict: response.verdict ?? null,
    model_id: response.model?.id ?? null,
    model_digest: response.model?.digest ?? null,
    input_hash: response.inputHash,
    latency_ms: response.usage.latencyMs,
    prompt_tokens: response.usage.promptTokens ?? null,
    completion_tokens: response.usage.completionTokens ?? null,
    finding_count: response.findings.length,
    recommendation_count: response.recommendedActions.length,
    authorization_outcome: input.authorizationOutcome
  };
  response.findings.slice(0, 8).forEach((finding, index) => {
    facts[`finding_${index}_severity`] = finding.severity;
    facts[`finding_${index}_category`] = clip(finding.category);
    facts[`finding_${index}_summary`] = clip(finding.summary);
    facts[`finding_${index}_refs`] = clip(finding.evidenceRefs.join(","));
  });
  response.recommendedActions.slice(0, 8).forEach((action, index) => {
    facts[`action_${index}`] = clip(action);
  });

  const integrityBody = {
    trust: "asserted" as const,
    basis: "local_advisor_recommendation",
    // Unchecked, not failed: LoopTrace treats `false` as a confirmed integrity failure and would poison verification.
    hash_verified: null,
    chain: "not_chained" as const
  };
  const event = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    event_id: eventId("local-advisor", response.requestId),
    trace_id: null,
    request_id: response.requestId,
    work_item_id: response.missionId,
    span_id: null,
    parent_span_id: null,
    timestamp: input.observedAt,
    observed_at: input.observedAt,
    actor: { id: "local-advisor", type: "agent" as const },
    source: { system: "local-advisor", component: "ollama", instance: response.model?.id ?? null },
    event_type: "advisor.recorded" as const,
    stage: stageOf("advisor.recorded"),
    decision: response.verdict ?? response.status,
    tool_name: response.operation,
    capability_id: null,
    release_sha: null,
    status: response.status,
    evidence_ref: response.inputHash,
    integrity: { ...integrityBody, content_hash: contentHash(facts) },
    causes: [],
    facts,
    refs: { mission_id: response.missionId, input_hash: response.inputHash },
    untrusted: {},
    flags: ["advisor_untrusted", "not_authorization"]
  };
  return evidenceEventSchema.parse(event);
}
