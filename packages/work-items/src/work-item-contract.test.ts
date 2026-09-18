import { describe, expect, it } from "vitest";
import { submitWorkResultSchema } from "./work-item.js";

describe("public work-result timestamp compatibility", () => {
  it("continues accepting RFC 3339 timestamps at minute precision", () => {
    const result = submitWorkResultSchema.safeParse({
      workItemId: "wrk_test",
      leaseId: "lease_test",
      workerId: "worker_test",
      actionHash: "a".repeat(64),
      idempotencyKey: "result_test",
      outcome: "succeeded",
      startedAt: "2026-09-09T18:36Z",
      finishedAt: "2026-09-09T18:37Z",
      exitCode: 0,
      summary: "minute-precision compatibility check",
      simulationMetadata: { executionMode: "dry_run", simulated: true }
    });

    expect(result.success).toBe(true);
  });
});
