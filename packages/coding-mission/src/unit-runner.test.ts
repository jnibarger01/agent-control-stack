import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { createGovernedExecution, type GovernedExecution } from "./governed-runtime.js";
import { GovernedUnitRunner } from "./unit-runner.js";
import type { DispatchEnvelope, ResultEnvelope, WorkUnitExecutorAdapter } from "./worker-execution.js";

/**
 * The runner is the first production caller of beginDispatch. These tests drive it only through the governed root on
 * the real grant store, with a fake lane adapter that records what it was asked to run.
 */
const HUMAN = "human-issuer";
const ACTOR = "actor:lead";
const open: GovernedExecution[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length)
    try {
      open.pop()!.close();
    } catch {
      // already closed
    }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Options {
  governed?: boolean;
  actors?: Record<string, string>;
}

function world(options: Options = {}) {
  const { governed = true, actors = { "dc-worker": ACTOR } } = options;
  const root = mkdtempSync(join(tmpdir(), "acs-runner-"));
  dirs.push(root);
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const state = { now: iso(1_000) };
  const exec = createGovernedExecution({
    dbPath: join(root, "control.db"),
    verifyOperator: () => false,
    resolveActor: (workerId) => actors[workerId],
    clock: () => state.now
  });
  open.push(exec);
  const item = exec.items.create({
    title: "runner mission",
    intent: "run governed units",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
    maximumPrivileges: ["fs.read"],
    expiresAt: iso(3_600_000),
    limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
  };
  const grant = exec.items.issueAutonomousAuthority(
    {
      missionId: item.id,
      issuedByActorId: HUMAN,
      requestId: "grant-1",
      expectedSubjectInputHash: executionPlanSubjectInputHash(item),
      definition,
      reason: "bounded mission authority"
    },
    { via: "policy_gate", actorId: HUMAN }
  );
  exec.missions.createGeneral({
    missionId: item.id,
    summary: "m",
    budget: { ...DEFAULT_DELEGATION_BUDGET },
    now: iso(0)
  });
  exec.missions.addWorkUnits(
    item.id,
    [{ unitId: "u1", kind: "desktop", title: "read a file", payload: { kind: "desktop", objective: "read" } }],
    iso(0)
  );
  if (governed) exec.authority.grantMissionAuthority({ missionId: item.id, grantId: grant.grantId });

  const calls: DispatchEnvelope[] = [];
  const adapter = (
    behavior: (d: DispatchEnvelope) => Promise<ResultEnvelope> | ResultEnvelope
  ): WorkUnitExecutorAdapter => ({
    lane: "dc",
    async execute(dispatch) {
      calls.push(dispatch);
      return behavior(dispatch);
    }
  });
  const ok = (d: DispatchEnvelope): ResultEnvelope => ({
    schemaVersion: "acs.work-unit-result.v1",
    attemptId: d.attemptId,
    missionId: d.missionId,
    unitId: d.unitId,
    unitAttempt: d.unitAttempt,
    workerId: d.workerId,
    lane: d.lane,
    claimTokenHash: d.claimTokenHash,
    outcome: "succeeded",
    startedAt: d.issuedAt,
    finishedAt: state.now,
    receipts: [{ kind: "dc_result", hash: "receipt-1" }],
    result: { resultHash: "result-1", files: [] },
    externalStateUncertain: false
  });
  const runner = (adapters: WorkUnitExecutorAdapter[]) =>
    new GovernedUnitRunner({ execution: exec, adapters, now: () => state.now });
  const unit = () => exec.missions.workUnits(item.id).find((u) => u.unitId === "u1")!;
  const attempts = () =>
    (exec.missions.db.prepare("SELECT COUNT(*) AS n FROM work_unit_execution_attempts").get() as { n: number }).n;
  const input = { missionId: item.id, unitId: "u1", workerId: "dc-worker", lane: "dc" as const };
  return { exec, item, grant, state, iso, calls, adapter, ok, runner, unit, attempts, input };
}

describe("governed unit runner", () => {
  it("claims, dispatches under verified authority, runs the lane adapter and applies the result", async () => {
    const w = world();
    const result = await w.runner([w.adapter(w.ok)]).runUnit(w.input);
    expect(result).toMatchObject({ status: "executed", applied: { applied: "completed" } });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.authority).toMatchObject({ grantId: w.grant.grantId });
    expect(w.calls[0]!.authority.unitAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(w.unit().status).toBe("succeeded");
    expect(w.exec.items.verifyAuditChain().ok).toBe(true);
  });

  it("does not run the adapter when the grant has been revoked, and fails the unit non-retryably with evidence", async () => {
    const w = world();
    w.exec.items.revokeAutonomousAuthority(w.grant.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    const result = await w.runner([w.adapter(w.ok)]).runUnit(w.input);
    expect(result).toMatchObject({ status: "denied" });
    expect(result.status === "denied" && result.reason).toMatch(/grant_revoked/u);
    expect(w.calls).toHaveLength(0);
    expect(w.attempts()).toBe(0);
    expect(w.unit()).toMatchObject({ status: "failed", failureCategory: "policy_denied" });
    expect(w.exec.missions.events(w.item.id).map((e) => e.name)).toContain("authority.denied");
  });

  it("denies a worker the deployment does not map to the authority's actor", async () => {
    const w = world({ actors: { "someone-else": ACTOR } });
    const result = await w.runner([w.adapter(w.ok)]).runUnit(w.input);
    expect(result).toMatchObject({ status: "denied" });
    expect(result.status === "denied" && result.reason).toMatch(/worker_not_authorized_for_authority/u);
    expect(w.calls).toHaveLength(0);
  });

  it("has no side effects when no adapter serves the lane", async () => {
    const w = world();
    const result = await w.runner([]).runUnit(w.input);
    expect(result).toEqual({ status: "not_run", reason: "lane_unavailable" });
    expect(w.unit().status).not.toBe("running");
    expect(w.unit().status).not.toBe("failed");
    expect(w.attempts()).toBe(0);
  });

  it("reports a failed adapter as a failed unit with the external state marked uncertain", async () => {
    const w = world();
    const result = await w
      .runner([
        w.adapter(() => {
          throw new Error("boom");
        })
      ])
      .runUnit(w.input);
    expect(result).toMatchObject({ status: "executed", applied: { applied: "failed" } });
    expect(w.unit().status).toBe("failed");
    const row = w.exec.missions.db
      .prepare("SELECT state, report_json FROM work_unit_execution_attempts LIMIT 1")
      .get() as { state: string; report_json: string };
    expect(row.state).toBe("failed");
    expect(JSON.parse(row.report_json)).toMatchObject({ externalStateUncertain: true });
  });

  it("still runs missions with no authority binding exactly as before", async () => {
    const w = world({ governed: false });
    const result = await w.runner([w.adapter(w.ok)]).runUnit(w.input);
    expect(result).toMatchObject({ status: "executed", applied: { applied: "completed" } });
    expect(w.calls[0]!.authority.grantId).toBeUndefined();
  });

  it("lets only one of two concurrent runs execute the same unit", async () => {
    const w = world();
    const run = w.runner([w.adapter(async (d) => w.ok(d))]);
    const [a, b] = await Promise.all([run.runUnit(w.input), run.runUnit(w.input)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["executed", "not_run"]);
    expect(w.calls).toHaveLength(1);
  });
});
