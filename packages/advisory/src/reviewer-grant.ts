import { createId, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * `acs.reviewer-grant.v1` — an ACS-issued, ACS-verified, scope-limited grant
 * that authorizes an `ADVISORY_REASONER` to READ one attempt's evidence, and
 * nothing else.
 *
 * It is analogous to an attempt lease: issued by ACS, bound to an exact
 * attempt + workspace revision, single-use / expiring, verified at the read
 * boundary (`apps/evidence-mcp`). It is NOT a second identity or token system;
 * it carries only the `acs:evidence:read` scope. A grant for attempt N does not
 * match attempt N+1, and a grant does not match a changed workspace.
 */

export const REVIEWER_GRANT_SCHEMA_VERSION = "acs.reviewer-grant.v1" as const;
export const REVIEWER_GRANT_HASH_DOMAIN = "acs:reviewer-grant:v1" as const;

export const REVIEWER_EVIDENCE_SCOPE = "acs:evidence:read" as const;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const reviewerGrantSchema = z
  .object({
    schemaVersion: z.literal(REVIEWER_GRANT_SCHEMA_VERSION),
    grantId: identifierSchema,
    principalId: identifierSchema,
    principalRole: z.literal("ADVISORY_REASONER"),
    workItemId: identifierSchema,
    planId: identifierSchema,
    admittedPlanHash: hash64,
    attemptId: identifierSchema,
    workspaceId: identifierSchema,
    workspaceRevision: z.string().min(1).max(256),
    scopes: z.array(z.literal(REVIEWER_EVIDENCE_SCOPE)).min(1).max(1),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    grantHash: hash64
  })
  .strict();

export type ReviewerGrant = z.infer<typeof reviewerGrantSchema>;

export function reviewerGrantHash(input: Omit<ReviewerGrant, "grantHash">): string {
  return domainHash(REVIEWER_GRANT_HASH_DOMAIN, {
    schemaVersion: input.schemaVersion,
    grantId: input.grantId,
    principalId: input.principalId,
    principalRole: input.principalRole,
    workItemId: input.workItemId,
    planId: input.planId,
    admittedPlanHash: input.admittedPlanHash,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    workspaceRevision: input.workspaceRevision,
    scopes: input.scopes,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  });
}

export interface IssueReviewerGrantInput {
  principalId: string;
  workItemId: string;
  planId: string;
  admittedPlanHash: string;
  attemptId: string;
  workspaceId: string;
  workspaceRevision: string;
  ttlMs?: number;
  now?: Date;
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const MAX_TTL_MS = 4 * 60 * 60 * 1_000;

export function issueReviewerGrant(input: IssueReviewerGrantInput): ReviewerGrant {
  const now = input.now ?? new Date();
  const ttl = Math.min(Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS), MAX_TTL_MS);
  const base = {
    schemaVersion: REVIEWER_GRANT_SCHEMA_VERSION,
    grantId: createId("reviewer_grant"),
    principalId: input.principalId,
    principalRole: "ADVISORY_REASONER" as const,
    workItemId: input.workItemId,
    planId: input.planId,
    admittedPlanHash: input.admittedPlanHash,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    workspaceRevision: input.workspaceRevision,
    scopes: [REVIEWER_EVIDENCE_SCOPE] as [typeof REVIEWER_EVIDENCE_SCOPE],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString()
  };
  const parsedBase = reviewerGrantSchema.omit({ grantHash: true }).parse(base);
  return reviewerGrantSchema.parse({ ...parsedBase, grantHash: reviewerGrantHash(parsedBase) });
}

export interface ReviewerGrantTarget {
  principalId: string;
  workItemId: string;
  attemptId: string;
  workspaceId: string;
  workspaceRevision: string;
  admittedPlanHash: string;
}

export type ReviewerGrantCheck =
  | { ok: true; grant: ReviewerGrant }
  | { ok: false; reason: string };

/**
 * Fail-closed grant verification. A grant authorized for attempt N MUST NOT
 * pass for attempt N+1, a changed workspace revision, a changed admitted plan,
 * a different principal, an expired grant, or a tampered grant.
 */
export function checkReviewerGrant(
  grant: ReviewerGrant,
  target: ReviewerGrantTarget,
  now: Date = new Date()
): ReviewerGrantCheck {
  const { grantHash: stored, ...rest } = grant;
  if (reviewerGrantHash(rest) !== stored) return { ok: false, reason: "reviewer_grant_tampered" };
  if (grant.principalRole !== "ADVISORY_REASONER") return { ok: false, reason: "reviewer_grant_role_invalid" };
  if (!grant.scopes.every((s) => s === REVIEWER_EVIDENCE_SCOPE)) {
    return { ok: false, reason: "reviewer_grant_scope_invalid" };
  }
  if (grant.principalId !== target.principalId) return { ok: false, reason: "reviewer_grant_principal_mismatch" };
  if (grant.workItemId !== target.workItemId) return { ok: false, reason: "reviewer_grant_work_item_mismatch" };
  if (grant.attemptId !== target.attemptId) return { ok: false, reason: "reviewer_grant_attempt_mismatch" };
  if (grant.workspaceId !== target.workspaceId) return { ok: false, reason: "reviewer_grant_workspace_mismatch" };
  if (grant.workspaceRevision !== target.workspaceRevision) {
    return { ok: false, reason: "reviewer_grant_workspace_revision_mismatch" };
  }
  if (grant.admittedPlanHash !== target.admittedPlanHash) {
    return { ok: false, reason: "reviewer_grant_admitted_plan_mismatch" };
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, reason: "reviewer_grant_expired" };
  }
  return { ok: true, grant };
}
