import { describe, expect, it } from "vitest";
import { ingestReport, resumeCheckpointedUnit, runClaimedUnit } from "./runner.js";
import { FakeWorker, claimUnit, setup, token } from "./test-support.js";
import { ControlStackError } from "@agent-control-stack/shared";

const unit = (store: ReturnType<typeof setup>["store"], id = "u1") =>
  store.workUnits("m1").find((entry) => entry.unitId === id)!;

describe("runClaimedUnit: claim binding", () => {
  it("refuses a worker that does not hold the claim, before prepare runs", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker("w2");
    const result = await runClaimedUnit(deps, worker, {
      missionId: "m1",
      unitId: "u1",
      claim: { workerId: "w2", claimToken: claim.claimToken }
    });
    expect(result).toEqual({ ran: false, reason: "claim_mismatch" });
    expect(worker.calls).toEqual([]);
  });

  it("refuses a stale or forged token and a mismatched worker identity", async () => {
    const { store, deps } = setup();
    claimUnit(store);
    const worker = new FakeWorker("w1");
    expect(
      await runClaimedUnit(deps, worker, {
        missionId: "m1",
        unitId: "u1",
        claim: { workerId: "w1", claimToken: "forged" }
      })
    ).toEqual({
      ran: false,
      reason: "claim_mismatch"
    });
    const real = unit(store).claimToken!;
    const impostor = new FakeWorker("w9");
    expect(
      await runClaimedUnit(deps, impostor, {
        missionId: "m1",
        unitId: "u1",
        claim: { workerId: "w1", claimToken: real }
      })
    ).toEqual({
      ran: false,
      reason: "worker_mismatch"
    });
    expect(worker.calls).toEqual([]);
    expect(impostor.calls).toEqual([]);
  });

  it("refuses a unit kind the worker does not support", async () => {
    const { store, deps } = setup({ units: [{ unitId: "u1", kind: "shell", title: "s", payload: { argv: ["ls"] } }] });
    const claim = claimUnit(store);
    const worker = new FakeWorker("w1");
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toEqual({
      ran: false,
      reason: "kind_unsupported"
    });
    expect(worker.calls).toEqual([]);
  });

  it("does not run for a cancelled mission or an unclaimed unit", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    store.cancelMission("m1", { reason: "stop", now: "2026-10-06T00:00:01.000Z" });
    const worker = new FakeWorker();
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toEqual({
      ran: false,
      reason: "mission_not_active"
    });
    expect(worker.calls).toEqual([]);
  });

  it("stops before execute when the mission is cancelled while preparing", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker();
    const prepare = worker.prepare.bind(worker);
    worker.prepare = async (ctx) => {
      const prepared = await prepare(ctx);
      store.cancelMission("m1", { reason: "stop", now: "2026-10-06T00:00:01.000Z" });
      return prepared;
    };
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toEqual({
      ran: false,
      reason: "mission_not_active"
    });
    expect(worker.calls).toEqual(["prepare"]);
  });
});

describe("runClaimedUnit: outcomes", () => {
  it("completes a unit with no verification requirement", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const result = await runClaimedUnit(deps, new FakeWorker(), { missionId: "m1", unitId: "u1", claim });
    expect(result).toMatchObject({ ran: true, ingest: { applied: "completed" } });
    expect(unit(store)).toMatchObject({ status: "succeeded", resultHash: "h", files: ["a.ts"] });
  });

  it("never lets a worker's own 'done' complete a unit that needs independent verification", async () => {
    for (const policy of ["lightweight", "independent", "multi_verifier", "release_gate"] as const) {
      const { store, deps } = setup({ policy });
      const claim = claimUnit(store);
      const result = await runClaimedUnit(deps, new FakeWorker(), { missionId: "m1", unitId: "u1", claim });
      expect(result).toMatchObject({ ran: true, ingest: { applied: "awaiting_verification" } });
      expect(unit(store).status).toBe("verifying");
      expect(unit(store).status).not.toBe("succeeded");
      expect(store.events("m1").map((event) => event.name)).toContain("verification.started");
    }
  });

  it("treats a success report with no result as invalid output", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker("w1", async () => ({ outcome: "succeeded" }));
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "failed" }
    });
    expect(unit(store)).toMatchObject({ status: "failed", failureCategory: "invalid_output" });
  });

  it("parks a retry-safe failure as retryable and a side-effecting one as failed", async () => {
    const safe = setup();
    const worker = new FakeWorker("w1", async () => ({
      outcome: "failed",
      failure: { category: "worker_unavailable", retrySafe: true }
    }));
    expect(
      await runClaimedUnit(safe.deps, worker, { missionId: "m1", unitId: "u1", claim: claimUnit(safe.store) })
    ).toMatchObject({
      ingest: { applied: "retryable" }
    });
    expect(safe.store.retryUnit("m1", "u1", "2026-10-06T00:00:02.000Z")).toMatchObject({ ok: true });

    const unsafe = setup();
    const risky = new FakeWorker("w1", async () => ({
      outcome: "failed",
      failure: { category: "tool_failure", retrySafe: false }
    }));
    expect(
      await runClaimedUnit(unsafe.deps, risky, { missionId: "m1", unitId: "u1", claim: claimUnit(unsafe.store) })
    ).toMatchObject({
      ingest: { applied: "failed" }
    });

    // Even a worker that says retry-safe is overruled when it admits external state may have changed.
    const uncertain = setup();
    const lying = new FakeWorker("w1", async () => ({
      outcome: "failed",
      externalStateUncertain: true,
      failure: { category: "timeout", retrySafe: true }
    }));
    expect(
      await runClaimedUnit(uncertain.deps, lying, { missionId: "m1", unitId: "u1", claim: claimUnit(uncertain.store) })
    ).toMatchObject({
      ingest: { applied: "failed" }
    });
  });

  it("fails before execute, retry-safe only when nothing started, when prepare is refused", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker();
    worker.prepareError = new ControlStackError("policy_denied_lease", "lease mismatch");
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "failed" }
    });
    expect(worker.calls).toEqual(["prepare"]);
    expect(unit(store)).toMatchObject({ status: "failed", failureCategory: "policy_denied" });
    expect(store.retryUnit("m1", "u1", "2026-10-06T00:00:02.000Z")).toEqual({ ok: false, outcome: "not_retryable" });
  });

  it("never marks an execute-time throw retryable, because it may have started", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker();
    worker.executeError = new Error("ECONNREFUSED while starting");
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "failed" }
    });
    expect(unit(store).status).toBe("failed");
  });

  it("fails closed to `unknown` when the worker cannot account for what it did, and refuses to retry it", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker();
    worker.reportError = new Error("report channel died");
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "marked_unknown" }
    });
    expect(unit(store).status).toBe("unknown");
    expect(store.retryUnit("m1", "u1", "2026-10-06T00:00:02.000Z")).toEqual({ ok: false, outcome: "retry_unsafe" });
  });

  it("marks an explicit `unknown` outcome unknown and stores the report as evidence", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker("w1", async () => ({ outcome: "unknown", externalStateUncertain: true }));
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "marked_unknown" }
    });
    expect(store.evidence("m1", "execution_report:u1:1")).toBeDefined();
  });
});

describe("report ingestion fencing", () => {
  it("rejects a stale worker's success after the unit was cancelled, and records the rejection as evidence", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker("w1", async () => {
      store.cancelMission("m1", { reason: "operator", now: "2026-10-06T00:00:05.000Z" });
      return { outcome: "succeeded", result: { resultHash: "late", files: [], filesReported: true } };
    });
    const result = await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim });
    expect(result).toMatchObject({ ran: true, ingest: { applied: "rejected_stale" } });
    expect(unit(store)).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
    expect(unit(store).resultHash).toBeUndefined();
    expect(store.evidence("m1", "rejected_stale:u1")).toBeDefined();
  });

  it("rejects a report whose claim hash does not match the live handle", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker();
    const handle = await worker.execute(
      await worker.prepare({
        missionId: "m1",
        unitId: "u1",
        kind: "coding",
        attempt: 1,
        claim,
        authority: {},
        now: "t"
      }),
      new AbortController().signal
    );
    const report = await worker.report(handle);
    const forged = { ...report, claim: { ...report.claim, claimTokenHash: "0".repeat(64) } };
    expect(ingestReport(deps, handle, forged)).toMatchObject({ applied: "rejected_invalid" });
    expect(unit(store).status).toBe("running");
  });

  it("rejects a report from a superseded attempt after the unit was retried and re-claimed", async () => {
    const { store, deps } = setup({ budget: { maxRetriesPerWorkUnit: 3 } });
    const first = claimUnit(store);
    const slow = new FakeWorker("w1", async () => ({
      outcome: "succeeded",
      result: { resultHash: "old", files: [], filesReported: true }
    }));
    const handle = await slow.execute(
      await slow.prepare({
        missionId: "m1",
        unitId: "u1",
        kind: "coding",
        attempt: 1,
        claim: first,
        authority: {},
        now: "t"
      }),
      new AbortController().signal
    );
    store.failUnit("m1", "u1", first.claimToken, {
      category: "timeout",
      retryable: true,
      now: "2026-10-06T00:00:01.000Z"
    });
    store.retryUnit("m1", "u1", "2026-10-06T00:00:02.000Z");
    claimUnit(store, "u1", "w2");
    expect(ingestReport(deps, handle, await slow.report(handle))).toMatchObject({ applied: "rejected_stale" });
    expect(unit(store)).toMatchObject({ status: "running", workerId: "w2" });
  });

  it("never persists the claim token in report evidence", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    await runClaimedUnit(deps, new FakeWorker(), { missionId: "m1", unitId: "u1", claim });
    const rows = store.db.prepare("SELECT payload_json FROM coding_evidence").all() as Array<{ payload_json: string }>;
    for (const row of rows) expect(row.payload_json).not.toContain(claim.claimToken);
    const events = JSON.stringify(store.events("m1"));
    expect(events).not.toContain(claim.claimToken);
  });
});

describe("cancellation", () => {
  it("propagates an abort to the worker's cancel and reports the unit cancelled", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const controller = new AbortController();
    const worker = new FakeWorker("w1", async (_ctx, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return { outcome: "cancelled", externalStateUncertain: true };
    });
    const running = runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.cancelMission("m1", { reason: "operator", now: "2026-10-06T00:00:03.000Z" });
    controller.abort();
    expect(await running).toMatchObject({ ran: true, ingest: { applied: "cancelled" } });
    expect(worker.calls).toContain("cancel");
    expect(worker.cancelled).toEqual({ code: "mission_cancelled" });
    expect(unit(store)).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
  });
});

describe("checkpoint and resume", () => {
  const checkpointing = (id = "cp-1") =>
    new FakeWorker("w1", async () => ({
      outcome: "checkpointed",
      checkpoint: {
        checkpointId: id,
        stateRef: "state-hash",
        completedActions: ["step-1"],
        resumeHint: "continue at step 2",
        externalStateMayHaveChanged: true
      }
    }));

  it("records a checkpoint and parks the unit as checkpointed", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    expect(await runClaimedUnit(deps, checkpointing(), { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "checkpointed" }
    });
    expect(unit(store).status).toBe("checkpointed");
    expect(store.latestCheckpoint("m1", "u1")).toMatchObject({
      checkpointId: "cp-1",
      stateRef: "state-hash",
      attempt: 1
    });
  });

  it("rejects a checkpointed report that carries no checkpoint", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const worker = new FakeWorker("w1", async () => ({ outcome: "checkpointed" }));
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "rejected_invalid" }
    });
    expect(unit(store).status).toBe("running");
  });

  it("resumes on a different worker with a fresh fence, telling it to re-observe before acting", async () => {
    const { store, deps } = setup();
    const first = claimUnit(store);
    await runClaimedUnit(deps, checkpointing(), { missionId: "m1", unitId: "u1", claim: first });
    const second = new FakeWorker("w2");
    second.supportsResume = true;
    const newClaim = { workerId: "w2", claimToken: token() };
    const result = await resumeCheckpointedUnit(deps, second, {
      missionId: "m1",
      unitId: "u1",
      claim: newClaim,
      route: { workerId: "w2" }
    });
    expect(result).toMatchObject({ ran: true, ingest: { applied: "completed" } });
    expect(second.resumeContext).toMatchObject({ reobserveBeforeActing: true, attempt: 2 });
    expect(unit(store)).toMatchObject({ status: "succeeded", workerId: "w2", attempt: 2 });
    // The first worker's fence is dead.
    expect(() => store.completeOperation("m1", "u1", first.claimToken, { resultHash: "x", files: [] })).toThrow();
  });

  it("will not resume on a worker with no resume support, a unit with no checkpoint, or past the retry cap", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    await runClaimedUnit(deps, checkpointing(), { missionId: "m1", unitId: "u1", claim });
    const noResume = new FakeWorker("w2");
    expect(
      await resumeCheckpointedUnit(deps, noResume, {
        missionId: "m1",
        unitId: "u1",
        claim: { workerId: "w2", claimToken: token() },
        route: {}
      })
    ).toEqual({
      ran: false,
      reason: "resume_unsupported"
    });
    expect(unit(store).status).toBe("checkpointed");

    const capped = setup({ budget: { maxRetriesPerWorkUnit: 0 } });
    const c = claimUnit(capped.store);
    await runClaimedUnit(capped.deps, checkpointing(), { missionId: "m1", unitId: "u1", claim: c });
    const worker = new FakeWorker("w2");
    worker.supportsResume = true;
    expect(
      await resumeCheckpointedUnit(capped.deps, worker, {
        missionId: "m1",
        unitId: "u1",
        claim: { workerId: "w2", claimToken: token() },
        route: {}
      })
    ).toEqual({
      ran: false,
      reason: "budget_exhausted"
    });
    expect(worker.calls).toEqual([]);

    const fresh = setup();
    claimUnit(fresh.store);
    const w = new FakeWorker("w2");
    w.supportsResume = true;
    expect(
      await resumeCheckpointedUnit(fresh.deps, w, {
        missionId: "m1",
        unitId: "u1",
        claim: { workerId: "w2", claimToken: token() },
        route: {}
      })
    ).toEqual({
      ran: false,
      reason: "not_resumable"
    });
  });

  it("only the current claim can checkpoint", () => {
    const { store } = setup();
    claimUnit(store);
    expect(() =>
      store.checkpointUnit("m1", "u1", "wrong", { checkpointId: "c", stateRef: "s", completedActions: [] }, "t")
    ).toThrow(expect.objectContaining({ code: "coding_mission_claim_conflict" }));
  });
});
