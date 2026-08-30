import {
  REVIEWER_EVIDENCE_SCOPE,
  checkReviewerGrant,
  reviewerGrantSchema,
  type ReviewerGrant
} from "@agent-control-stack/advisory";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

/**
 * Verify a `ReviewerGrant` against ACS-owned state and bind an evidence reader
 * to exactly one attempt + workspace revision. A grant for attempt N does not
 * authorize attempt N+1, a stale workspace revision, or an expired/revoked
 * grant. The only scope a grant may carry is `acs:evidence:read`.
 */
export interface AuthorizedReviewerContext {
  grant: ReviewerGrant;
  workItemId: string;
  attemptId: string;
  workspaceHostPath: string;
  workspaceRevision: string;
}

export function authorizeReviewer(input: {
  dbPath: string;
  grantJson: unknown;
  /** Optional: recompute the live workspace revision and require it to match. */
  liveWorkspaceRevision?: string;
  now?: Date;
}): AuthorizedReviewerContext {
  const grant = reviewerGrantSchema.parse(input.grantJson);
  if (!grant.scopes.every((s) => s === REVIEWER_EVIDENCE_SCOPE)) {
    throw new ControlStackError("reviewer_grant_scope_invalid", "reviewer grant carries a non-evidence scope");
  }

  const store = new SqliteWorkItemStore(input.dbPath);
  try {
    const persisted = store.getReviewerGrant(grant.grantHash);
    if (!persisted) {
      throw new ControlStackError("reviewer_grant_unknown", "reviewer grant was not issued by ACS");
    }
    if (persisted.status === "revoked" || persisted.status === "expired") {
      throw new ControlStackError("reviewer_grant_inactive", `reviewer grant is ${persisted.status}`);
    }
    if (persisted.attemptId !== grant.attemptId || persisted.workspaceRevision !== grant.workspaceRevision) {
      throw new ControlStackError("reviewer_grant_binding_mismatch", "persisted grant does not match the presented grant");
    }

    const check = checkReviewerGrant(
      grant,
      {
        principalId: grant.principalId,
        workItemId: grant.workItemId,
        attemptId: grant.attemptId,
        workspaceId: grant.workspaceId,
        workspaceRevision: input.liveWorkspaceRevision ?? grant.workspaceRevision,
        admittedPlanHash: grant.admittedPlanHash
      },
      input.now ?? new Date()
    );
    if (!check.ok) {
      throw new ControlStackError("reviewer_grant_denied", check.reason);
    }

    const allocation =
      store.getActiveWorkspaceAllocationForAttempt(grant.attemptId) ??
      store.getActiveWorkspaceAllocationForWorkItem(grant.workItemId);
    if (!allocation) {
      throw new ControlStackError("reviewer_grant_workspace_missing", "no active workspace allocation for the attempt");
    }

    return {
      grant,
      workItemId: grant.workItemId,
      attemptId: grant.attemptId,
      workspaceHostPath: allocation.hostPath,
      workspaceRevision: grant.workspaceRevision
    };
  } finally {
    store.close();
  }
}
