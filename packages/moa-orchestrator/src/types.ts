import { z } from "zod";

export const HIGH_RISK_CATEGORIES = [
  "shell",
  "filesystem_write",
  "mcp_tool_exposure",
  "gateway_auth",
  "worker_execution",
  "token_secret_handling",
  "sandbox_change",
  "policy_gate_change"
] as const;

export const HighRiskCategorySchema = z.enum(HIGH_RISK_CATEGORIES);
export type HighRiskCategory = z.infer<typeof HighRiskCategorySchema>;

export const ActionCategorySchema = z.enum([...HIGH_RISK_CATEGORIES, "network", "read_only"]);
export type ActionCategory = z.infer<typeof ActionCategorySchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const TaskEnvelopeSchema = z
  .object({
    task_id: z.string().regex(/^task_[A-Za-z0-9_-]{3,64}$/),
    origin: z.enum(["telegram", "cli", "qwenpaw", "openclaw", "web", "test"]),
    session_id: z.string().min(1).max(128),
    user_id: z.string().min(1).max(64).optional(),
    risk: RiskLevelSchema,
    kind: z.string().min(1).max(64),
    goal: z.string().min(1).max(4000),
    context: z
      .object({
        repo: z.string().max(512).optional(),
        branch: z.string().max(128).optional(),
        files: z.array(z.string().min(1).max(512)).max(64).default([]),
        snippets: z
          .array(z.object({ path: z.string().min(1).max(512), content: z.string().max(20_000) }).strict())
          .max(32)
          .default([])
      })
      .strict()
      .default({ files: [], snippets: [] }),
    constraints: z
      .object({
        no_mutation: z.boolean().default(true),
        max_advisor_tokens: z.number().int().min(64).max(2000).default(500),
        require_citations: z.boolean().default(false)
      })
      .strict()
      .default({ no_mutation: true, max_advisor_tokens: 500, require_citations: false })
  })
  .strict();
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

export const AdvisorOutputSchema = z
  .object({
    advisor_id: z.string().min(1).max(64),
    verdict: z.enum(["safe", "risky", "blocked", "insufficient_context"]),
    key_risks: z.array(z.string().max(500)).max(20).default([]),
    recommended_next_steps: z.array(z.string().max(500)).max(20).default([]),
    do_not_do: z.array(z.string().max(500)).max(20).default([]),
    confidence: z.number().min(0).max(1)
  })
  .strict();
export type AdvisorOutput = z.infer<typeof AdvisorOutputSchema>;

export const DecisionKindSchema = z.enum([
  "read_only_answer",
  "create_work_item",
  "request_approval",
  "execute_approved_work",
  "reject_task",
  "ask_for_more_context"
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const AggregatorDecisionSchema = z
  .object({
    decision: DecisionKindSchema,
    advisor_synthesis: z
      .object({
        consensus: z.string().max(4000),
        disagreements: z.array(z.string().max(1000)).max(20).default([]),
        ignored_advice: z.array(z.string().max(1000)).max(20).default([])
      })
      .strict(),
    risk: z.enum(["low", "medium", "high", "blocked"]),
    proposed_action: z
      .object({
        category: ActionCategorySchema,
        summary: z.string().max(2000),
        requires_mutation: z.boolean()
      })
      .strict()
      .nullable(),
    acs_work_item: z.object({ work_item_id: z.string().min(1).max(128) }).strict().nullable(),
    user_response: z.string().max(20_000)
  })
  .strict()
  .superRefine((decision, ctx) => {
    const actionable =
      decision.decision === "create_work_item" ||
      decision.decision === "request_approval" ||
      decision.decision === "execute_approved_work";
    if (decision.decision === "execute_approved_work" && !decision.acs_work_item) {
      ctx.addIssue({ code: "custom", message: "execute_approved_work requires acs_work_item.work_item_id" });
    }
    if (actionable && !decision.proposed_action) {
      ctx.addIssue({ code: "custom", message: `${decision.decision} requires proposed_action` });
    }
    if (decision.risk === "blocked" && actionable) {
      ctx.addIssue({ code: "custom", message: "blocked risk cannot request mutation or execution" });
    }
    if (
      decision.proposed_action?.requires_mutation &&
      (decision.decision === "read_only_answer" || decision.decision === "ask_for_more_context")
    ) {
      ctx.addIssue({ code: "custom", message: "mutation proposed but decision is non-actionable" });
    }
  });
export type AggregatorDecision = z.infer<typeof AggregatorDecisionSchema>;
