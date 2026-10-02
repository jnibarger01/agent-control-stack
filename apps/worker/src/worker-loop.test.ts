import { describe, expect, it, vi } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import { runWorkerLoop, workerPollIntervalMsFromEnv } from "./worker-loop.js";

describe("authenticated worker polling loop", () => {
  it("validates a bounded polling interval", () => {
    expect(workerPollIntervalMsFromEnv({})).toBe(5_000);
    expect(workerPollIntervalMsFromEnv({ ACS_WORKER_POLL_INTERVAL_MS: "1250" })).toBe(1_250);
    expect(() => workerPollIntervalMsFromEnv({ ACS_WORKER_POLL_INTERVAL_MS: "99" })).toThrow(
      "ACS_WORKER_POLL_INTERVAL_MS must be between 250 and 60000"
    );
  });

  it("waits while idle, backs off claim outages, and resumes after a successful execution", async () => {
    const shutdown = new AbortController();
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ executed: false, reason: "no approved work item" })
      .mockRejectedValueOnce(new ControlStackError("worker_claim_unavailable", "gateway unavailable"))
      .mockResolvedValueOnce({ executed: true, workItemId: "work-1" });
    const waits: number[] = [];
    const failures: Array<{ code: string; retryInMs: number }> = [];
    const onResult = vi.fn((result) => {
      if (result.executed) shutdown.abort();
    });

    await runWorkerLoop({
      workerOptions: { workerId: "worker-1" },
      pollIntervalMs: 1_000,
      signal: shutdown.signal,
      runOnce,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      onResult,
      onTransientFailure: (code, retryInMs) => failures.push({ code, retryInMs })
    });

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1_000, 1_000]);
    expect(failures).toEqual([{ code: "worker_claim_unavailable", retryInMs: 1_000 }]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed claim authority", async () => {
    const runOnce = vi.fn(async () => {
      throw new ControlStackError("worker_claim_integrity_mismatch", "claim did not match persisted authority");
    });
    const wait = vi.fn(async () => undefined);
    await expect(
      runWorkerLoop({
        workerOptions: { workerId: "worker-1" },
        pollIntervalMs: 1_000,
        signal: new AbortController().signal,
        runOnce,
        wait
      })
    ).rejects.toMatchObject({ code: "worker_claim_integrity_mismatch" });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
