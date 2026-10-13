import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import {
  GeneralCodingExecutionAdapter,
  type GeneralCodingExecutor,
  type GeneralCodingOutcome,
  type GeneralCodingRequest
} from "./general-coding-adapter.js";
import { createGovernedExecution, type GovernedExecution } from "./governed-runtime.js";
import { GovernedUnitRunner } from "./unit-runner.js";
import type { WorkUnitExecutorAdapter } from "./worker-execution.js";

/** Test fixture: a governed general mission with one coding unit `u1`, on the real grant store. */
export const HUMAN = "human-issuer";
export const ACTOR = "actor:lead";
export const SHA = "a".repeat(40);
const open: GovernedExecution[] = [];
const dirs: string[] = [];
/** Closes every governed root and removes every temp directory the fixture created. */
export function cleanupWorlds(): void {
  while (open.length)
    try {
      open.pop()!.close();
    } catch {
      // already closed
    }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}

export interface Options {
  toolClasses?: AutonomousAuthorityDefinition["toolClasses"];
  maxRuntimeMs?: number;
  payload?: Record<string, unknown>;
  /** Scope as a function of the repository path, so tests can grant less than the repository. */
  scope?: (repository: string) => AutonomousAuthorityDefinition["scope"];
  expiresInMs?: number;
}

export function world(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "acs-general-"));
  dirs.push(root);
  const repository = join(root, "repos", "acs");
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const state = { now: iso(1_000) };
  const exec = createGovernedExecution({
    dbPath: join(root, "control.db"),
    verifyOperator: () => false,
    resolveActor: (workerId) => (workerId === "coder-worker" ? ACTOR : undefined),
    clock: () => state.now
  });
  open.push(exec);
  const item = exec.items.create({
    title: "general mission",
    intent: "run a coding unit",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR,
    scope: options.scope?.(repository) ?? [{ kind: "repository", id: repository, coverage: "descendants" }],
    toolClasses: options.toolClasses ?? [{ runtime: "sandbox", toolName: "edit" }],
    maximumPrivileges: ["fs.read"],
    expiresAt: iso(options.expiresInMs ?? 3_600_000),
    limits: {
      maxOperations: 50,
      maxRuntimeMs: options.maxRuntimeMs ?? 600_000,
      maxParallelOperations: 4,
      maxAttemptsPerOperation: 3
    }
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
  const payload = {
    kind: "coding",
    repository,
    baseSha: SHA,
    instructions: "rename the helper",
    files: ["src/a.ts", "docs"],
    maxRuntimeMs: 60_000,
    maxFiles: 3,
    ...options.payload
  };
  exec.missions.addWorkUnits(item.id, [{ unitId: "u1", kind: "coding", title: "edit", payload }], iso(0));
  exec.authority.grantMissionAuthority({ missionId: item.id, grantId: grant.grantId });

  const requests: GeneralCodingRequest[] = [];
  const executor = (
    behavior: (request: GeneralCodingRequest) => Promise<GeneralCodingOutcome> | GeneralCodingOutcome
  ): GeneralCodingExecutor => ({
    async execute(request) {
      requests.push(request);
      return behavior(request);
    }
  });
  const good = (): GeneralCodingOutcome => ({
    status: "succeeded",
    baseSha: SHA,
    resultHash: "result-1",
    files: ["src/a.ts", "docs/readme.md"]
  });
  const adapter = (exe: GeneralCodingExecutor) =>
    new GeneralCodingExecutionAdapter(exec.missions, exec.authority, exe, () => state.now);
  const runner = (adapters: WorkUnitExecutorAdapter[]) =>
    new GovernedUnitRunner({ execution: exec, adapters, now: () => state.now });
  const run = (adapters: WorkUnitExecutorAdapter[], signal?: AbortSignal) =>
    runner(adapters).runUnit({
      missionId: item.id,
      unitId: "u1",
      workerId: "coder-worker",
      lane: "coder",
      ...(signal ? { signal } : {})
    });
  const unit = () => exec.missions.workUnits(item.id).find((u) => u.unitId === "u1")!;
  const attempt = () => {
    const row = exec.missions.db
      .prepare("SELECT state, failure_category, report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
      .get(item.id) as { state: string; failure_category: string | null; report_json: string | null };
    return {
      state: row.state,
      category: row.failure_category,
      report: row.report_json ? (JSON.parse(row.report_json) as { failure?: { nativeCode?: string } }) : undefined
    };
  };
  const runnerFor = runner;
  return { runnerFor, exec, item, repository, state, iso, requests, executor, good, adapter, run, unit, attempt };
}
