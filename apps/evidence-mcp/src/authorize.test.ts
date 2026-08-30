import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueReviewerGrant, type ReviewerGrant } from "@agent-control-stack/advisory";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { authorizeReviewer } from "./authorize.js";

const via = { via: "domain_service" as const };
const H = (c: string) => c.repeat(64);

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let workItemId: string;
let workItem2Id: string;
let attempt1: string;
let attempt2: string;
let ws1: string;
let ws2: string;

function seedWorkItemWithAttempt(): { workItemId: string; attemptId: string; workspaceId: string } {
  const workItem = store.create({
    title: "reviewer auth fixture",
    requester: "user",
    intent: "prove attempt-scoped reviewer isolation",
    requestedActions: [{ kind: "fs.write", description: "edit" }],
    risk: "medium"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor_system_bootstrap"
  });
  const attemptId = store.createAttempt(
    { workItemId: workItem.id, planHash: plan.planHash, inputHash: H(workItem.id.slice(-1) || "1") },
    via
  ).attemptId;
  const hostPath = join(dir, `workspace-${attemptId}`);
  mkdirSync(hostPath, { recursive: true });
  const workspaceId = `workspace_${attemptId}`;
  // Work-item-scoped allocation (the legacy form needs no lease tuple); the
  // reviewer authorizer resolves attempt -> work-item allocation as a fallback.
  store.recordWorkspaceAllocation(
    { allocationId: workspaceId, workItemId: workItem.id, hostPath, branch: `acs/job/${workItem.id}`, baseRef: "HEAD" },
    via
  );
  return { workItemId: workItem.id, attemptId, workspaceId };
}

function persistGrant(grant: ReviewerGrant): void {
  store.issueReviewerGrant(
    {
      grantHash: grant.grantHash,
      grantId: grant.grantId,
      principalId: grant.principalId,
      workItemId: grant.workItemId,
      planId: grant.planId,
      admittedPlanHash: grant.admittedPlanHash,
      attemptId: grant.attemptId,
      workspaceId: grant.workspaceId,
      workspaceRevision: grant.workspaceRevision,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      grant: grant as unknown as Record<string, unknown>
    },
    via
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-emcp-authz-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  const a = seedWorkItemWithAttempt();
  const b = seedWorkItemWithAttempt();
  workItemId = a.workItemId;
  attempt1 = a.attemptId;
  ws1 = a.workspaceId;
  workItem2Id = b.workItemId;
  attempt2 = b.attemptId;
  ws2 = b.workspaceId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function grantForAttempt1(overrides: Partial<Parameters<typeof issueReviewerGrant>[0]> = {}): ReviewerGrant {
  return issueReviewerGrant({
    principalId: "claude-reviewer",
    workItemId,
    planId: "plan_1",
    admittedPlanHash: H("a"),
    attemptId: attempt1,
    workspaceId: ws1,
    workspaceRevision: H("d"),
    ...overrides
  });
}

describe("evidence-mcp reviewer authorization (proof 4 + TOCTOU)", () => {
  it("a valid grant for attempt 1 authorizes a reader bound to attempt 1's workspace", () => {
    const grant = grantForAttempt1();
    persistGrant(grant);
    const ctx = authorizeReviewer({ dbPath, grantJson: grant });
    expect(ctx.attemptId).toBe(attempt1);
    expect(ctx.workspaceHostPath).toContain(`workspace-${attempt1}`);
  });

  it("a grant for attempt 1 CANNOT be used to authorize attempt 2", () => {
    const grant = grantForAttempt1();
    persistGrant(grant);
    // Forge a grant object pointing at attempt 2 (hash no longer matches).
    const forged = { ...grant, attemptId: attempt2, workspaceId: ws2 };
    expect(() => authorizeReviewer({ dbPath, grantJson: forged })).toThrow(
      /does not match the presented grant|denied|tampered|was not issued/
    );

    // Even a correctly-signed grant for attempt 2 that was never issued fails.
    const unissued = issueReviewerGrant({
      principalId: "claude-reviewer",
      workItemId: workItem2Id,
      planId: "plan_1",
      admittedPlanHash: H("a"),
      attemptId: attempt2,
      workspaceId: ws2,
      workspaceRevision: H("d")
    });
    expect(() => authorizeReviewer({ dbPath, grantJson: unissued })).toThrow(/was not issued by ACS/);
  });

  it("a stale workspace revision (drift) fails closed when enforced", () => {
    const grant = grantForAttempt1();
    persistGrant(grant);
    expect(() =>
      authorizeReviewer({ dbPath, grantJson: grant, liveWorkspaceRevision: H("9") })
    ).toThrow(/reviewer_grant_workspace_revision_mismatch|reviewer_grant_denied/);
  });

  it("an expired grant fails closed", () => {
    const grant = grantForAttempt1({ ttlMs: 1, now: new Date(Date.now() - 60_000) });
    persistGrant(grant);
    expect(() => authorizeReviewer({ dbPath, grantJson: grant })).toThrow(/reviewer_grant_expired|reviewer_grant_denied/);
  });

  it("a grant with a non-evidence scope is rejected", () => {
    const grant = grantForAttempt1();
    persistGrant(grant);
    const widened = { ...grant, scopes: ["acs:work:approve"] };
    expect(() => authorizeReviewer({ dbPath, grantJson: widened })).toThrow();
  });
});
