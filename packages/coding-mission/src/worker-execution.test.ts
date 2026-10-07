import { stableHash } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import type { CodingMissionPorts } from "./controller.js";
import { CodingMissionStore } from "./store.js";
import {
  CoderExecutionAdapter,
  ToolLaneExecutionAdapter,
  WorkUnitExecutionLedger,
  failureCategoryForCode,
  type DispatchEnvelope,
  type ExecutorLane,
  type ResultEnvelope
} from "./worker-execution.js";
import type { VerificationPolicy, WorkUnitKind, WorkUnitPayload } from "./mission-model.js";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:00:01.000Z";
const T2 = "2026-10-06T00:00:02.000Z";

function claimed(options: {
  kind?: WorkUnitKind;
  payload?: WorkUnitPayload;
  verificationPolicy?: VerificationPolicy;
  lane?: ExecutorLane;
} = {}) {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
  store.addWorkUnits(
    "m1",
    [
      {
        unitId: "u1",
        kind: options.kind ?? "coding",
        title: "unit",
        ...(options.payload ? { payload: options.payload } : {}),
        verificationPolicy: options.verificationPolicy ?? "none"
      }
    ],
    T0
  );
  if ((options.verificationPolicy ?? "none") !== "none") {
    store.setVerificationRequirement(
      "m1",
      "u1",
      [{ id: "result", description: "result is durable", expected: "a result hash is present" }],
      T0
    );
  }
  store.releaseReadyUnits("m1", T0);
  const claim = { token: "claim-super-secret", workerId: "worker-1", route: { lane: options.lane ?? "coder", implementerEngineId: "codex" }, claimedAt: T1 };
  expect(store.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true, attempt: 1 });
  const ledger = new WorkUnitExecutionLedger(store);
  const dispatch = ledger.beginDispatch({
    missionId: "m1",
    unitId: "u1",
    claimToken: claim.token,
    workerId: claim.workerId,
    lane: options.lane ?? "coder",
    authority: { leaseId: "lease-1", fencingToken: 7, actionHash: "a".repeat(64) },
    now: T1
  });
  return { store, ledger, dispatch, claim };
}

function success(dispatch: DispatchEnvelope, resultHash = "result-1"): ResultEnvelope {
  return {
    schemaVersion: "acs.work-unit-result.v1",
    attemptId: dispatch.attemptId,
    missionId: dispatch.missionId,
    unitId: dispatch.unitId,
    unitAttempt: dispatch.unitAttempt,
    workerId: dispatch.workerId,
    lane: dispatch.lane,
    claimTokenHash: dispatch.claimTokenHash,
    outcome: "succeeded",
    startedAt: dispatch.issuedAt,
    finishedAt: T2,
    receipts: [{ kind: "tool_result", hash: "receipt-1" }],
    result: { resultHash, files: ["a.ts"] },
    externalStateUncertain: false
  };
}

describe("work-unit execution ledger", () => {
  it("persists durable attempt identity without persisting the raw claim token", () => {
    const { store, ledger, dispatch, claim } = claimed();
    const row = store.db
      .prepare(
        "SELECT claim_token_hash, dispatch_json, state FROM work_unit_execution_attempts WHERE attempt_id = ?"
      )
      .get(dispatch.attemptId) as { claim_token_hash: string; dispatch_json: string; state: string };
    expect(row.claim_token_hash).toBe(stableHash(claim.token));
    expect(row.dispatch_json).not.toContain(claim.token);
    expect(row.state).toBe("started");
    expect(ledger.attempt(dispatch.attemptId)).toMatchObject({
      missionId: "m1",
      unitId: "u1",
      unitAttempt: 1,
      workerId: "worker-1",
      implementerEngineId: "codex",
      lane: "coder",
      state: "started"
    });
  });

  it("applies a successful report under the live fence and persists receipts", () => {
    const { store, ledger, dispatch, claim } = claimed();
    expect(ledger.applyResult({ claimToken: claim.token, result: success(dispatch) })).toEqual({
      applied: "completed"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "succeeded",
      resultHash: "result-1",
      files: ["a.ts"]
    });
    expect(ledger.attempt(dispatch.attemptId)).toMatchObject({
      state: "succeeded",
      resultHash: "result-1",
      receipts: [{ kind: "tool_result", hash: "receipt-1" }]
    });
  });

  it("moves a successful unit to verifying instead of trusting worker self-completion", () => {
    const { store, ledger, dispatch, claim } = claimed({ verificationPolicy: "independent" });
    expect(ledger.applyResult({ claimToken: claim.token, result: success(dispatch) })).toEqual({
      applied: "awaiting_verification"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "verifying", resultHash: "result-1" });
    expect(store.events("m1").map((event) => event.name)).toContain("verification.started");
  });

  it("requires an implementer engine identity before verified dispatch", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m-engine", summary: "execute", now: T0 });
    store.addWorkUnits(
      "m-engine",
      [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: "independent" }],
      T0
    );
    store.setVerificationRequirement(
      "m-engine",
      "u1",
      [{ id: "result", description: "result is durable", expected: "a result hash is present" }],
      T0
    );
    store.releaseReadyUnits("m-engine", T0);
    const claim = { token: "claim", workerId: "worker-1", route: { lane: "coder" }, claimedAt: T1 };
    expect(store.claimUnit("m-engine", "u1", claim)).toMatchObject({ ok: true });
    const ledger = new WorkUnitExecutionLedger(store);
    expect(() =>
      ledger.beginDispatch({
        missionId: "m-engine",
        unitId: "u1",
        claimToken: claim.token,
        workerId: claim.workerId,
        lane: "coder",
        now: T1
      })
    ).toThrow(/implementer engine/);
  });

  it("records a stale report but never lets it overwrite cancellation", () => {
    const { store, ledger, dispatch, claim } = claimed();
    store.cancelMission("m1", { reason: "operator", now: T2 });
    expect(ledger.applyResult({ claimToken: claim.token, result: success(dispatch) })).toEqual({
      applied: "rejected_stale",
      reason: "live claim no longer matches this execution attempt"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
    expect(ledger.attempt(dispatch.attemptId)?.state).toBe("rejected_stale");
  });

  it("keeps unknown external outcomes unknown and therefore non-retryable", () => {
    const { store, ledger, dispatch, claim } = claimed();
    const { result: _result, ...base } = success(dispatch);
    const result: ResultEnvelope = {
      ...base,
      outcome: "unknown",
      receipts: [],
      externalStateUncertain: true
    };
    expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "unknown" });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "unknown", failureCategory: "unknown" });
    expect(store.retryUnit("m1", "u1", T2)).toEqual({ ok: false, outcome: "retry_unsafe" });
  });

  it("persists a worker cancellation as cancelled with honest external-state uncertainty", () => {
    const { store, ledger, dispatch, claim } = claimed();
    const { result: _result, ...base } = success(dispatch);
    const result: ResultEnvelope = {
      ...base,
      outcome: "cancelled",
      receipts: [],
      failure: { category: "cancelled", retrySafe: false },
      externalStateUncertain: true
    };
    expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "cancelled" });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "cancelled",
      failureCategory: "cancelled",
      cancelExternalState: "uncertain"
    });
  });

  it("is idempotent for the same terminal report and rejects a different replay", () => {
    const { ledger, dispatch, claim } = claimed();
    const result = success(dispatch);
    expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "completed" });
    expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "duplicate" });
    expect(
      ledger.applyResult({
        claimToken: claim.token,
        result: { ...result, result: { resultHash: "different", files: [] } }
      })
    ).toEqual({ applied: "rejected_invalid", reason: "attempt already has a different terminal report" });
  });

  it("rejects wrong-worker or wrong-claim reports without poisoning the live attempt", () => {
    const { ledger, dispatch, claim } = claimed();
    expect(
      ledger.applyResult({
        claimToken: claim.token,
        result: { ...success(dispatch), workerId: "other" }
      })
    ).toMatchObject({ applied: "rejected_invalid" });
    expect(ledger.attempt(dispatch.attemptId)?.state).toBe("started");
    expect(
      ledger.applyResult({
        claimToken: "wrong-token",
        result: success(dispatch)
      })
    ).toMatchObject({ applied: "rejected_invalid" });
    expect(ledger.attempt(dispatch.attemptId)?.state).toBe("started");
  });
});

describe("execution adapters", () => {
  it("normalizes the existing coding port into the common result envelope", async () => {
    const { store, dispatch } = claimed();
    const coder: CodingMissionPorts["coder"] = {
      execute: async () => ({
        status: "succeeded",
        value: { resultHash: "coder-hash", files: ["one.ts"] }
      }),
      observe: async () => ({ status: "absent" })
    };
    const adapter = new CoderExecutionAdapter(store, coder, () => T2);
    await expect(adapter.execute(dispatch)).resolves.toMatchObject({
      lane: "coder",
      outcome: "succeeded",
      result: { resultHash: "coder-hash", files: ["one.ts"] },
      receipts: [{ kind: "coder_result", hash: "coder-hash" }]
    });
  });

  it.each(["jc", "dc", "mcp"] as const)(
    "normalizes an already-authorized %s lane outcome without becoming its authority boundary",
    async (lane) => {
      const { dispatch } = claimed({
        kind: "tool",
        payload: { kind: "tool", toolName: "fs.read", argsHash: "args-1" },
        lane
      });
      const seen: DispatchEnvelope[] = [];
      const adapter = new ToolLaneExecutionAdapter(
        lane,
        async ({ dispatch: actual }) => {
          seen.push(actual);
          return {
            ok: true,
            resultHash: `${lane}-hash`,
            receiptKind: `${lane}_tool_result`,
            receiptHash: `${lane}-receipt`,
            files: []
          };
        },
        () => T2
      );
      const result = await adapter.execute(dispatch);
      expect(seen).toHaveLength(1);
      expect(result).toMatchObject({
        lane,
        outcome: "succeeded",
        result: { resultHash: `${lane}-hash` },
        receipts: [{ kind: `${lane}_tool_result`, hash: `${lane}-receipt` }]
      });
    }
  );

  it("normalizes lane failures and only marks retries safe when the lane proves no side effect", async () => {
    const { dispatch } = claimed({
      kind: "tool",
      payload: { kind: "tool", toolName: "fs.read" },
      lane: "mcp"
    });
    const safe = new ToolLaneExecutionAdapter("mcp", async () => ({
      ok: false,
      errorCode: "ECONNREFUSED",
      retrySafe: true,
      externalStateUncertain: false
    }));
    await expect(safe.execute(dispatch)).resolves.toMatchObject({
      outcome: "failed",
      failure: { category: "worker_unavailable", retrySafe: true },
      externalStateUncertain: false
    });
    expect(failureCategoryForCode("desktop_commander_tool_timeout")).toBe("timeout");
    expect(failureCategoryForCode("policy_denied")).toBe("policy_denied");
  });
});
