import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { afterEach } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { createGovernedExecution, type GovernedExecution } from "./governed-runtime.js";
import { GovernedUnitRunner } from "./unit-runner.js";
import type { DispatchEnvelope, ResultEnvelope, WorkUnitExecutorAdapter } from "./worker-execution.js";

/**
 * Shared by the driver and worker-hook tests: a real control-plane database, a real human-issued grant per governed
 * mission, and a recording coder-lane adapter. Nothing here builds a ledger by hand; it all goes through the governed root.
 */
export const HUMAN = "human-issuer";
export const ACTOR = "actor:coder";
export const WORKER = "coder-worker";
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

export function setupGovernedWorld() {
  const root = mkdtempSync(join(tmpdir(), "acs-driver-"));
  dirs.push(root);
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const state = { now: iso(1_000) };
  const exec = createGovernedExecution({
    dbPath: join(root, "control.db"),
    verifyOperator: () => false,
    resolveActor: (workerId) => (workerId === WORKER ? ACTOR : undefined),
    clock: () => state.now
  });
  open.push(exec);
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
    maximumPrivileges: ["fs.read"],
    expiresAt: iso(3_600_000),
    limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
  };
  let n = 0;
  /** A general mission with the given units, optionally bound to a real human-issued grant. */
  const mission = (
    governed: boolean,
    units: Array<{ id: string; kind?: "coding" | "desktop"; dependsOn?: string[] }>,
    state2?: "cancel"
  ) => {
    n += 1;
    const item = exec.items.create({
      title: `driver mission ${n}`,
      intent: "run governed units",
      requester: "agent",
      requesterSubject: "planner",
      target: { cwd: root },
      risk: "low",
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
    });
    exec.missions.createGeneral({
      missionId: item.id,
      summary: "m",
      budget: { ...DEFAULT_DELEGATION_BUDGET },
      now: iso(0)
    });
    exec.missions.addWorkUnits(
      item.id,
      units.map((u) => ({
        unitId: u.id,
        kind: u.kind ?? "coding",
        title: u.id,
        ...(u.dependsOn ? { dependsOn: u.dependsOn } : {}),
        payload: u.kind === "desktop" ? { kind: "desktop", objective: "x" } : { kind: "coding", instructions: "x" }
      })),
      iso(0)
    );
    if (governed) {
      const grant = exec.items.issueAutonomousAuthority(
        {
          missionId: item.id,
          issuedByActorId: HUMAN,
          requestId: `grant-${n}`,
          expectedSubjectInputHash: executionPlanSubjectInputHash(item),
          definition,
          reason: "bounded"
        },
        { via: "policy_gate", actorId: HUMAN }
      );
      exec.authority.grantMissionAuthority({ missionId: item.id, grantId: grant.grantId });
    }
    if (state2 === "cancel") exec.missions.cancelMission(item.id, { reason: "operator", now: iso(500) });
    return item.id;
  };
  const ran: string[] = [];
  const adapter: WorkUnitExecutorAdapter = {
    lane: "coder",
    async execute(d: DispatchEnvelope): Promise<ResultEnvelope> {
      ran.push(`${d.missionId}:${d.unitId}`);
      return {
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
        receipts: [{ kind: "coder_result", hash: "r" }],
        result: { resultHash: "h", files: [] },
        externalStateUncertain: false
      };
    }
  };
  const runner = new GovernedUnitRunner({ execution: exec, adapters: [adapter], now: () => state.now });
  const dbPath = join(root, "control.db");
  return { root, dbPath, exec, mission, ran, runner, adapter, iso, state };
}
