/**
 * Records a local-advisor result through the #367 consultation table (same insert as the gateway path).
 * The caller that already holds the lease must supply the fence; this module never invents one.
 * projectReviewFinding / advisor.recorded stay derived views at trust "asserted" and never feed
 * completion, authority, approvals, or receipts.
 */
import type {
  AdvisorConsultationRecord,
  AdvisorFence,
  MissionClaimFence,
  RecordAdvisorConsultationInput,
  WorkItemStore
} from "@agent-control-stack/work-items";
import { ControlStackError } from "@agent-control-stack/shared";
import type { AdvisorOperation, AdvisorResponse } from "./contracts.js";
import { redactText } from "./redact.js";
import { ReviewBindingError } from "./to-review-finding.js";

/** Text persisted to the consultation table is redacted here, independent of what the advisor already cleaned. */
const redactSensitiveText = (text: string): string => redactText(text).text;

const domain = { via: "domain_service" as const };

const OPERATION_CHECKPOINT = {
  review_plan: "before_approach",
  diagnose_failure: "recurring_failure",
  review_completion: "before_completion"
} as const satisfies Record<AdvisorOperation, RecordAdvisorConsultationInput["checkpoint"]>;

export type LocalAdvisorFence = AdvisorFence | MissionClaimFence;

export interface RecordLocalAdvisorConsultationInput {
  readonly response: AdvisorResponse;
  /** Subject the active binding is for. For work items this is usually the mission / work-item id. */
  readonly subjectId: string;
  readonly missionId: string;
  readonly subjectKind: "work_item" | "mission_unit";
  /** Must match the active binding; never taken from the Ollama model id. */
  readonly executorModelId: string;
  readonly advisorModelId: string;
  /** Fence the caller already holds. Required — this path does not invent a lease or claim. */
  readonly fence: LocalAdvisorFence;
  readonly store: Pick<WorkItemStore, "recordAdvisorConsultation">;
  readonly createdAt?: string;
}

/**
 * Maps a local-advisor response onto disposition fields for `recordAdvisorConsultation`.
 * `declined` is only used for insufficient evidence; it never satisfies completion on its own.
 */
export function consultationDraftFromResponse(
  response: AdvisorResponse
): Pick<
  RecordAdvisorConsultationInput,
  "disposition" | "guidanceText" | "declineReason" | "errorCode" | "inputTokens" | "outputTokens" | "inputSha256"
> {
  const inputSha256 = bareSha256(response.inputHash);
  const inputTokens = response.usage.promptTokens ?? null;
  const outputTokens = response.usage.completionTokens ?? null;
  if (response.status === "completed" && response.verdict !== undefined) {
    const guidance = redactSensitiveText(guidanceFromCompleted(response));
    return {
      disposition: "reviewed",
      guidanceText: guidance,
      declineReason: null,
      errorCode: null,
      inputSha256,
      inputTokens,
      outputTokens
    };
  }
  if (response.status === "insufficient_evidence") {
    return {
      disposition: "declined",
      guidanceText: null,
      declineReason: redactSensitiveText(response.reason ?? "insufficient_evidence"),
      errorCode: null,
      inputSha256,
      inputTokens,
      outputTokens
    };
  }
  return {
    disposition: "unavailable",
    guidanceText: null,
    declineReason: null,
    errorCode: unavailableCode(response),
    inputSha256,
    inputTokens,
    outputTokens
  };
}

/**
 * Writes one consultation row through WorkItemStore.recordAdvisorConsultation (the #367 insert).
 * Prefer the gateway's runAdvisorConsultation when a projected flight is available so projectFlightForAdvisor runs;
 * use this when the caller already has a local-advisor response and a live fence.
 */
export function recordLocalAdvisorConsultation(input: RecordLocalAdvisorConsultationInput): AdvisorConsultationRecord {
  if (!input.fence) {
    throw new ControlStackError("advisor_lease_stale", "consultation requires a fence the caller already holds");
  }
  // Never record advice about one mission against another mission or subject.
  if (input.response.missionId !== input.missionId) {
    throw new ReviewBindingError("advisor response mission does not match the recording mission");
  }
  if (input.fence.kind === "work_item" && input.fence.workItemId !== input.subjectId) {
    throw new ReviewBindingError("recording subject does not match the work-item fence");
  }
  if (input.fence.kind === "mission_unit" && input.fence.missionId !== input.missionId) {
    throw new ReviewBindingError("recording mission does not match the mission-claim fence");
  }
  const draft = consultationDraftFromResponse(input.response);
  return input.store.recordAdvisorConsultation(
    {
      subjectId: input.subjectId,
      missionId: input.missionId,
      subjectKind: input.subjectKind,
      checkpoint: OPERATION_CHECKPOINT[input.response.operation],
      disposition: draft.disposition,
      inputSha256: draft.inputSha256,
      guidanceText: draft.guidanceText,
      declineReason: draft.declineReason,
      errorCode: draft.errorCode,
      executorModelId: input.executorModelId,
      advisorModelId: input.advisorModelId,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
      createdAt: input.createdAt,
      fence: input.fence
    },
    domain
  );
}

function guidanceFromCompleted(response: AdvisorResponse): string {
  const parts: string[] = [`verdict=${response.verdict}`];
  for (const finding of response.findings) {
    parts.push(`[${finding.severity}] ${finding.category}: ${finding.summary}`);
  }
  for (const action of response.recommendedActions) parts.push(`action: ${action}`);
  return parts.join("\n");
}

function unavailableCode(response: AdvisorResponse): string {
  if (
    response.status === "invalid_output" ||
    response.reason === "model_output_invalid" ||
    response.reason === "model_output_schema_violation" ||
    response.reason === "model_output_incoherent"
  ) {
    return "advisor_output_invalid";
  }
  if (response.status === "timeout" || response.reason === "provider_timeout" || response.reason === "cancelled") {
    return "advisor_timeout";
  }
  return "advisor_unavailable";
}

/** Strip the `sha256:` prefix local-advisor puts on hashes; the consultation table stores bare hex. */
function bareSha256(value: string): string {
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  // A non-hex input hash is refused, never re-hashed: re-hashing would bind the record to bytes nobody reviewed.
  if (!/^[a-f0-9]{64}$/u.test(hex)) {
    throw new ControlStackError("advisor_output_invalid", "advisor response input hash is not a sha256 digest");
  }
  return hex;
}
