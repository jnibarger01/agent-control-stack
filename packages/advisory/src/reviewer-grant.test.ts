import { describe, expect, it } from "vitest";
import {
  REVIEWER_EVIDENCE_SCOPE,
  checkReviewerGrant,
  issueReviewerGrant,
  reviewerGrantHash,
  type ReviewerGrantTarget
} from "./reviewer-grant.js";

const H = (c: string) => c.repeat(64);
const now = new Date("2026-08-30T00:00:00.000Z");

function grantFor(attemptId: string, workspaceRevision = H("d")) {
  return issueReviewerGrant({
    principalId: "claude-reviewer",
    workItemId: "wrk_1",
    planId: "plan_1",
    admittedPlanHash: H("a"),
    attemptId,
    workspaceId: "workspace_1",
    workspaceRevision,
    now
  });
}

const target = (over: Partial<ReviewerGrantTarget> = {}): ReviewerGrantTarget => ({
  principalId: "claude-reviewer",
  workItemId: "wrk_1",
  attemptId: "attempt_1",
  workspaceId: "workspace_1",
  workspaceRevision: H("d"),
  admittedPlanHash: H("a"),
  ...over
});

describe("ReviewerGrant", () => {
  it("carries only the acs:evidence:read scope", () => {
    const grant = grantFor("attempt_1");
    expect(grant.scopes).toEqual([REVIEWER_EVIDENCE_SCOPE]);
    expect(grant.principalRole).toBe("ADVISORY_REASONER");
  });

  it("a grant for attempt N does NOT authorize attempt N+1", () => {
    const grant = grantFor("attempt_1");
    expect(checkReviewerGrant(grant, target({ attemptId: "attempt_1" }), now).ok).toBe(true);
    const next = checkReviewerGrant(grant, target({ attemptId: "attempt_2" }), now);
    expect(next.ok).toBe(false);
    expect(next.ok === false && next.reason).toBe("reviewer_grant_attempt_mismatch");
  });

  it("a changed workspace revision invalidates the grant", () => {
    const grant = grantFor("attempt_1", H("d"));
    const drifted = checkReviewerGrant(grant, target({ workspaceRevision: H("e") }), now);
    expect(drifted.ok).toBe(false);
    expect(drifted.ok === false && drifted.reason).toBe("reviewer_grant_workspace_revision_mismatch");
  });

  it("a changed admitted plan invalidates the grant", () => {
    const grant = grantFor("attempt_1");
    const r = checkReviewerGrant(grant, target({ admittedPlanHash: H("f") }), now);
    expect(r.ok === false && r.reason).toBe("reviewer_grant_admitted_plan_mismatch");
  });

  it("principal mismatch, expiry, and tampering all fail closed", () => {
    const grant = grantFor("attempt_1");
    expect(checkReviewerGrant(grant, target({ principalId: "someone-else" }), now).ok).toBe(false);

    const later = new Date(now.getTime() + 10 * 60 * 60 * 1000);
    const expired = checkReviewerGrant(grant, target(), later);
    expect(expired.ok === false && expired.reason).toBe("reviewer_grant_expired");

    const tampered = { ...grant, workItemId: "wrk_evil" };
    const t = checkReviewerGrant(tampered, target({ workItemId: "wrk_evil" }), now);
    expect(t.ok === false && t.reason).toBe("reviewer_grant_tampered");
  });

  it("hash covers every field except the hash", () => {
    const grant = grantFor("attempt_1");
    const { grantHash: stored, ...rest } = grant;
    expect(reviewerGrantHash(rest)).toBe(stored);
  });
});
