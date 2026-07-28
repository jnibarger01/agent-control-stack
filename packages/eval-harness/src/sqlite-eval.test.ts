import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkItemEvent } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { runDeterministicSqliteEvaluation } from "./index.js";

describe("deterministic SQLite evaluation", () => {
  it("proves the dry lifecycle, semantic equivalence, and copied-row tamper detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-sqlite-eval-"));

    try {
      const result = runDeterministicSqliteEvaluation(dir);

      expect(result.verdict).toBe("PASS");
      expect(result.runs).toHaveLength(2);
      expect(result.runs.map((run) => run.chainVerification.ok)).toEqual([true, true]);
      expect(result.runs.map((run) => run.finalProjection.status)).toEqual(["succeeded", "succeeded"]);
      expect(result.runs.map((run) => run.eventNames)).toEqual([
        [
          WorkItemEvent.Created,
          "policy.decided",
          WorkItemEvent.NeedsApproval,
          "policy.decided",
          "approval.granted",
          "execution_plan.created",
          "execution_plan_approval.granted",
          WorkItemEvent.Approved,
          "policy.decided",
          "execution_plan.admitted",
          "execution_attempt.created",
          "attempt_lease.issued",
          WorkItemEvent.Running,
          "approval.consumed",
          "execution_result.accepted",
          WorkItemEvent.Succeeded,
          "execution_attempt.result_accepted"
        ],
        [
          WorkItemEvent.Created,
          "policy.decided",
          WorkItemEvent.NeedsApproval,
          "policy.decided",
          "approval.granted",
          "execution_plan.created",
          "execution_plan_approval.granted",
          WorkItemEvent.Approved,
          "policy.decided",
          "execution_plan.admitted",
          "execution_attempt.created",
          "attempt_lease.issued",
          WorkItemEvent.Running,
          "approval.consumed",
          "execution_result.accepted",
          WorkItemEvent.Succeeded,
          "execution_attempt.result_accepted"
        ]
      ]);
      expect(result.runs[0]?.semanticDigest).toBe(result.runs[1]?.semanticDigest);
      expect(result.tamperDetection).toEqual({
        ok: true,
        sequence: 2,
        reason: "event_hash_mismatch"
      });
      expect(existsSync(result.tamperedDatabasePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(existsSync(dir)).toBe(false);
  });
});
