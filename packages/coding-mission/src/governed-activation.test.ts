import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import {
  SqliteWorkItemStore,
  WORKER_ACTOR_REF_PREFIX,
  executionPlanSubjectInputHash
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { CodingMissionController, type CodingMissionPorts, type ExternalOutcome } from "./controller.js";
import { readMissionFlightRecord } from "./flight-recorder.js";

/**
 * First production caller of createGovernedExecution: CodingMissionController with `governance` set. Everything below the
 * controller is real: the work-item store (actors, human-issued grants, audit chain), the mission store and the dispatch
 * gate. Only the model/executor ports are scripted. Each rejection asserts the strongest property: the executor was
 * never called, so nothing ran.
 */
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OPERATOR = "operator";
const EXEC_ACTOR = "actor:exec";
const WORKER = "semantic-winner";

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length)
    try {
      closers.pop()!();
    } catch {
      // already closed
    }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

interface Options {
  /** Who binds the worker to an actor. `none` leaves the worker unbound. */
  binding?: "operator" | "intruder" | "none";
  /** The actor the worker is bound to. Default is the grant's executing actor. */
  boundActor?: string;
  tools?: AutonomousAuthorityDefinition["toolClasses"];
  maxRuntimeMs?: number;
  bind?: boolean;
  executor?: (signal: AbortSignal | undefined) => Promise<ExternalOutcome<{ resultHash: string; files: string[] }>>;
  /** What the executor reports when asked whether an abandoned operation ran. */
  observe?: ExternalOutcome<{ resultHash: string; files: string[] }>;
}

async function world(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "acs-governed-activation-"));
  dirs.push(root);
  const dbPath = join(root, "control.db");
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const clock = { ms: 1_000 };
  const calls: Array<{ operationId: string; workerId: string; claimToken?: string; signal?: AbortSignal }> = [];

  const control = new SqliteWorkItemStore(dbPath);
  closers.push(() => control.close());
  control.registerActor({ id: OPERATOR, actorType: "HUMAN", displayName: "Operator" });
  control.registerActor({ id: "intruder", actorType: "AGENT", displayName: "Agent with a mutation credential" });
  const binding = options.binding ?? "operator";
  if (binding !== "none") {
    control.registerActor({
      id: options.boundActor ?? EXEC_ACTOR,
      actorType: "AGENT",
      displayName: "Executing agent",
      externalRef: `${WORKER_ACTOR_REF_PREFIX}${WORKER}`,
      registeredByActorId: binding === "operator" ? OPERATOR : "intruder"
    });
  }
  const item = control.create({
    title: "governed coding mission",
    intent: "edit the repository",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: EXEC_ACTOR,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: options.tools ?? [{ runtime: "sandbox", toolName: "code_edit" }],
    maximumPrivileges: ["fs.read", "fs.write"],
    expiresAt: iso(3_600_000),
    limits: {
      maxOperations: 50,
      maxRuntimeMs: options.maxRuntimeMs ?? 600_000,
      maxParallelOperations: 4,
      maxAttemptsPerOperation: 3
    }
  };
  const grant = control.issueAutonomousAuthority(
    {
      missionId: item.id,
      issuedByActorId: OPERATOR,
      requestId: "grant-1",
      expectedSubjectInputHash: executionPlanSubjectInputHash(item),
      definition,
      reason: "bounded coding mission"
    },
    { via: "policy_gate", actorId: OPERATOR }
  );

  const ports: CodingMissionPorts = {
    now: () => iso(clock.ms),
    deploymentPolicy: { requirement: () => ({ required: false, action: "none", impact: "none" }) },
    planner: { decompose: () => [{ operationId: "edit-api", dependsOn: [], title: "edit api" }] },
    router: {
      route: async () => ({
        workerId: WORKER,
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: WORKER }
      })
    },
    coder: {
      execute: async (input) => {
        calls.push({
          operationId: input.operationId,
          workerId: input.workerId,
          ...(input.claimToken ? { claimToken: input.claimToken } : {}),
          ...(input.signal ? { signal: input.signal } : {})
        });
        return options.executor ? options.executor(input.signal) : ok({ resultHash: "result-1", files: ["api.ts"] });
      },
      observe: async () => options.observe ?? { status: "absent" },
      idempotent: true
    },
    reconciler: { reconcile: async () => ok({ headSha: HEAD, conflicts: [] }) },
    validator: {
      validate: async () =>
        ok({
          checks: {
            tests: "PASS",
            typecheck: "PASS",
            lint: "PASS",
            format: "PASS",
            repository: "PASS",
            review: "PASS"
          },
          risks: []
        })
    },
    publisher: {
      publish: async () => ok({ prNumber: 1, prUrl: "https://example.test/pull/1", headSha: HEAD }),
      observe: async () => ({ status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => BASE },
    admission: { acquire: async () => ({ permitId: "permit-1" }) },
    merger: { merge: async () => ok({ mergeSha: "c".repeat(40) }), observe: async () => ({ status: "absent" }) },
    deployer: { deploy: async () => ok({ deploymentId: "d" }), observe: async () => ({ status: "absent" }) },
    verifier: { verify: async () => ({ passed: true, checks: { health: "PASS" } }) },
    governance: { mode: "enforce" }
  };
  const controller = new CodingMissionController(dbPath, ports);
  closers.push(() => controller.close());
  controller.create({
    missionId: item.id,
    repository: "example/repo",
    baseRef: "main",
    baseSha: BASE,
    summary: "governed"
  });
  await controller.advance(item.id); // PLANNING -> RUNNING
  if (options.bind !== false) controller.bindAuthority(item.id, grant.grantId);

  const unit = () => controller.store.operations(item.id)[0]!;
  return { root, dbPath, item, grant, control, controller, ports, calls, clock, iso, unit, definition };
}

type World = Awaited<ReturnType<typeof world>>;

/** The whole refusal contract in one place: nothing ran, the unit is back to pending, the mission waits for an operator. */
async function expectRefused(w: World, reason: string | RegExp) {
  const result = await w.controller.advance(w.item.id);
  expect(result).toMatchObject({ state: "DEGRADED", code: "dispatch_authority_denied" });
  expect(w.calls).toEqual([]);
  expect(w.unit()).toMatchObject({ status: "pending" });
  const denial = w.controller.store
    .events(w.item.id)
    .filter((e) => e.name === "authority.denied")
    .map((e) => e.body as { operation?: string; reason?: string });
  expect(
    denial.some(
      (d) =>
        d.operation === "dispatch" && (typeof reason === "string" ? d.reason === reason : reason.test(d.reason ?? ""))
    )
  ).toBe(true);
  expect(attempts(w)).toBe(0);
  // A further advance does not run it either.
  expect(await w.controller.advance(w.item.id)).toMatchObject({ state: "DEGRADED", progressed: false });
  expect(w.calls).toEqual([]);
}

const attempts = (w: World) => {
  const raw = new DatabaseSync(w.dbPath);
  try {
    return (raw.prepare("SELECT COUNT(*) AS n FROM work_unit_execution_attempts").get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

describe("governed execution: an authorized mission dispatches through the gate", () => {
  it("reaches the executor once, under the verified authority, and completes the unit", async () => {
    const w = await world();
    const result = await w.controller.advance(w.item.id);
    expect(result).toMatchObject({ progressed: true, state: "RUNNING" });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ operationId: "edit-api", workerId: WORKER });
    expect(w.calls[0]!.claimToken).toMatch(/^[0-9a-f-]{36}$/u);
    expect(w.unit()).toMatchObject({ status: "succeeded", resultHash: "result-1" });

    const raw = new DatabaseSync(w.dbPath);
    try {
      const attempt = raw
        .prepare("SELECT state, executor_lane, dispatch_json, authority_json FROM work_unit_execution_attempts")
        .get() as { state: string; executor_lane: string; dispatch_json: string; authority_json: string };
      expect(attempt).toMatchObject({ state: "succeeded", executor_lane: "coder" });
      // What the worker ran under is bound into the dispatch: the verified grant, the unit's authority hash, the deadline.
      const authority = JSON.parse(attempt.authority_json) as {
        grantId: string;
        unitAuthorityHash: string;
        deadlineAt: string;
      };
      expect(authority).toMatchObject({ grantId: w.grant.grantId });
      expect(authority.unitAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(Date.parse(authority.deadlineAt)).toBe(Date.parse(w.iso(1_000)) + 600_000);
      expect(JSON.parse(attempt.dispatch_json).authority).toEqual(authority);
    } finally {
      raw.close();
    }
    // The mission carries on past the executor, and its evidence verifies.
    expect(await w.controller.advance(w.item.id)).toMatchObject({ state: "RECONCILING" });
    expect(readMissionFlightRecord(w.controller.store.db, w.item.id).verification.verdict).toBe("verified");
  });
});

describe("governed execution: a mission with no authority does not start", () => {
  it("waits, claims nothing and runs nothing until an operator binds a grant", async () => {
    const w = await world({ bind: false });
    for (let i = 0; i < 3; i += 1) {
      expect(await w.controller.advance(w.item.id)).toMatchObject({
        progressed: false,
        state: "RUNNING",
        code: "authority_required"
      });
    }
    expect(w.calls).toEqual([]);
    expect(w.unit()).toMatchObject({ status: "pending" });
    expect(attempts(w)).toBe(0);
    // Once bound, it proceeds.
    w.controller.bindAuthority(w.item.id, w.grant.grantId);
    expect(await w.controller.advance(w.item.id)).toMatchObject({ progressed: true });
    expect(w.calls).toHaveLength(1);
  });
});

describe("governed execution: worker identity is verified, never inferred", () => {
  it("refuses a worker nobody bound to an actor", async () => {
    const w = await world({ binding: "none" });
    await expectRefused(w, "worker_not_authorized_for_authority");
  });

  it("refuses a worker whose binding was made by a non-operator", async () => {
    const w = await world({ binding: "intruder" });
    await expectRefused(w, "worker_not_authorized_for_authority");
  });

  it("refuses cross-actor delegation: a worker bound to a different actor than the grant names", async () => {
    const w = await world({ boundActor: "actor:someone-else" });
    await expectRefused(w, "worker_not_authorized_for_authority");
  });

  it("refuses when the worker's binding is overwritten after the grant", async () => {
    const w = await world();
    w.control.registerActor({
      id: EXEC_ACTOR,
      actorType: "AGENT",
      displayName: "Executing agent",
      externalRef: `${WORKER_ACTOR_REF_PREFIX}${WORKER}`,
      registeredByActorId: "intruder"
    });
    await expectRefused(w, "worker_not_authorized_for_authority");
  });
});

describe("governed execution: authority that is revoked, expired, or no longer current", () => {
  it("refuses once the grant is revoked, even though the mission is bound", async () => {
    const w = await world();
    w.control.revokeAutonomousAuthority(w.grant.grantId, OPERATOR, "stop", { via: "policy_gate", actorId: OPERATOR });
    await expectRefused(w, "grant_revoked");
  });

  it("refuses once the authority has expired on ACS's clock", async () => {
    const w = await world();
    w.clock.ms = 3_600_000 + 5_000;
    await expectRefused(w, "authority_expired");
  });

  it("refuses once the authoritative work item is terminal", async () => {
    const w = await world();
    w.control.cancelWorkItem(w.item.id, { actor: "operator" }, { via: "policy_gate", actorId: OPERATOR });
    await expectRefused(w, "grant_subject_changed");
  });

  it("does not run a cancelled mission", async () => {
    const w = await world();
    w.controller.store.transition(w.controller.store.require(w.item.id), "CANCELLED", w.iso(1_500), {
      event: "coding_mission.cancelled"
    });
    expect(await w.controller.advance(w.item.id)).toMatchObject({ progressed: false });
    expect(w.calls).toEqual([]);
  });
});

describe("governed execution: audit integrity is enforced before dispatch", () => {
  it("refuses when the audit chain no longer verifies, and runs nothing", async () => {
    const w = await world();
    const tamper = new DatabaseSync(w.dbPath);
    try {
      for (const { name } of tamper
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'")
        .all() as Array<{ name: string }>) {
        tamper.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
      }
      const first = tamper.prepare("SELECT id FROM audit_events ORDER BY sequence LIMIT 1").get() as { id: string };
      tamper.prepare("DELETE FROM audit_events WHERE id = ?").run(first.id);
    } finally {
      tamper.close();
    }
    await expectRefused(w, "audit_integrity_failed");
  });
});

describe("governed execution: lane-specific tool authorization", () => {
  it("refuses the coder lane when the authority grants no sandbox runtime", async () => {
    const w = await world({ tools: [{ runtime: "desktop_commander", toolName: "read_file" }] });
    await expectRefused(w, "lane_not_permitted");
  });

  it("refuses when the authority grants only a different runtime's tools", async () => {
    const w = await world({ tools: [{ runtime: "jace_commander", toolName: "git_commit" }] });
    await expectRefused(w, "lane_not_permitted");
  });
});

describe("governed execution: runtime deadline", () => {
  const hangs = (capture: { signal?: AbortSignal }) => (signal: AbortSignal | undefined) => {
    capture.signal = signal;
    return new Promise<never>(() => undefined); // never settles: only the deadline can end this
  };

  it("stops waiting at the deadline, signals the executor, and records an uncertain outcome", async () => {
    const capture: { signal?: AbortSignal } = {};
    const w = await world({ maxRuntimeMs: 60, executor: hangs(capture), observe: { status: "unknown" } });
    const started = Date.now();
    const result = await w.controller.advance(w.item.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ progressed: false, code: "unknown_operation" });
    expect(capture.signal?.aborted).toBe(true);
    expect(w.unit()).toMatchObject({ status: "unknown" });
    const raw = new DatabaseSync(w.dbPath);
    try {
      expect(raw.prepare("SELECT state FROM work_unit_execution_attempts").get()).toEqual({ state: "unknown" });
    } finally {
      raw.close();
    }
    expect(w.calls).toHaveLength(1);
  });

  it("does not retry an abandoned run when the executor cannot say whether it is still going", async () => {
    const capture: { signal?: AbortSignal } = {};
    const w = await world({ maxRuntimeMs: 60, executor: hangs(capture), observe: { status: "unknown" } });
    await w.controller.advance(w.item.id);
    for (let i = 0; i < 3; i += 1) {
      expect(await w.controller.advance(w.item.id)).toMatchObject({ progressed: false, code: "unknown_operation" });
    }
    expect(w.calls).toHaveLength(1);
    expect(w.controller.store.escalations(w.item.id)).toEqual([expect.objectContaining({ kind: "recovery_unsafe" })]);
  });

  it("lets an idempotent executor that reports the operation absent be retried, but only with a fresh, re-authorized dispatch", async () => {
    const capture: { signal?: AbortSignal } = {};
    const w = await world({ maxRuntimeMs: 60, executor: hangs(capture), observe: { status: "absent" } });
    await w.controller.advance(w.item.id);
    expect(await w.controller.advance(w.item.id)).toMatchObject({ progressed: true, code: "operation_absent" });
    // The retry goes back through the whole gate: revoke now and it is refused, not run on the old authorization.
    w.control.revokeAutonomousAuthority(w.grant.grantId, OPERATOR, "stop", { via: "policy_gate", actorId: OPERATOR });
    w.clock.ms += 600_000;
    expect(await w.controller.advance(w.item.id)).toMatchObject({
      state: "DEGRADED",
      code: "dispatch_authority_denied"
    });
    expect(w.calls).toHaveLength(1);
  });

  it("derives the deadline from the authority, not from anything the caller supplies", async () => {
    const w = await world({ maxRuntimeMs: 90_000 });
    await w.controller.advance(w.item.id);
    const raw = new DatabaseSync(w.dbPath);
    try {
      const row = raw.prepare("SELECT authority_json FROM work_unit_execution_attempts").get() as {
        authority_json: string;
      };
      expect(Date.parse((JSON.parse(row.authority_json) as { deadlineAt: string }).deadlineAt)).toBe(
        Date.parse(w.iso(1_000)) + 90_000
      );
    } finally {
      raw.close();
    }
  });
});

describe("governed execution: binding is verified", () => {
  it("refuses a grant issued for another mission", async () => {
    const w = await world({ bind: false });
    const other = await world({ bind: false });
    expect(() => w.controller.bindAuthority(w.item.id, other.grant.grantId)).toThrow();
    expect(await w.controller.advance(w.item.id)).toMatchObject({ code: "authority_required" });
    expect(w.calls).toEqual([]);
  });

  it("refuses an unknown grant and a revoked grant", async () => {
    const w = await world({ bind: false });
    expect(() => w.controller.bindAuthority(w.item.id, "grant-that-does-not-exist")).toThrow();
    w.control.revokeAutonomousAuthority(w.grant.grantId, OPERATOR, "stop", { via: "policy_gate", actorId: OPERATOR });
    expect(() => w.controller.bindAuthority(w.item.id, w.grant.grantId)).toThrow();
    expect(await w.controller.advance(w.item.id)).toMatchObject({ code: "authority_required" });
  });

  it("is write-once: a mission cannot be rebound to a different grant", async () => {
    const w = await world();
    const second = w.control.issueAutonomousAuthority(
      {
        missionId: w.item.id,
        issuedByActorId: OPERATOR,
        requestId: "grant-2",
        expectedSubjectInputHash: executionPlanSubjectInputHash(w.control.get(w.item.id)!),
        definition: {
          ...w.definition,
          toolClasses: [...w.definition.toolClasses, { runtime: "desktop_commander", toolName: "read_file" }]
        },
        reason: "a wider grant"
      },
      { via: "policy_gate", actorId: OPERATOR }
    );
    expect(() => w.controller.bindAuthority(w.item.id, second.grantId)).toThrow(/write-once|cannot be widened/u);
  });

  it("is only available on a governed controller", async () => {
    const w = await world();
    const ungoverned = new CodingMissionController(w.dbPath, { ...w.ports, governance: undefined as never });
    closers.push(() => ungoverned.close());
    expect(() => ungoverned.bindAuthority(w.item.id, w.grant.grantId)).toThrowError(
      expect.objectContaining({ code: "governed_execution_disabled" })
    );
  });

  it("refuses to be built on a store instance, because the grant store needs the same file", () => {
    const store = new CodingMissionControllerStore();
    expect(
      () => new CodingMissionController(store as never, { governance: { mode: "enforce" } } as never)
    ).toThrowError(expect.objectContaining({ code: "governed_execution_needs_database_path" }));
  });
});

class CodingMissionControllerStore {}
