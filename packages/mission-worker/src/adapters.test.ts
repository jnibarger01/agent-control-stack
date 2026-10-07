import { stableHash } from "@agent-control-stack/shared";
import type { EngineAdapter, EngineOutcome, EngineTask } from "@agent-control-stack/engine-adapter";
import type { CodingMissionPorts } from "@agent-control-stack/coding-mission";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { CoderPortMissionWorker } from "./adapters/coder-port.js";
import { EngineMissionWorker } from "./adapters/engine.js";
import { MachineToolMissionWorker, READ_ONLY_MACHINE_TOOLS } from "./adapters/machine.js";
import type { MissionWorker, PrepareContext } from "./contract.js";
import { categoryForError, failureFromError, normalizeFailure } from "./failure.js";
import { runClaimedUnit } from "./runner.js";
import { claimUnit, setup, T0 } from "./test-support.js";

const unit = (store: ReturnType<typeof setup>["store"]) =>
  store.workUnits("m1").find((entry) => entry.unitId === "u1")!;

function engineTask(overrides: Partial<EngineTask> = {}): EngineTask {
  return {
    workItemId: "wi",
    attemptId: "att",
    leaseId: "lease-1",
    workerId: "w1",
    fencingToken: 7,
    authorization: { kind: "action", hash: "a".repeat(64) },
    policyVersion: "p1",
    auditCorrelationId: "corr",
    idempotencyKey: "idem",
    workspace: { allocationId: "alloc", hostPath: "/ws" },
    prompt: "do it",
    egressAllowlist: [],
    limits: {} as EngineTask["limits"],
    ...overrides
  };
}

function engineWorker(
  outcome: EngineOutcome | (() => Promise<EngineOutcome>),
  taskOverrides: Partial<EngineTask> = {}
) {
  const seen: Array<{ task: EngineTask; signal?: AbortSignal }> = [];
  const adapter: EngineAdapter = {
    id: "fake-engine",
    invoke: async (task, signal) => {
      seen.push({ task, ...(signal ? { signal } : {}) });
      return typeof outcome === "function" ? outcome() : outcome;
    }
  };
  const worker = new EngineMissionWorker({ workerId: "w1", adapter, resolveTask: () => engineTask(taskOverrides) });
  return { worker, seen };
}

describe("EngineMissionWorker", () => {
  it("wraps a clean exit as a success without claiming it knows which files changed", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const { worker, seen } = engineWorker({
      status: "completed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 5,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const result = await runClaimedUnit(deps, worker, {
      missionId: "m1",
      unitId: "u1",
      claim,
      authority: { leaseId: "lease-1", fencingToken: 7 }
    });
    expect(result).toMatchObject({ ran: true, ingest: { applied: "completed" } });
    expect(seen).toHaveLength(1);
    const report = store.evidence<{
      result: { filesReported: boolean };
      resources: unknown[];
      actions: Array<{ name: string }>;
    }>("m1", "execution_report:u1:1");
    expect(report?.result.filesReported).toBe(false);
    expect(report?.actions[0]?.name).toBe("engine.invoke");
    expect(report?.resources).toEqual([{ kind: "file", ref: "workspace:alloc", access: "write" }]);
  });

  it("normalizes a non-zero exit as a tool failure that is never retry-safe", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const { worker } = engineWorker({
      status: "completed",
      exitCode: 2,
      stdout: "",
      stderr: "boom",
      durationMs: 5,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "failed" }
    });
    expect(unit(store)).toMatchObject({ status: "failed", failureCategory: "tool_failure" });
  });

  it.each([
    [{ status: "timeout", durationMs: 9 } as EngineOutcome, "timeout"],
    [{ status: "process_error", message: "spawn ENOENT" } as EngineOutcome, "worker_unavailable"]
  ])("normalizes %j to %s and parks it as failed rather than auto-retryable", async (outcome, category) => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const { worker } = engineWorker(outcome);
    await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim });
    expect(unit(store)).toMatchObject({ status: "failed", failureCategory: category });
  });

  it("propagates cancellation into the engine's abort signal", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const controller = new AbortController();
    let aborted = false;
    const { worker } = engineWorker(
      () =>
        new Promise<EngineOutcome>((resolve) => {
          const timer = setInterval(() => {
            if (aborted) {
              clearInterval(timer);
              resolve({ status: "cancelled", durationMs: 1 });
            }
          }, 2);
        })
    );
    const original = worker.cancel.bind(worker);
    worker.cancel = async (handle, reason) => {
      aborted = true;
      await original(handle, reason);
    };
    const running = runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.cancelMission("m1", { reason: "operator", now: "2026-10-06T00:00:09.000Z" });
    controller.abort();
    expect(await running).toMatchObject({ ingest: { applied: "cancelled" } });
    expect(unit(store)).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
  });

  it("refuses an engine task bound to another worker, lease or fencing token, and never invokes the engine", async () => {
    for (const [override, authority] of [
      [{ workerId: "other" }, {}],
      [{ leaseId: "lease-9" }, { leaseId: "lease-1" }],
      [{ fencingToken: 99 }, { fencingToken: 7 }]
    ] as const) {
      const { store, deps } = setup();
      const claim = claimUnit(store);
      const { worker, seen } = engineWorker({ status: "timeout", durationMs: 1 }, override);
      const result = await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim, authority });
      expect(result).toMatchObject({ ran: true, ingest: { applied: "failed" } });
      expect(seen).toEqual([]);
      expect(unit(store).failureCategory).toBe("policy_denied");
    }
  });

  it("refuses a handle it did not issue", async () => {
    const { worker } = engineWorker({ status: "timeout", durationMs: 1 });
    const forged = {
      executionId: "x",
      missionId: "m1",
      unitId: "u1",
      workerId: "w1",
      claimToken: "t",
      attempt: 1,
      startedAt: T0
    };
    await expect(worker.observe(forged)).rejects.toMatchObject({ code: "worker_handle_unknown" });
    await expect(worker.cancel(forged, { code: "operator" })).rejects.toMatchObject({ code: "worker_handle_unknown" });
    await expect(worker.report(forged)).rejects.toMatchObject({ code: "worker_handle_unknown" });
  });

  it("does not offer checkpoint or resume for an opaque process", () => {
    const { worker } = engineWorker({ status: "timeout", durationMs: 1 });
    const contract: MissionWorker = worker;
    expect(contract.checkpoint).toBeUndefined();
    expect(contract.resume).toBeUndefined();
  });
});

describe("MachineToolMissionWorker", () => {
  const toolUnits = (argsHash?: string) => [
    {
      unitId: "u1",
      kind: "tool" as const,
      title: "t",
      payload: { toolName: "fs.read", ...(argsHash ? { argsHash } : {}) }
    }
  ];

  function machine(
    callTool: (name: string, args: unknown) => Promise<unknown>,
    call: { name: string; args: unknown } = { name: "fs.read", args: { path: "/repo/README.md" } }
  ) {
    return new MachineToolMissionWorker({ workerId: "w1", controller: { callTool }, resolveCall: () => call });
  }

  it("runs an approved read-only call and reports a receipt, not the result body", async () => {
    const { store, deps } = setup({ units: toolUnits(stableHash({ path: "/repo/README.md" })) });
    const claim = claimUnit(store);
    const worker = machine(async () => ({ text: "hello" }));
    expect(await runClaimedUnit(deps, worker, { missionId: "m1", unitId: "u1", claim })).toMatchObject({
      ingest: { applied: "completed" }
    });
    const report = store.evidence<{ receipts: Array<{ kind: string }>; actions: Array<{ argsHash: string }> }>(
      "m1",
      "execution_report:u1:1"
    );
    expect(report?.receipts[0]?.kind).toBe("machine_tool_result");
    expect(report?.actions[0]?.argsHash).toBe(stableHash({ path: "/repo/README.md" }));
    expect(JSON.stringify(report)).not.toContain("hello");
  });

  it("refuses a call whose tool or arguments differ from what the unit approved", async () => {
    let calls = 0;
    const callTool = async () => {
      calls += 1;
      return {};
    };
    const wrongArgs = setup({ units: toolUnits(stableHash({ path: "/etc/shadow" })) });
    expect(
      await runClaimedUnit(wrongArgs.deps, machine(callTool), {
        missionId: "m1",
        unitId: "u1",
        claim: claimUnit(wrongArgs.store)
      })
    ).toMatchObject({
      ingest: { applied: "failed" }
    });
    expect(unit(wrongArgs.store).failureCategory).toBe("policy_denied");
    const wrongTool = setup({ units: toolUnits() });
    await runClaimedUnit(wrongTool.deps, machine(callTool, { name: "cmd.run", args: {} }), {
      missionId: "m1",
      unitId: "u1",
      claim: claimUnit(wrongTool.store)
    });
    expect(unit(wrongTool.store).failureCategory).toBe("policy_denied");
    expect(calls).toBe(0);
  });

  it("treats a failed read-only call as retry-safe and a failed mutating call as not", async () => {
    const readOnly = setup({ units: toolUnits() });
    const worker = machine(async () => {
      throw new Error("ECONNREFUSED");
    });
    await runClaimedUnit(readOnly.deps, worker, { missionId: "m1", unitId: "u1", claim: claimUnit(readOnly.store) });
    expect(unit(readOnly.store)).toMatchObject({ status: "retryable", failureCategory: "worker_unavailable" });

    const mutating = setup({ units: [{ unitId: "u1", kind: "tool", title: "t", payload: { toolName: "cmd.run" } }] });
    const risky = machine(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      { name: "cmd.run", args: { argv: ["rm", "x"] } }
    );
    await runClaimedUnit(mutating.deps, risky, { missionId: "m1", unitId: "u1", claim: claimUnit(mutating.store) });
    expect(unit(mutating.store).status).toBe("failed");
    expect(READ_ONLY_MACHINE_TOOLS.has("cmd.run")).toBe(false);
  });
});

describe("CoderPortMissionWorker", () => {
  function coder(outcome: Awaited<ReturnType<CodingMissionPorts["coder"]["execute"]>>) {
    const calls: string[] = [];
    const port: CodingMissionPorts["coder"] = {
      execute: async ({ operationId, workerId }) => {
        calls.push(`${operationId}:${workerId}`);
        return outcome;
      },
      observe: async () => ({ status: "absent" })
    };
    return { port, calls };
  }
  const run = async (outcome: Parameters<typeof coder>[0]) => {
    const fixture = setup();
    const claim = claimUnit(fixture.store);
    const { port, calls } = coder(outcome);
    const worker = new CoderPortMissionWorker({ workerId: "w1", coder: port, store: fixture.store });
    const result = await runClaimedUnit(fixture.deps, worker, { missionId: "m1", unitId: "u1", claim });
    return { ...fixture, result, calls };
  };

  it("passes a success through with its files", async () => {
    const { store, result, calls } = await run({
      status: "succeeded",
      value: { resultHash: "h", files: ["a.ts", "b.ts"] }
    });
    expect(result).toMatchObject({ ingest: { applied: "completed" } });
    expect(calls).toEqual(["u1:w1"]);
    expect(unit(store)).toMatchObject({ status: "succeeded", files: ["a.ts", "b.ts"] });
  });

  it("maps a conflict to environment_changed and never retries it", async () => {
    const { store } = await run({ status: "rejected", code: "conflict" });
    expect(unit(store)).toMatchObject({ status: "failed", failureCategory: "environment_changed" });
  });

  it("keeps an unknown outcome unknown instead of inventing a failure", async () => {
    const { store, result } = await run({ status: "unknown" });
    expect(result).toMatchObject({ ingest: { applied: "marked_unknown" } });
    expect(unit(store).status).toBe("unknown");
    expect(store.retryUnit("m1", "u1", T0)).toEqual({ ok: false, outcome: "retry_unsafe" });
  });
});

describe("failure normalization", () => {
  it("maps known error shapes and falls back to unknown without guessing", () => {
    expect(categoryForError(new Error("request timed out"))).toBe("timeout");
    expect(categoryForError(new ControlStackError("policy_denied_lease", "lease mismatch"))).toBe("policy_denied");
    expect(categoryForError(new ControlStackError("lease_expired", "x"))).toBe("authority_expired");
    expect(categoryForError(new ControlStackError("coding_mission_claim_conflict", "x"))).toBe("lease_lost");
    expect(categoryForError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("cancelled");
    expect(categoryForError(new Error("something odd happened"))).toBe("unknown");
  });

  it("is retry-safe only when the worker says no side effect is possible and the category allows a retry", () => {
    expect(normalizeFailure({ category: "timeout" }).retrySafe).toBe(false);
    expect(normalizeFailure({ category: "timeout", sideEffectsPossible: false }).retrySafe).toBe(true);
    for (const category of ["policy_denied", "authority_expired", "retry_budget_exhausted", "cancelled"] as const) {
      expect(normalizeFailure({ category, sideEffectsPossible: false }).retrySafe).toBe(false);
    }
  });

  it("keeps the native error beside the category, bounded and scrubbed", () => {
    const failure = failureFromError(new Error(`${"x".repeat(2000)} password=hunter2`));
    expect(failure.nativeMessage!.length).toBeLessThanOrEqual(500);
    const secret = normalizeFailure({
      category: "unknown",
      nativeMessage: "token=abc123 Authorization: Bearer sk-live-123456789012345678901234"
    });
    expect(secret.nativeMessage).not.toContain("sk-live-123456789012345678901234");
  });
});

describe("contract shape", () => {
  it("reports carry no claim token, only its hash", async () => {
    const { store, deps } = setup();
    const claim = claimUnit(store);
    const { worker } = engineWorker({
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const ctx: PrepareContext = {
      missionId: "m1",
      unitId: "u1",
      kind: "coding",
      attempt: 1,
      claim,
      authority: {},
      now: T0
    };
    const handle = await worker.execute(await worker.prepare(ctx), new AbortController().signal);
    const report = await worker.report(handle);
    expect(JSON.stringify(report)).not.toContain(claim.claimToken);
    expect(report.claim.claimTokenHash).toBe(stableHash(claim.claimToken));
    void deps;
  });
});
