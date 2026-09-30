import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  approvalBundlePanel,
  approvalBundleReviewCard,
  approvalStrategyFieldset,
  type ApprovalBundleReview,
  type ApprovalBundleView
} from "./approval-bundles.js";
import { renderDashboard } from "./index.js";

/**
 * Mission Control approval bundle review.
 *
 * These assert the review surface a human actually needs: that a high-risk change is
 * spelled out rather than counted, that "previously approved" and "new since approval"
 * are separated, and that the client cannot approve something the operator unticked.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");

function change(overrides: Partial<ApprovalBundleView["changes"][number]> = {}) {
  return {
    id: "change-001",
    type: "file_write",
    summary: "Modify packages/gateway/src/router.ts",
    target: "packages/gateway/src/router.ts",
    risk: "medium" as const,
    destructive: false,
    network: false,
    dependsOn: [] as string[],
    actionHash: "a".repeat(64),
    actionKind: "fs.write",
    actionDescription: overrides.summary ?? "Modify packages/gateway/src/router.ts",
    actionParams: overrides.actionParams ?? { paths: overrides.paths ?? ["packages/gateway/src/router.ts"] },
    command: null,
    paths: ["packages/gateway/src/router.ts"],
    cwd: "/repo",
    ...overrides
  };
}

function bundle(overrides: Partial<ApprovalBundleView> = {}): ApprovalBundleView {
  return {
    bundleId: "A-184",
    missionId: "M-829",
    executionId: "EX-9012",
    agentId: "backend-api",
    title: "Fix Jace Commander OAuth lane routing",
    rationale: "Token refresh races the lane swap, so refreshes land on the wrong lane.",
    revision: 2,
    status: "modified",
    manifestHash: "b".repeat(64),
    parentManifestHash: "c".repeat(64),
    scope: { repos: ["agent-control-stack"] },
    baseState: {},
    createdAt: NOW.toISOString(),
    createdByActorId: "backend-api",
    changes: [change()],
    approvals: [
      {
        id: "decision-1",
        revision: 1,
        kind: "approve_all",
        approvedByActorId: "user",
        reason: "reviewed the first pass",
        changeIds: ["change-001"],
        manifestHash: "c".repeat(64),
        decidedAt: NOW.toISOString()
      }
    ],
    ...overrides
  };
}

function review(overrides: Partial<ApprovalBundleReview> = {}): ApprovalBundleReview {
  return {
    bundle: bundle(),
    delta: null,
    grants: [],
    ...overrides
  };
}

function domFor(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("approval bundle review card", () => {
  it("shows identity, risk, manifest and the requesting agent", () => {
    const card = approvalBundleReviewCard(review());
    expect(card).toContain("A-184");
    expect(card).toContain("Fix Jace Commander OAuth lane routing");
    expect(card).toContain("Revision 2");
    expect(card).toContain("backend-api");
    expect(card).toContain("M-829");
    expect(card).toContain("EX-9012");
    expect(card).toContain("bbbbbbbbbbbb");
    expect(card).toContain("Token refresh races the lane swap");
  });

  it("spells out files, services, commands and destructive work rather than hiding counts", () => {
    const card = approvalBundleReviewCard(
      review({
        bundle: bundle({
          changes: [
            change(),
            change({
              id: "change-002",
              type: "service_restart",
              summary: "Restart auth proxy",
              target: "auth-proxy",
              risk: "high"
            }),
            change({
              id: "change-003",
              type: "command",
              summary: "Run migration",
              target: "npm run migrate",
              command: ["npm", "run", "migrate"],
              risk: "critical",
              destructive: true
            })
          ]
        })
      })
    );
    expect(card).toContain("Restart auth proxy");
    expect(card).toContain("auth-proxy");
    expect(card).toContain("npm run migrate");
    expect(card).toContain("destructive");
    expect(card).toContain("Destructive");
    expect(card).toContain("Yes");
  });

  it("shows the exact operation inputs and warns when a pinned base state cannot be verified", () => {
    const html = approvalBundleReviewCard(
      review({ bundle: bundle({ baseState: { gitSha: "abc123" } }) })
    );
    expect(html).toContain("Exact operation: fs.write");
    expect(html).toContain("&quot;paths&quot;");
    expect(html).toContain("Approval is blocked because gateway execution cannot verify this pinned base state");
    expect(html).not.toContain('data-bundle-decision="approve_all"');
    expect(html).not.toContain('data-bundle-decision="approve_selected"');
  });

  it("separates previously approved from new since approval", () => {
    const carried = change({ id: "change-001" });
    const fresh = change({
      id: "change-900",
      summary: "Modify gateway.env",
      target: "config/gateway.env",
      risk: "high"
    });
    const html = approvalBundleReviewCard(
      review({
        bundle: bundle({ changes: [carried, fresh] }),
        delta: {
          fromRevision: 1,
          toRevision: 2,
          fromManifestHash: "c".repeat(64),
          toManifestHash: "b".repeat(64),
          unchanged: [
            {
              changeId: "change-001",
              digest: "d".repeat(64),
              classification: "unchanged",
              previousDigest: "d".repeat(64),
              change: carried
            }
          ],
          modified: [],
          added: [
            {
              changeId: "change-900",
              digest: "e".repeat(64),
              classification: "added",
              previousDigest: null,
              change: fresh
            }
          ],
          removed: [],
          requiresApproval: [
            {
              changeId: "change-900",
              digest: "e".repeat(64),
              classification: "added",
              previousDigest: null,
              change: fresh
            }
          ]
        }
      })
    );
    const document = domFor(html);
    const previously = [...document.querySelectorAll(".detail-section")].find(
      (section) => section.querySelector("h4")?.textContent === "Previously approved"
    );
    const next = [...document.querySelectorAll(".detail-section")].find(
      (section) => section.querySelector("h4")?.textContent === "New since approval"
    );
    expect(previously?.textContent).toContain("Modify packages/gateway/src/router.ts");
    expect(previously?.textContent).not.toContain("Modify gateway.env");
    expect(next?.textContent).toContain("Modify gateway.env");
    expect(next?.textContent).not.toContain("Modify packages/gateway/src/router.ts");
  });

  it("labels a modified change as changed since approval, not unchanged", () => {
    const edited = change({ id: "change-001", summary: "Modify router.ts and everything else", risk: "critical" });
    const html = approvalBundleReviewCard(
      review({
        delta: {
          fromRevision: 1,
          toRevision: 2,
          fromManifestHash: "c".repeat(64),
          toManifestHash: "b".repeat(64),
          unchanged: [],
          modified: [
            {
              changeId: "change-001",
              digest: "f".repeat(64),
              classification: "modified",
              previousDigest: "d".repeat(64),
              change: edited
            }
          ],
          added: [],
          removed: [],
          requiresApproval: [
            {
              changeId: "change-001",
              digest: "f".repeat(64),
              classification: "modified",
              previousDigest: "d".repeat(64),
              change: edited
            }
          ]
        }
      })
    );
    expect(html).toContain("changed since approval");
  });

  it("renders dependencies when a change has them", () => {
    const html = approvalBundleReviewCard(
      review({
        bundle: bundle({
          changes: [change(), change({ id: "change-002", dependsOn: ["change-001"] })]
        })
      })
    );
    expect(html).toContain("depends on change-001");
  });

  it("offers approve all, approve selected and reject with a required reason", () => {
    const html = approvalBundleReviewCard(review());
    const document = domFor(html);
    expect(document.querySelector('[data-bundle-decision="approve_all"]')).not.toBeNull();
    expect(document.querySelector('[data-bundle-decision="approve_selected"]')).not.toBeNull();
    expect(document.querySelector('[data-bundle-decision="reject"]')).not.toBeNull();
    const reason = document.querySelector("[data-bundle-reason]");
    expect(reason?.hasAttribute("required")).toBe(true);
  });

  it("gives every change a checkbox carrying its id and action hash", () => {
    const html = approvalBundleReviewCard(
      review({ bundle: bundle({ changes: [change(), change({ id: "change-002" })] }) })
    );
    const document = domFor(html);
    const boxes = [...document.querySelectorAll("[data-bundle-select]")];
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(boxes.every((box) => box.hasAttribute("checked"))).toBe(true);
    const hashes = [...document.querySelectorAll(".bundle-change")].map((node) =>
      node.getAttribute("data-action-hash")
    );
    expect(hashes).toContain("a".repeat(64));
  });

  it("shows the decision history with who approved which manifest", () => {
    const html = approvalBundleReviewCard(review());
    expect(html).toContain("approve_all");
    expect(html).toContain("user");
    expect(html).toContain("cccccccccc");
  });

  it("does not offer decisions once a bundle is decided", () => {
    const html = approvalBundleReviewCard(review({ bundle: bundle({ status: "approved" }) }));
    const document = domFor(html);
    expect(document.querySelector("[data-bundle-decision]")).toBeNull();
    expect(html).toContain("This change set is approved");
  });

  it("escapes untrusted titles, targets and rationales", () => {
    const html = approvalBundleReviewCard(
      review({
        bundle: bundle({
          title: '<img src=x onerror="alert(1)">',
          rationale: "</script><script>alert(2)</script>"
        })
      })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img");
  });
});

describe("approval strategy control", () => {
  it("renders the three strategies and marks the active one", () => {
    const html = approvalStrategyFieldset("BUNDLE");
    const document = domFor(html);
    const checked = document.querySelector("[data-approval-strategy]:checked");
    expect(checked?.getAttribute("value")).toBe("BUNDLE");
    const values = [...document.querySelectorAll("[data-approval-strategy]")].map((node) => node.getAttribute("value"));
    expect(values).toEqual(["PER_ACTION", "BUNDLE", "POLICY_AUTONOMOUS"]);
  });

  it("falls back to PER_ACTION when the strategy is unknown", () => {
    const document = domFor(approvalStrategyFieldset(undefined));
    expect(document.querySelector("[data-approval-strategy]:checked")?.getAttribute("value")).toBe("PER_ACTION");
  });

  it("states that policy autonomous is not allow-all", () => {
    expect(approvalStrategyFieldset("POLICY_AUTONOMOUS")).toContain("Never allow-all");
  });
});

describe("change set panel", () => {
  it("renders an empty state rather than failing", () => {
    const html = approvalBundlePanel([], "PER_ACTION");
    expect(html).toContain("No approval bundles are awaiting review");
  });

  it("sorts the highest-risk change set first", () => {
    const low = review({ bundle: bundle({ bundleId: "A-low", changes: [change({ risk: "low" })] }) });
    const critical = review({
      bundle: bundle({ bundleId: "A-critical", changes: [change({ risk: "critical" })] })
    });
    const html = approvalBundlePanel([low, critical], "BUNDLE");
    expect(html.indexOf("A-critical")).toBeLessThan(html.indexOf("A-low"));
  });

  it("is reachable from the dashboard and is labelled as a change set", () => {
    const html = renderDashboard({
      workItems: [],
      events: [],
      approvalBundles: [review()],
      approvalStrategy: "BUNDLE"
    } satisfies Parameters<typeof renderDashboard>[0]);
    expect(html).toContain('id="approval-bundles"');
    expect(html).toContain("Change sets");
    expect(html).toContain("A-184");
  });

  it("does not re-introduce bulk approval of arbitrary work items", () => {
    // The existing per-action UI deliberately has no bulk approve. Bundles must not
    // quietly add a way to approve work items outside a reviewed change set.
    const html = renderDashboard({ workItems: [], events: [], approvalBundles: [review()] } as never);
    expect(html).not.toContain("data-approve-all");
  });
});
