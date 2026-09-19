import { describe, expect, it } from "vitest";
import { assertCanTransition } from "@agent-control-stack/work-items";
import type { WorkItem } from "../api/types";
import { event, HASH_A, HASH_B, policyDecided } from "../test-fixtures";
import { approvalGate, canCancel, canClone, canReject, canRetry, canUnblock, requiredApprovals } from "./approvals";

const allows = (from: WorkItem["status"], to: WorkItem["status"]): boolean => {
  try {
    assertCanTransition(from, to);
    return true;
  } catch {
    return false;
  }
};
const STATUSES: WorkItem["status"][] = [
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
  "unknown",
  "quarantined"
];

describe("requiredApprovals", () => {
  it("reads action hashes from policy.decided events, never computing them", () => {
    const events = [
      policyDecided("wrk_1", HASH_A, "require_approval"),
      policyDecided("wrk_2", HASH_B, "require_approval")
    ];
    const approvals = requiredApprovals(events, "wrk_1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      actionHash: HASH_A,
      actionKind: "fs.write",
      reason: "high risk work requires approval",
      matchedRules: ["approval:risk"],
      granted: false,
      consumed: false
    });
  });

  it("returns one row per distinct hash so each is approved separately", () => {
    const approvals = requiredApprovals(
      [
        policyDecided("wrk_1", HASH_A, "require_approval"),
        policyDecided("wrk_1", HASH_B, "require_approval"),
        policyDecided("wrk_1", HASH_A, "require_approval")
      ],
      "wrk_1"
    );
    expect(approvals.map((a) => a.actionHash).sort()).toEqual([HASH_A, HASH_B]);
  });

  it("tracks granted and consumed approvals from the audit log", () => {
    const events = [
      policyDecided("wrk_1", HASH_A, "require_approval"),
      event("approval.granted", { "work_item.id": "wrk_1", "action.hash": HASH_A }, { actionHash: HASH_A }),
      policyDecided("wrk_1", HASH_B, "require_approval"),
      event("approval.granted", { "work_item.id": "wrk_1", "action.hash": HASH_B }, { actionHash: HASH_B }),
      event("approval.consumed", { "work_item.id": "wrk_1", "action.hash": HASH_B }, { actionHash: HASH_B })
    ];
    const byHash = Object.fromEntries(requiredApprovals(events, "wrk_1").map((a) => [a.actionHash, a]));
    expect(byHash[HASH_A]).toMatchObject({ granted: true, consumed: false });
    expect(byHash[HASH_B]).toMatchObject({ granted: true, consumed: true });
  });

  it("drops a hash whose latest evaluation no longer requires approval", () => {
    const events = [policyDecided("wrk_1", HASH_A, "require_approval"), policyDecided("wrk_1", HASH_A, "deny")];
    expect(requiredApprovals(events, "wrk_1")).toEqual([]);
  });

  it("ignores events for other work items and events with no hash", () => {
    expect(
      requiredApprovals(
        [event("policy.decided", { "work_item.id": "wrk_1", "policy.decision": "require_approval" })],
        "wrk_1"
      )
    ).toEqual([]);
    expect(requiredApprovals([policyDecided("wrk_9", HASH_A, "require_approval")], "wrk_1")).toEqual([]);
  });
});

describe("approvalGate (fail closed)", () => {
  const pending = requiredApprovals([policyDecided("wrk_1", HASH_A, "require_approval")], "wrk_1");

  it("is approvable only for needs_approval with a recorded hash and a trusted stream", () => {
    expect(approvalGate({ status: "needs_approval" }, pending, true).kind).toBe("approvable");
  });
  it("never offers approval for any other status", () => {
    for (const status of STATUSES.filter((s) => s !== "needs_approval")) {
      expect(approvalGate({ status }, pending, true).kind).toBe("not_pending");
    }
  });
  it("never offers approval when the stream is not trustworthy", () => {
    expect(approvalGate({ status: "needs_approval" }, pending, false).kind).toBe("stream_stale");
  });
  it("never offers approval without recorded hash evidence", () => {
    expect(approvalGate({ status: "needs_approval" }, [], true).kind).toBe("no_hash");
  });
  it("does not offer an already granted or consumed approval again", () => {
    const granted = [{ ...pending[0]!, granted: true }];
    expect(approvalGate({ status: "needs_approval" }, granted, true).kind).toBe("no_hash");
    const consumed = [{ ...pending[0]!, consumed: true }];
    expect(approvalGate({ status: "needs_approval" }, consumed, true).kind).toBe("no_hash");
  });
});

describe("action availability mirrors the ACS state machine", () => {
  it("reject: exactly the statuses that can move to rejected", () => {
    for (const status of STATUSES) expect(canReject({ status }), status).toBe(allows(status, "rejected"));
  });
  it("cancel: exactly the statuses that can move to cancelled (except the worker-owned 'cancelling')", () => {
    for (const status of STATUSES)
      expect(canCancel({ status }), status).toBe(allows(status, "cancelled") && status !== "cancelling");
  });
  it("unblock only from blocked; retry only from failed; clone from terminal states", () => {
    for (const status of STATUSES) {
      expect(canUnblock({ status })).toBe(status === "blocked");
      expect(canRetry({ status })).toBe(status === "failed");
      expect(canClone({ status })).toBe(["succeeded", "failed", "cancelled", "rejected"].includes(status));
    }
  });
});
