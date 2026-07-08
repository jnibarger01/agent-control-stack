import { describe, expect, it } from "vitest";
import { DEFAULT_MOA_CONFIG, MoaError, runMoaTask } from "../src/index.js";
import { aggCreate, aggExecute, aggReadOnly, FakeAcs, FakeAudit, FakeCaller, makeTask, PassthroughRedactor } from "./fakes.js";

const actor = "operator";

function deps(caller: FakeCaller, acs = new FakeAcs(), audit = new FakeAudit()) {
  return { caller, acs, audit, redactor: new PassthroughRedactor(), timeouts: { advisorMs: 30, aggregatorMs: 30 } };
}

describe("MoA orchestrator authority boundaries", () => {
  it("makes zero model calls for unknown presets", async () => {
    const caller = new FakeCaller({ aggregatorReply: aggReadOnly() });
    await expect(runMoaTask(deps(caller), DEFAULT_MOA_CONFIG, "missing", makeTask(), actor)).rejects.toMatchObject({
      code: "PRESET_UNKNOWN"
    });
    expect(caller.calls).toHaveLength(0);
  });

  it("keeps advisors structurally tool-less", async () => {
    const caller = new FakeCaller({ aggregatorReply: aggReadOnly() });
    const result = await runMoaTask(deps(caller), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor);
    expect(result.decision).toBe("read_only_answer");
    expect(caller.calls.find((call) => call.phase === "advisor")?.rawKeys).not.toContain("tools");
  });

  it("passes a bound executable grant into requestExecution", async () => {
    const caller = new FakeCaller({ aggregatorReply: aggExecute("wrk_good") });
    const acs = new FakeAcs({ grant: { grant_id: "grant-good", lease_token: "lease-good", action_hash: "hash-good" } });
    const result = await runMoaTask(deps(caller, acs), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor);
    expect(result.decision).toBe("execute_approved_work");
    expect(acs.getGrantCalls).toHaveLength(1);
    expect(acs.getGrantCalls[0]).toMatchObject({
      work_item_id: "wrk_good",
      actor,
      task_id: "task_20260708_001",
      session_id: "session-a",
      source: "moa_aggregator",
      expected_category: "filesystem_write"
    });
    expect(acs.requestExecutionCalls).toEqual([
      expect.objectContaining({ work_item_id: "wrk_good", actor, grant_id: "grant-good", lease_token: "lease-good" })
    ]);
  });

  it("blocks random approved IDs when ACS rejects grant binding and emits moa_execution_blocked", async () => {
    const caller = new FakeCaller({ aggregatorReply: aggExecute("wrk_random_approved") });
    const audit = new FakeAudit();
    const acs = new FakeAcs({ grantError: new Error("wrong task/session/action grant") });
    await expect(runMoaTask(deps(caller, acs, audit), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor)).rejects.toMatchObject({
      code: "EXECUTION_NOT_APPROVED"
    });
    expect(acs.requestExecutionCalls).toHaveLength(0);
    expect(audit.byType("moa_execution_blocked")).toHaveLength(1);
    expect(JSON.stringify(audit.events)).not.toContain("wrong task/session/action grant");
  });

  it("rejects invalid aggregator output with zero ACS side effects", async () => {
    const acs = new FakeAcs();
    await expect(runMoaTask(deps(new FakeCaller({ aggregatorReply: "{\"decision\":\"create_work_item\"}" }), acs), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor)).rejects.toMatchObject({
      code: "AGGREGATOR_INVALID"
    });
    expect(acs.createWorkItemCalls).toHaveLength(0);
    expect(acs.requestExecutionCalls).toHaveLength(0);
  });

  it("sanitizes raw goal, advisor output, and aggregator decision from audit data", async () => {
    const secretAdvisor = JSON.stringify({
      verdict: "risky",
      key_risks: ["sk-test-1234567890", "OPENAI_API_KEY=sk-test-leak", "password=hunter2"],
      recommended_next_steps: [],
      do_not_do: [],
      confidence: 0.8
    });
    const audit = new FakeAudit();
    await runMoaTask(deps(new FakeCaller({ advisorReply: secretAdvisor, aggregatorReply: aggCreate() }), new FakeAcs(), audit), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor);
    const serialized = JSON.stringify(audit.events);
    expect(serialized).not.toContain("sk-test-1234567890");
    expect(serialized).not.toContain("OPENAI_API_KEY=sk-test-leak");
    expect(serialized).not.toContain("password=hunter2");
    expect(serialized).not.toContain("Review auth;");
    expect(audit.byType("moa_run_started")[0]?.data).toHaveProperty("goal_sha256");
    expect(audit.byType("moa_aggregator_decision")[0]?.data).toMatchObject({ decision: "create_work_item" });
    expect(audit.byType("moa_aggregator_decision")[0]?.data).toHaveProperty("decision_sha256");
  });

  it("aborts timed-out advisors and never runs the aggregator", async () => {
    const caller = new FakeCaller({ advisorDelayMs: 80, aggregatorReply: aggReadOnly() });
    const audit = new FakeAudit();
    await expect(runMoaTask(deps(caller, new FakeAcs(), audit), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor)).rejects.toMatchObject({
      code: "ADVISOR_FAILED"
    });
    expect(caller.signals[0]?.aborted).toBe(true);
    expect(caller.calls.filter((call) => call.phase === "aggregator")).toHaveLength(0);
    expect(JSON.stringify(audit.events)).not.toContain("OPENAI_API_KEY=sk-test-leak");
  });

  it("rejects actionable blocked-risk decisions", async () => {
    const caller = new FakeCaller({ aggregatorReply: aggCreate({ risk: "blocked" }) });
    await expect(runMoaTask(deps(caller), DEFAULT_MOA_CONFIG, "cheap", makeTask(), actor)).rejects.toBeInstanceOf(MoaError);
  });
});
