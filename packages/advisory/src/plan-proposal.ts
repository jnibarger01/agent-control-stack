import { createId, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { assertAdvisoryReasoner } from "./roles.js";

/**
 * `acs.plan-proposal.v1` — an immutable, content-addressed advisory artifact.
 *
 * A `PlanProposal` is what an `ADVISORY_REASONER` (ChatGPT, Hermes, Codex,
 * Claude, a local model) *proposes*. It is UNTRUSTED until ACS admits it into an
 * execution plan (`packages/policy-gate` + `packages/work-items`, unchanged).
 * Nothing in this package admits, approves, or executes anything.
 */

export const PLAN_PROPOSAL_SCHEMA_VERSION = "acs.plan-proposal.v1" as const;
export const PLAN_PROPOSAL_HASH_DOMAIN = "acs:plan-proposal:v1" as const;

const boundedString = z.string().min(1).max(4_000);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const planProposalActionSchema = z
  .object({
    kind: z.string().min(1).max(128),
    description: boundedString,
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const planProposalSchema = z
  .object({
    schemaVersion: z.literal(PLAN_PROPOSAL_SCHEMA_VERSION),
    proposalId: identifierSchema,
    workItemId: identifierSchema,
    principalId: identifierSchema,
    principalRole: z.literal("ADVISORY_REASONER"),
    goal: boundedString,
    assumptions: z.array(boundedString).max(64).default([]),
    actions: z.array(planProposalActionSchema).min(1).max(64),
    expectedFiles: z.array(z.string().min(1).max(4_096)).max(256).default([]),
    tests: z.array(boundedString).max(64).default([]),
    successCriteria: z.array(boundedString).max(64).default([]),
    riskNotes: z.array(boundedString).max(64).default([]),
    createdAt: z.string().datetime({ offset: true }),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

export type PlanProposal = z.infer<typeof planProposalSchema>;
export type PlanProposalAction = z.infer<typeof planProposalActionSchema>;

/** Deterministic content hash of every field except the hash itself. */
export function planProposalHash(input: Omit<PlanProposal, "proposalHash">): string {
  return domainHash(PLAN_PROPOSAL_HASH_DOMAIN, {
    schemaVersion: input.schemaVersion,
    proposalId: input.proposalId,
    workItemId: input.workItemId,
    principalId: input.principalId,
    principalRole: input.principalRole,
    goal: input.goal,
    assumptions: input.assumptions,
    actions: input.actions,
    expectedFiles: input.expectedFiles,
    tests: input.tests,
    successCriteria: input.successCriteria,
    riskNotes: input.riskNotes,
    createdAt: input.createdAt
  });
}

export interface CreatePlanProposalInput {
  workItemId: string;
  principalId: string;
  principalRole: unknown;
  goal: string;
  assumptions?: string[];
  actions: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
  expectedFiles?: string[];
  tests?: string[];
  successCriteria?: string[];
  riskNotes?: string[];
  now?: Date;
}

export function createPlanProposal(input: CreatePlanProposalInput): PlanProposal {
  assertAdvisoryReasoner(input.principalRole);
  const base = {
    schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION,
    proposalId: createId("plan_proposal"),
    workItemId: input.workItemId,
    principalId: input.principalId,
    principalRole: "ADVISORY_REASONER" as const,
    goal: input.goal,
    assumptions: input.assumptions ?? [],
    actions: input.actions.map((action) => ({
      kind: action.kind,
      description: action.description,
      params: action.params ?? {}
    })),
    expectedFiles: input.expectedFiles ?? [],
    tests: input.tests ?? [],
    successCriteria: input.successCriteria ?? [],
    riskNotes: input.riskNotes ?? [],
    createdAt: (input.now ?? new Date()).toISOString()
  };
  const parsedBase = planProposalSchema.omit({ proposalHash: true }).parse(base);
  return planProposalSchema.parse({ ...parsedBase, proposalHash: planProposalHash(parsedBase) });
}

/** Verify a proposal's stored hash matches its content (tamper check). */
export function verifyPlanProposalHash(proposal: PlanProposal): boolean {
  const { proposalHash: stored, ...rest } = proposal;
  return planProposalHash(rest) === stored;
}
