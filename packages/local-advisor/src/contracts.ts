import { findingSchema, reviewVerdictSchema } from "@agent-control-stack/advisory";
import { z } from "zod";

/**
 * `advisor.v1` — the versioned contract between an agent client (Claude Code, OpenClaw, ACS, any MCP client) and the
 * local advisor. Everything the advisor returns is an UNTRUSTED recommendation. It never grants capability, approves
 * execution, or overrides ACS policy.
 */
export const ADVISOR_SCHEMA_VERSION = "advisor.v1" as const;
export const ADVISOR_OPERATIONS = ["review_plan", "diagnose_failure", "review_completion"] as const;
export type AdvisorOperation = (typeof ADVISOR_OPERATIONS)[number];

/** Operational status. Only `completed` may carry a review verdict. */
export const ADVISOR_STATUSES = [
  "completed",
  "unavailable",
  "timeout",
  "invalid_output",
  "insufficient_evidence"
] as const;
export type AdvisorStatus = (typeof ADVISOR_STATUSES)[number];

export const ADVISOR_REASONS = [
  "no_evidence",
  "provider_unavailable",
  "memory_pressure",
  "model_not_installed",
  "model_digest_mismatch",
  "provider_timeout",
  "cancelled",
  "model_output_invalid",
  "model_output_schema_violation",
  "model_output_incoherent",
  "model_reports_insufficient_evidence"
] as const;
export type AdvisorReason = (typeof ADVISOR_REASONS)[number];

export const EVIDENCE_KINDS = ["file", "log", "tool_result", "test_report", "diff", "other"] as const;

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const sha256Ref = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedText = (max: number) => z.string().min(1).max(max);

/**
 * Aggregate cap on evidence content per request. Per-item limits alone (64 x 65,536) would allow ~4 MiB, far more
 * than one MCP frame; this bound is what the transport is sized for.
 */
export const MAX_TOTAL_EVIDENCE_CHARS = 262_144;

export const evidenceItemSchema = z
  .object({
    id: identifier,
    kind: z.enum(EVIDENCE_KINDS),
    content: z.string().max(65_536)
  })
  .strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/** Raw object shape of `advisor.v1` requests. Exposed so MCP tools can reuse it without the `operation` field. */
export const advisorRequestObject = z
  .object({
    schemaVersion: z.literal(ADVISOR_SCHEMA_VERSION),
    requestId: identifier,
    operation: z.enum(ADVISOR_OPERATIONS),
    mission: z.object({ id: identifier, envelopeHash: sha256Ref }).strict(),
    context: z
      .object({
        objective: boundedText(4_000),
        constraints: z.array(boundedText(500)).max(50).default([]),
        evidence: z.array(evidenceItemSchema).max(64).default([])
      })
      .strict(),
    budget: z
      .object({
        timeoutMs: z.number().int().min(1_000).max(120_000),
        maxOutputTokens: z.number().int().min(64).max(4_096)
      })
      .strict()
  })
  .strict();

export const advisorRequestSchema = advisorRequestObject.superRefine((request, ctx) => {
  const ids = request.context.evidence.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["context", "evidence"], message: "evidence ids must be unique" });
  }
  const total = request.context.evidence.reduce((sum, item) => sum + item.content.length, 0);
  if (total > MAX_TOTAL_EVIDENCE_CHARS) {
    ctx.addIssue({
      code: "custom",
      path: ["context", "evidence"],
      message: `total evidence content must not exceed ${MAX_TOTAL_EVIDENCE_CHARS} characters`
    });
  }
});
export type AdvisorRequest = z.infer<typeof advisorRequestSchema>;

/**
 * What the MODEL must produce. Kept deliberately small: the advisor (not the model) assigns status, identity, hashes,
 * and usage. `INSUFFICIENT_EVIDENCE` is a model-side refusal to judge and is mapped to a non-verdict status.
 */
export const MODEL_VERDICTS = [...reviewVerdictSchema.options, "INSUFFICIENT_EVIDENCE"] as const;
export const modelReviewOutputSchema = z
  .object({
    verdict: z.enum(MODEL_VERDICTS),
    findings: z
      .array(
        z
          .object({
            category: boundedText(128),
            severity: findingSchema.shape.severity,
            summary: boundedText(2_000),
            evidenceIds: z.array(identifier).min(0).max(16)
          })
          .strict()
      )
      .max(32),
    recommendedActions: z.array(boundedText(500)).max(16)
  })
  .strict();
export type ModelReviewOutput = z.infer<typeof modelReviewOutputSchema>;

export const advisorResponseSchema = z
  .object({
    schemaVersion: z.literal(ADVISOR_SCHEMA_VERSION),
    requestId: identifier,
    missionId: identifier,
    operation: z.enum(ADVISOR_OPERATIONS),
    status: z.enum(ADVISOR_STATUSES),
    reason: z.enum(ADVISOR_REASONS).optional(),
    /** Present only when `status === "completed"`. Maps to the existing ACS `ReviewVerdict` enum. */
    verdict: reviewVerdictSchema.optional(),
    findings: z
      .array(
        z
          .object({
            category: boundedText(128),
            severity: findingSchema.shape.severity,
            summary: boundedText(2_000),
            evidenceRefs: z.array(identifier).min(1).max(16)
          })
          .strict()
      )
      .max(32),
    recommendedActions: z.array(boundedText(500)).max(16),
    model: z
      .object({
        provider: z.literal("ollama"),
        id: boundedText(200),
        digest: sha256Ref
      })
      .strict()
      .nullable(),
    inputHash: sha256Ref,
    evidenceHashes: z.record(identifier, sha256Ref),
    usage: z
      .object({
        latencyMs: z.number().int().min(0),
        promptTokens: z.number().int().min(0).optional(),
        completionTokens: z.number().int().min(0).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((response, ctx) => {
    const completed = response.status === "completed";
    if (completed && response.verdict === undefined) {
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "completed status requires a verdict" });
    }
    if (!completed && response.verdict !== undefined) {
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "non-completed status must not carry a verdict" });
    }
    if (!completed && response.findings.length > 0) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "non-completed status must not carry findings" });
    }
    if (completed && response.model === null) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "completed review requires model identity and digest" });
    }
  });
export type AdvisorResponse = z.infer<typeof advisorResponseSchema>;

/** Raised for caller errors: the request does not satisfy `advisor.v1`. Never converted into a review. */
export class AdvisorRequestError extends Error {
  constructor(message: string) {
    super(`invalid advisor.v1 request: ${message}`);
    this.name = "AdvisorRequestError";
  }
}
