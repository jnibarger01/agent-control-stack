import { describe, expect, it } from "vitest";
import { ExecutionAdmissionScheduler } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("execution admission load acceptance", () => {
  it("bounds 24 simultaneous JC calls, preserves fairness, and leaks no permits", async () => {
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 4,
        executorMaxInflight: 1,
        queueMax: 32,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const actors = ["a", "b", "c", "d"] as const;
    const admitted: string[] = [];
    let peakAdmissionConcurrency = 0;
    let peakExecutorConcurrency = 0;
    let rejectedRequests = 0;

    const calls = Array.from({ length: 24 }, (_, index) => {
      const requestId = `jc-${index}`;
      const actorId = actors[index % actors.length]!;
      return scheduler
        .acquire({
          requestId,
          lane: "jc",
          executorId: "acs-jc-bridge",
          actorId,
          toolName: "read_file",
          executionClass: "execution",
          enqueuedAt: Date.now(),
          deadlineAt: Date.now() + 30_000,
          signal: new AbortController().signal
        })
        .then(async (permit) => {
          admitted.push(requestId);
          const status = scheduler.snapshot();
          peakAdmissionConcurrency = Math.max(peakAdmissionConcurrency, status.global.active);
          peakExecutorConcurrency = Math.max(peakExecutorConcurrency, status.lanes.jc.active);
          await sleep(2);
          permit.release();
        })
        .catch((error: unknown) => {
          rejectedRequests += 1;
          throw error;
        });
    });

    const maxQueueDepth = scheduler.snapshot().global.queued;
    await Promise.all(calls);
    const final = scheduler.snapshot();

    expect(peakAdmissionConcurrency).toBeLessThanOrEqual(4);
    expect(peakExecutorConcurrency).toBeLessThanOrEqual(1);
    expect(maxQueueDepth).toBeGreaterThanOrEqual(20);
    expect(maxQueueDepth).toBeLessThanOrEqual(32);
    expect(rejectedRequests).toBe(0);
    expect(final.global).toMatchObject({ active: 0, queued: 0 });
    expect(new Set(admitted.slice(0, 8).map((id) => actors[Number(id.slice(3)) % actors.length]))).toEqual(
      new Set(actors)
    );

    console.log(
      "EXECUTION_ADMISSION_LOAD_RESULT",
      JSON.stringify({
        inboundCalls: 24,
        peakAdmissionConcurrency,
        peakExecutorConcurrency,
        maxQueueDepth,
        rejectedRequests,
        admissionP95Ms: final.admissionP95Ms,
        serviceP95Ms: final.serviceP95Ms,
        permitLeaks: final.global.active
      })
    );
  });
});
