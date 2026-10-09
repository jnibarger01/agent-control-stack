import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomousAuthorityHash, type AutonomousAuthorityGrant } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { isSubset, type AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET, type MissionBudget } from "./budget.js";
import { MissionAuthorityLedger, type ChildWorkItem, type GrantReader, type LedgerOptions } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-09T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const NOW = () => new Date(T0);

const ROOT: AutonomousAuthorityDefinition = {
  executingActorId: "actor:lead",
  scope: [
    { kind: "path", id: "/repo/acme/app", coverage: "descendants" },
    { kind: "path", id: "/repo/acme/docs", coverage: "descendants" }
  ],
  toolClasses: [
    { runtime: "desktop_commander", toolName: "read_file" },
    { runtime: "desktop_commander", toolName: "write_file" },
    { runtime: "jace_commander", toolName: "git_commit" }
  ],
  maximumPrivileges: ["fs.read", "fs.write", "git.write", "process.privileged"],
  expiresAt: "2026-10-09T02:00:00.000Z",
  limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
};
const narrower = (overrides: Partial<AutonomousAuthorityDefinition>): AutonomousAuthorityDefinition => ({
  ...ROOT,
  maximumPrivileges: ["fs.read", "fs.write"],
  ...overrides
});

function makeGrant(missionId: string, definition = ROOT, grantId = "grant-1"): AutonomousAuthorityGrant {
  const core = {
    schemaVersion: "acs.autonomous-authority.v1" as const,
    grantId,
    missionId,
    subjectInputHash: "a".repeat(64),
    issuedByActorId: "human-1",
    requestId: "req-1",
    definition,
    reason: "approved by operator",
    createdAt: T0
  };
  return { ...core, grantHash: autonomousAuthorityHash(core), auditEventId: "evt-1" };
}

/** The human-issued grant store the ledger reads. A test controls exactly what the "control plane" holds. */
class FakeGrants implements GrantReader {
  readonly grants = new Map<string, AutonomousAuthorityGrant>();
  getAutonomousAuthority(grantId: string) {
    return this.grants.get(grantId);
  }
}

let n = 0;
const child = (unitId: string, overrides: Partial<ChildWorkItem> = {}): ChildWorkItem => ({
  unitId,
  workType: "research",
  purpose: `purpose of ${unitId}`,
  payload: { role: "researcher", prompt: "look into it" },
  ...overrides
});

function harness(overrides: Partial<LedgerOptions> = {}) {
  const state = { now: at(1000) };
  const grants = new FakeGrants();
  const options: LedgerOptions = {
    grants,
    verifyOperator: (operatorId) => operatorId === "operator-1",
    clock: () => state.now,
    resolveActor: () => "actor:lead",
    ...overrides
  };
  return { grants, options, state, set: (ms: number) => (state.now = at(ms)) };
}

function setup(
  options: {
    budget?: MissionBudget;
    grant?: boolean;
    definition?: AutonomousAuthorityDefinition;
    policy?: Parameters<MissionAuthorityLedger["grantMissionAuthority"]>[0]["policy"];
    policyApprovedBy?: string;
    store?: CodingMissionStore;
    ledger?: Partial<LedgerOptions>;
  } = {}
) {
  const store = options.store ?? new CodingMissionStore(":memory:");
  store.createGeneral({
    missionId: "m1",
    summary: "s",
    budget: options.budget ?? { ...DEFAULT_DELEGATION_BUDGET },
    now: T0
  });
  store.addWorkUnits(
    "m1",
    [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
    T0
  );
  const h = harness(options.ledger);
  const ledger = new MissionAuthorityLedger(store, h.options);
  h.grants.grants.set("grant-1", makeGrant("m1", options.definition ?? ROOT));
  if (options.grant !== false) {
    ledger.grantMissionAuthority({
      missionId: "m1",
      grantId: "grant-1",
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.policyApprovedBy ? { policyApprovedBy: options.policyApprovedBy } : {})
    });
  }
  const claim = { token: `tok-${(n += 1)}`, workerId: "lead-worker", route: {}, claimedAt: T0 };
  expect(store.claimUnit("m1", "root", claim)).toMatchObject({ ok: true });
  const ask = (
    children: ChildWorkItem[],
    overrides: Partial<Parameters<MissionAuthorityLedger["requestChildWork"]>[0]> = {}
  ) =>
    ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "root",
      workerId: "lead-worker",
      claimToken: claim.token,
      children,
      ...overrides
    });
  return { store, ledger, claim, ask, h };
}

const denied = (result: ReturnType<MissionAuthorityLedger["requestChildWork"]>) => {
  if (result.ok || result.outcome !== "denied") throw new Error(`expected denial, got ${JSON.stringify(result)}`);
  return result.reasons;
};

describe("mission authority (bound to a 047 grant)", () => {
  it("binds a mission to a verified grant, taking the approver and reason from the grant itself", () => {
    const { store, ledger } = setup({ policy: {} });
    expect(ledger.missionAuthority("m1")).toMatchObject({
      grantId: "grant-1",
      approverId: "human-1",
      reason: "approved by operator",
      definition: ROOT
    });
    const granted = store.events("m1").find((event) => event.name === "authority.granted");
    expect(granted?.body).toMatchObject({
      grantId: "grant-1",
      issuedBy: "human-1",
      privileged: ["process.privileged"]
    });
    expect(() => store.db.exec("UPDATE mission_authority SET approver_id = 'x'")).toThrow(/append-only/);
  });

  it("is idempotent for the same grant and refuses to be re-bound to a wider one", () => {
    const { ledger, h } = setup();
    expect(() => ledger.grantMissionAuthority({ missionId: "m1", grantId: "grant-1" })).not.toThrow();
    h.grants.grants.set(
      "grant-2",
      makeGrant("m1", { ...ROOT, maximumPrivileges: [...ROOT.maximumPrivileges, "deploy"] }, "grant-2")
    );
    expect(() => ledger.grantMissionAuthority({ missionId: "m1", grantId: "grant-2" })).toThrow(
      expect.objectContaining({ code: "mission_authority_exists" })
    );
  });

  it("refuses a grant that does not exist, belongs to another mission, fails its hash, or has expired — with durable evidence", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "s", now: T0 });
    const h = harness();
    const ledger = new MissionAuthorityLedger(store, h.options);
    const attempt = (grantId: string) => () => ledger.grantMissionAuthority({ missionId: "m1", grantId });
    expect(attempt("ghost")).toThrow(expect.objectContaining({ code: "mission_authority_unverified" }));
    h.grants.grants.set("other", makeGrant("some-other-mission", ROOT, "other"));
    expect(attempt("other")).toThrow(/another mission/);
    const forged = {
      ...makeGrant("m1", ROOT, "forged"),
      definition: { ...ROOT, maximumPrivileges: ["fs.read" as const, "deploy" as const] }
    };
    h.grants.grants.set("forged", forged);
    expect(attempt("forged")).toThrow(/recorded hash/);
    h.grants.grants.set("old", makeGrant("m1", { ...ROOT, expiresAt: "2026-10-08T00:00:00.000Z" }, "old"));
    expect(attempt("old")).toThrow(/expired/);
    expect(ledger.missionAuthority("m1")).toBeUndefined();
    const reasons = store
      .events("m1")
      .filter((event) => event.name === "authority.denied")
      .map((event) => (event.body as { reason: string }).reason);
    expect(reasons).toEqual(["grant_not_found", "grant_wrong_mission", "grant_hash_mismatch", "authority_expired"]);
  });

  it("needs a verified operator before mission policy may allow privileged children", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "s", now: T0 });
    const h = harness();
    h.grants.grants.set("grant-1", makeGrant("m1"));
    const ledger = new MissionAuthorityLedger(store, h.options);
    const loose = { allowPrivilegedChildren: true };
    expect(() => ledger.grantMissionAuthority({ missionId: "m1", grantId: "grant-1", policy: loose })).toThrow(
      /verified operator/
    );
    expect(() =>
      ledger.grantMissionAuthority({ missionId: "m1", grantId: "grant-1", policy: loose, policyApprovedBy: "stranger" })
    ).toThrow(/verified operator/);
    expect(ledger.missionAuthority("m1")).toBeUndefined();
    expect(
      ledger.grantMissionAuthority({
        missionId: "m1",
        grantId: "grant-1",
        policy: loose,
        policyApprovedBy: "operator-1"
      })
    ).toMatchObject({ policyApprovedBy: "operator-1" });
  });
});

describe("request_child_work", () => {
  it("creates children with strictly narrowed authority and records the derivation and its grant", () => {
    const { store, ledger, ask } = setup();
    const result = ask([
      child("c1", {
        requestedAuthority: narrower({
          scope: [{ kind: "path", id: "/repo/acme/app/src", coverage: "descendants" }],
          maximumPrivileges: ["fs.read"],
          toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }]
        })
      }),
      child("c2", { workType: "coding", payload: { instructions: "do" } })
    ]);
    expect(result).toMatchObject({ ok: true, created: ["c1", "c2"] });
    const c1 = ledger.unitAuthority("m1", "c1")!;
    const c2 = ledger.unitAuthority("m1", "c2")!;
    expect(c1.definition.maximumPrivileges).toEqual(["fs.read"]);
    expect(isSubset(c1.definition, ROOT, NOW())).toBe(true);
    expect(c2.definition.maximumPrivileges).not.toContain("process.privileged");
    expect(c1.derivedFromHash).toBe(ledger.missionAuthority("m1")!.definitionHash);
    expect(c1).toMatchObject({ parentUnitId: "root", purpose: "purpose of c1", grantId: "grant-1" });
    expect(store.workUnits("m1").find((unit) => unit.unitId === "c2")).toMatchObject({ kind: "coding", depth: 1 });
    expect(store.events("m1").map((event) => event.name)).toEqual(
      expect.arrayContaining(["child.requested", "child.admitted"])
    );
  });

  it("derives a grandchild from the child's definition, never the mission's", () => {
    const { store, ledger, ask } = setup();
    ask([
      child("c1", {
        requestedAuthority: narrower({ scope: [{ kind: "path", id: "/repo/acme/app", coverage: "descendants" }] })
      })
    ]);
    store.releaseReadyUnits("m1", at(2000));
    expect(
      store.claimUnit("m1", "c1", { token: "child-token", workerId: "w-c1", route: {}, claimedAt: at(2000) })
    ).toMatchObject({ ok: true });
    const mk = (children: ChildWorkItem[]) =>
      ledger.requestChildWork({
        missionId: "m1",
        parentUnitId: "c1",
        workerId: "w-c1",
        claimToken: "child-token",
        children
      });
    expect(
      mk([
        child("g1", {
          requestedAuthority: narrower({
            scope: [{ kind: "path", id: "/repo/acme/app/lib", coverage: "exact" }],
            maximumPrivileges: ["fs.write"]
          })
        })
      ])
    ).toMatchObject({ ok: true });
    expect(ledger.unitAuthority("m1", "g1")!.derivedFromHash).toBe(ledger.unitAuthority("m1", "c1")!.definitionHash);
    // The child never held /repo/acme/docs, so its own child cannot have it either, though the mission does.
    expect(
      denied(
        mk([
          child("g2", {
            requestedAuthority: narrower({ scope: [{ kind: "path", id: "/repo/acme/docs", coverage: "descendants" }] })
          })
        ])
      )[0]
    ).toMatch(/^g2:escalation:scope path:\/repo\/acme\/docs/);
  });

  it("DENIES a privileged privilege when the parent lacks it, and when policy forbids it even if the parent has it", () => {
    const narrowGrant = setup({ definition: { ...ROOT, maximumPrivileges: ["fs.read", "fs.write"] } });
    expect(
      denied(
        narrowGrant.ask([child("evil", { requestedAuthority: { ...ROOT, maximumPrivileges: ["process.privileged"] } })])
      )[0]
    ).toMatch(/evil:escalation:privilege process.privileged exceeds parent/);
    expect(narrowGrant.store.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
    expect(narrowGrant.store.events("m1").map((event) => event.name)).toEqual(
      expect.arrayContaining(["child.denied", "authority.denied"])
    );

    const { ask, ledger } = setup();
    expect(
      denied(ask([child("p1", { requestedAuthority: { ...ROOT, maximumPrivileges: ["process.privileged"] } })]))
    ).toContain("p1:privileged_child_not_allowed:process.privileged");
    expect(ledger.unitAuthority("m1", "p1")).toBeUndefined();
    const allowed = setup({ policy: { allowPrivilegedChildren: true }, policyApprovedBy: "operator-1" });
    expect(
      allowed.ask([child("p1", { requestedAuthority: { ...ROOT, maximumPrivileges: ["process.privileged"] } })])
    ).toMatchObject({ ok: true });
    expect(allowed.ledger.unitAuthority("m1", "p1")!.definition.maximumPrivileges).toEqual(["process.privileged"]);
  });

  it("is all-or-nothing: one bad child creates none", () => {
    const { store, ask } = setup();
    const result = ask([
      child("ok1"),
      child("bad", {
        requestedAuthority: { ...ROOT, scope: [{ kind: "path", id: "/repo/secrets", coverage: "exact" }] }
      })
    ]);
    expect(denied(result).every((reason) => reason.startsWith("bad:"))).toBe(true);
    expect(store.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
  });

  it("fails when the mission authority has expired, using ACS's clock", () => {
    const { ask, h } = setup();
    h.state.now = "2026-10-09T03:00:00.000Z";
    expect(denied(ask([child("late")]))).toContain("late:authority_expired");
  });

  it("fails for a mission with no authority binding", () => {
    const { ask } = setup({ grant: false });
    expect(denied(ask([child("c1")]))).toEqual(["mission_has_no_authority"]);
  });

  it("fails for the wrong mission, a missing parent, a wrong worker, a stale token, and a parent that is not running", () => {
    const { ask, claim, ledger, store } = setup();
    expect(
      denied(
        ledger.requestChildWork({
          missionId: "nope",
          parentUnitId: "root",
          workerId: "lead-worker",
          claimToken: claim.token,
          children: [child("c")]
        })
      )
    ).toEqual(["mission_not_active"]);
    expect(denied(ask([child("c")], { parentUnitId: "ghost" }))).toEqual(["parent_unit_not_found"]);
    expect(denied(ask([child("c")], { workerId: "impostor" }))).toEqual(["claim_mismatch"]);
    expect(denied(ask([child("c")], { claimToken: "forged" }))).toEqual(["claim_mismatch"]);
    store.failUnit("m1", "root", claim.token, { category: "timeout", retryable: false, now: at(10) });
    expect(denied(ask([child("c")]))).toEqual(["claim_mismatch"]);
    expect(store.workUnits("m1")).toHaveLength(1);
  });

  it("rejects bad requests: no children, too many, duplicate ids, invalid types and purposes", () => {
    const { ask } = setup();
    expect(denied(ask([]))).toEqual(["child_count_invalid"]);
    expect(denied(ask(Array.from({ length: 17 }, (_, i) => child(`k${i}`))))).toEqual(["child_count_invalid"]);
    expect(denied(ask([child("a"), child("a")]))).toContain("a:child_id_invalid_or_duplicate");
    expect(denied(ask([child("b", { workType: "deploy" as never })]))).toContain("b:work_type_invalid");
    expect(denied(ask([child("c", { purpose: "" })]))).toContain("c:purpose_invalid");
    expect(denied(ask([child("bad id!")]))[0]).toMatch(/invalid_unit_id/);
  });
});

describe("delegation caps (durable)", () => {
  it("enforces the total child cap and reports it as an explicit outcome", () => {
    const { ask, store } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxChildWorkUnits: 2 } });
    expect(ask([child("a"), child("b")])).toMatchObject({ ok: true });
    expect(ask([child("c")])).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "child_work_units", limit: 2, projected: 3 })] }
    });
    expect(store.workUnits("m1")).toHaveLength(3);
    expect(store.events("m1").map((event) => event.name)).toEqual(
      expect.arrayContaining(["budget.exhausted", "child.denied"])
    );
  });

  it("enforces the depth cap", () => {
    const { ask, store, ledger } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxChildDepth: 1 } });
    ask([child("c1")]);
    store.releaseReadyUnits("m1", at(1500));
    store.claimUnit("m1", "c1", { token: "ct", workerId: "w", route: {}, claimedAt: at(1500) });
    expect(
      ledger.requestChildWork({
        missionId: "m1",
        parentUnitId: "c1",
        workerId: "w",
        claimToken: "ct",
        children: [child("g1")]
      })
    ).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "child_depth" })] }
    });
  });

  it("enforces the parallel cap when children are claimed", () => {
    const { ask, store } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxParallelWorkUnits: 2 } });
    ask([child("a"), child("b"), child("c")]);
    store.releaseReadyUnits("m1", at(1500));
    expect(store.claimUnit("m1", "a", { token: "ta", workerId: "w", route: {}, claimedAt: at(2000) })).toMatchObject({
      ok: true
    });
    expect(store.claimUnit("m1", "b", { token: "tb", workerId: "w", route: {}, claimedAt: at(2000) })).toMatchObject({
      ok: false,
      outcome: "budget_exhausted"
    });
  });
});

describe("simultaneous requests and restarts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  it("lets two agents race for the last child slot and exactly one wins, across connections and a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-child-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const one = new CodingMissionStore(path);
    const ctx = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxChildWorkUnits: 1 }, store: one });
    const two = new CodingMissionStore(path);
    const second = new MissionAuthorityLedger(two, { ...ctx.h.options });
    const results = [
      ctx.ask([child("race-a")]),
      second.requestChildWork({
        missionId: "m1",
        parentUnitId: "root",
        workerId: "lead-worker",
        claimToken: ctx.claim.token,
        children: [child("race-b")]
      })
    ];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ outcome: "budget_exhausted" });
    one.close();
    const reopened = new CodingMissionStore(path);
    const again = new MissionAuthorityLedger(reopened, { ...ctx.h.options }).requestChildWork({
      missionId: "m1",
      parentUnitId: "root",
      workerId: "lead-worker",
      claimToken: ctx.claim.token,
      children: [child("race-c")]
    });
    expect(again).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    expect(reopened.workUnits("m1").filter((unit) => unit.parentUnitId === "root")).toHaveLength(1);
    two.close();
    reopened.close();
  });
});

describe("cancellation propagation", () => {
  it("cancelling a parent's subtree cancels descendants and reports in-flight ones as uncertain", () => {
    const { ask, store, ledger, claim } = setup();
    ask([child("a"), child("b")]);
    store.releaseReadyUnits("m1", at(1500));
    store.claimUnit("m1", "a", { token: "ta", workerId: "w", route: {}, claimedAt: at(1600) });
    ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "a",
      workerId: "w",
      claimToken: "ta",
      children: [child("a1")]
    });
    const result = ledger.cancelChildren("m1", "root", {
      reason: "parent_failed",
      authorization: { kind: "parent_claim", workerId: "lead-worker", claimToken: claim.token }
    });
    expect(result.cancelled.sort()).toEqual(["a", "a1", "b"]);
    expect(result.uncertain).toEqual(["a"]);
    const units = Object.fromEntries(store.workUnits("m1").map((unit) => [unit.unitId, unit]));
    expect(units.root?.status).toBe("running");
    expect(units.a).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
    expect(units.a1).toMatchObject({ status: "cancelled", cancelExternalState: "none" });
    expect(() => store.completeOperation("m1", "a", "ta", { resultHash: "late", files: [] })).toThrow();
  });

  it("mission cancellation cancels child work as well", () => {
    const { ask, store } = setup();
    ask([child("a"), child("b")]);
    expect(store.cancelMission("m1", { reason: "operator", now: at(3000) })).toMatchObject({ ok: true });
    expect(store.workUnits("m1").every((unit) => unit.status === "cancelled")).toBe(true);
    expect(denied(ask([child("late")]))).toEqual(["mission_not_active"]);
  });

  it("only lets the parent's live claim or a verified operator cancel a subtree", () => {
    const { ask, store, ledger, claim } = setup();
    ask([child("a")]);
    const cancel = (authorization: Parameters<MissionAuthorityLedger["cancelChildren"]>[2]["authorization"]) =>
      ledger.cancelChildren("m1", "root", { reason: "r", authorization });
    expect(() => cancel({ kind: "parent_claim", workerId: "lead-worker", claimToken: "stale" })).toThrow(
      expect.objectContaining({ code: "cancel_not_authorized" })
    );
    expect(() => cancel({ kind: "parent_claim", workerId: "impostor", claimToken: claim.token })).toThrow(
      expect.objectContaining({ code: "cancel_not_authorized" })
    );
    expect(() => cancel({ kind: "operator", operatorId: "nobody" })).toThrow(
      expect.objectContaining({ code: "cancel_not_authorized" })
    );
    expect(store.workUnits("m1").find((unit) => unit.unitId === "a")?.status).toBe("pending");
    expect(store.events("m1").filter((event) => event.name === "authority.denied")).toHaveLength(3);
    expect(cancel({ kind: "operator", operatorId: "operator-1" }).cancelled).toEqual(["a"]);
  });

  it("refuses subtree cancellation by a worker whose claim was superseded", () => {
    const { ask, store, ledger, claim } = setup();
    ask([child("a")]);
    store.failUnit("m1", "root", claim.token, { category: "timeout", retryable: true, now: at(1100) });
    store.retryUnit("m1", "root", at(1200));
    store.claimUnit("m1", "root", { token: "new-token", workerId: "w-new", route: {}, claimedAt: at(1300) });
    expect(() =>
      ledger.cancelChildren("m1", "root", {
        reason: "r",
        authorization: { kind: "parent_claim", workerId: "lead-worker", claimToken: claim.token }
      })
    ).toThrow(expect.objectContaining({ code: "cancel_not_authorized" }));
  });
});

describe("reduction", () => {
  function finish(ctx: ReturnType<typeof setup>, results: Record<string, string | "fail">) {
    ctx.store.releaseReadyUnits("m1", at(1500));
    for (const [unitId, outcome] of Object.entries(results)) {
      const token = `t-${unitId}`;
      ctx.store.claimUnit("m1", unitId, { token, workerId: "w", route: {}, claimedAt: at(1600) });
      if (outcome === "fail")
        ctx.store.failUnit("m1", unitId, token, { category: "tool_failure", retryable: false, now: at(1700) });
      else ctx.store.completeOperation("m1", unitId, token, { resultHash: outcome, files: [] });
    }
  }
  const reduce = (
    ctx: ReturnType<typeof setup>,
    strategy: "all_succeeded" | "select" | "majority_result",
    selectedUnitId?: string
  ) =>
    ctx.ledger.reduceChildren({
      missionId: "m1",
      parentUnitId: "root",
      strategy,
      ...(selectedUnitId ? { selectedUnitId } : {}),
      authorization: { kind: "parent_claim", workerId: "lead-worker", claimToken: ctx.claim.token }
    });

  it("waits while any child is unfinished and writes nothing", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8 } });
    ctx.ask([child("a"), child("b")]);
    finish(ctx, { a: "h1" });
    expect(reduce(ctx, "all_succeeded")).toEqual({ status: "incomplete", waitingOn: ["b"] });
    expect(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_reductions").get()).toEqual({ n: 0 });
  });

  it("reduces deterministically by child id, not by finish order", () => {
    const first = setup({ budget: { maxChildWorkUnits: 8 } });
    first.ask([child("a"), child("b")]);
    finish(first, { a: "h1", b: "h2" });
    const second = setup({ budget: { maxChildWorkUnits: 8 } });
    second.ask([child("a"), child("b")]);
    finish(second, { b: "h2", a: "h1" });
    const one = reduce(first, "all_succeeded");
    const two = reduce(second, "all_succeeded");
    expect(one).toMatchObject({ status: "reduced", recorded: true });
    expect(one).toEqual(two);
  });

  it("fails all_succeeded if any child failed, and never promotes a failed child's result", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8 } });
    ctx.ask([child("a"), child("b")]);
    finish(ctx, { a: "h1", b: "fail" });
    expect(reduce(ctx, "all_succeeded")).toMatchObject({ status: "failed" });
    expect(reduce(ctx, "select", "b")).toMatchObject({ status: "failed", recorded: false });
  });

  it("selects an explicit succeeded child and refuses a failed or unknown one", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8 } });
    ctx.ask([child("a"), child("b")]);
    finish(ctx, { a: "h1", b: "fail" });
    expect(reduce(ctx, "select", "a")).toMatchObject({ status: "reduced", selectedUnitId: "a", resultHash: "h1" });
    const other = setup({ budget: { maxChildWorkUnits: 8 } });
    other.ask([child("a"), child("b")]);
    finish(other, { a: "h1", b: "fail" });
    expect(reduce(other, "select", "b")).toMatchObject({ status: "failed" });
  });

  it("takes a strict majority only, and calls a tie inconclusive instead of breaking it", () => {
    const majority = setup({ budget: { maxChildWorkUnits: 8 } });
    majority.ask([child("a"), child("b"), child("c")]);
    finish(majority, { a: "h1", b: "h1", c: "h2" });
    expect(reduce(majority, "majority_result")).toMatchObject({ status: "reduced", resultHash: "h1" });
    const tie = setup({ budget: { maxChildWorkUnits: 8 } });
    tie.ask([child("a"), child("b")]);
    finish(tie, { a: "h1", b: "h2" });
    expect(reduce(tie, "majority_result")).toMatchObject({ status: "inconclusive" });
  });

  it("is recorded once: a second reduction returns the first and cannot overwrite it", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8 } });
    ctx.ask([child("a"), child("b")]);
    finish(ctx, { a: "h1", b: "h2" });
    const first = reduce(ctx, "all_succeeded");
    const second = reduce(ctx, "select", "b");
    expect(second).toMatchObject({
      status: "reduced",
      recorded: false,
      resultHash: (first as { resultHash: string }).resultHash
    });
    expect(() => ctx.store.db.exec("DELETE FROM work_unit_reductions")).toThrow(/append-only/);
    expect(() => ctx.store.db.exec("UPDATE work_unit_reductions SET outcome = 'failed'")).toThrow(/append-only/);
  });

  it("refuses to reduce a unit with no children", () => {
    const ctx = setup();
    expect(() => reduce(ctx, "all_succeeded")).toThrow(/no child work/);
  });
});

describe("review hardening", () => {
  it("takes time from ACS's clock: a request cannot backdate itself past an expired authority or wall-clock budget", () => {
    const expired = setup();
    expired.h.state.now = "2026-10-09T03:00:00.000Z";
    expect(denied(expired.ask([child("late")], { now: "2026-10-09T00:00:01.000Z" } as never))).toContain(
      "late:authority_expired"
    );
    const wall = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxWallClockMs: 60_000 } });
    wall.h.set(10 * 60_000);
    expect(wall.ask([child("c")], { now: at(1) } as never)).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "wall_clock_ms" })] }
    });
  });

  it("fails closed when the stored definition no longer matches its hash", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: narrower({ maximumPrivileges: ["fs.read"] }) })]);
    store.db.exec("DROP TRIGGER mission_authority_no_update");
    store.db
      .prepare("UPDATE mission_authority SET envelope_json = ? WHERE mission_id = 'm1'")
      .run(JSON.stringify({ ...ROOT, maximumPrivileges: [...ROOT.maximumPrivileges, "deploy"] }));
    expect(() => ledger.missionAuthority("m1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    expect(denied(ask([child("c2")]))).toEqual(["authority_integrity_failure"]);
    expect(
      store
        .workUnits("m1")
        .map((unit) => unit.unitId)
        .sort()
    ).toEqual(["c1", "root"]);
  });

  it("fails closed when the grant it was bound to changes or disappears", () => {
    const { ledger, ask, h } = setup();
    h.grants.grants.set("grant-1", makeGrant("m1", { ...ROOT, maximumPrivileges: ["fs.read"] }));
    expect(() => ledger.missionAuthority("m1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    h.grants.grants.delete("grant-1");
    expect(denied(ask([child("c")]))).toEqual(["authority_integrity_failure"]);
  });

  it("detects a tampered or mis-derived unit definition", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: narrower({ maximumPrivileges: ["fs.read"] }) })]);
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.prepare("UPDATE work_unit_authority SET derived_from_hash = ? WHERE unit_id = 'c1'").run("f".repeat(64));
    expect(() => ledger.unitAuthority("m1", "c1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    store.db
      .prepare("UPDATE work_unit_authority SET envelope_json = ?, derived_from_hash = ? WHERE unit_id = 'c1'")
      .run(
        JSON.stringify({ ...ROOT, maximumPrivileges: ["fs.read", "deploy"] }),
        ledger.missionAuthority("m1")!.definitionHash
      );
    expect(() => ledger.unitAuthority("m1", "c1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
  });

  it("does not persist credential-looking values from denied requests", () => {
    const { ask, store } = setup();
    const secret = "sk-live-0123456789abcdefghijklmnop";
    ask([
      child("c1", {
        requestedAuthority: { ...ROOT, scope: [{ kind: "path", id: `/repo/${secret}`, coverage: "exact" }] }
      })
    ]);
    ask([child("c2", { purpose: "Bearer abcdefghijklmnopqrstuvwxyz0123456789 " + "x".repeat(600) })]);
    const events = JSON.stringify(store.events("m1"));
    expect(events).not.toContain(secret);
    expect(events).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(events).toContain("child.denied");
  });

  it("validates every requested budget dimension against the mission budget", () => {
    const { ask } = setup({
      budget: { ...DEFAULT_DELEGATION_BUDGET, maxWallClockMs: 60_000, maxSpendUsd: 5, maxToolCalls: 10 }
    });
    const reasons = (requestedBudget: MissionBudget) =>
      denied(ask([child(`b${(n += 1)}`, { requestedBudget })])).join();
    expect(reasons({ maxWallClockMs: 120_000 })).toContain("budget_exceeds_mission:wall_clock_ms");
    expect(reasons({ maxParallelWorkUnits: 9 })).toContain("budget_exceeds_mission:parallel_work_units");
    expect(reasons({ maxRetriesPerWorkUnit: 3 })).toContain("budget_exceeds_mission:retries_per_work_unit");
    expect(reasons({ maxSpendUsd: 6 })).toContain("budget_exceeds_mission:spend_micro_usd");
    expect(reasons({ maxToolCalls: -1 })).toContain("budget_invalid");
    expect(reasons({ maxToolCalls: 1.5 })).toContain("budget_invalid");
    expect(reasons({ maxSpendUsd: Number.NaN })).toContain("budget_invalid");
    expect(
      ask([child("fine", { requestedBudget: { maxWallClockMs: 30_000, maxSpendUsd: 1.25, maxRetriesPerWorkUnit: 1 } })])
    ).toMatchObject({ ok: true });
  });

  it("records the verified requester, attempt and a claim fence hash — never the token", () => {
    const { ask, store, claim } = setup();
    ask([child("c1")]);
    const requested = store.events("m1").find((event) => event.name === "child.requested")?.body as {
      requester: Record<string, unknown>;
    };
    expect(requested.requester).toMatchObject({ workerId: "lead-worker", verified: true, parentAttempt: 1 });
    expect(requested.requester.claimFence).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(store.events("m1"))).not.toContain(claim.token);
    expect(denied(ask([child("c2")], { workerId: "impostor" }))).toEqual(["claim_mismatch"]);
    const last = store
      .events("m1")
      .filter((event) => event.name === "child.requested")
      .at(-1)?.body as { requester: Record<string, unknown> };
    expect(last.requester).toMatchObject({ workerId: "impostor", verified: false });
  });

  it("turns invalid payloads and dependencies into durable denials instead of rolling the audit trail back", () => {
    const { ask, store } = setup();
    expect(denied(ask([child("p", { workType: "testing", payload: { argv: [], grant: "admin" } })]))).toContain(
      "p:payload_invalid"
    );
    expect(denied(ask([child("d", { dependsOn: ["ghost"] })]))).toContain("d:dependency_invalid");
    expect(denied(ask([child("x", { dependsOn: ["y"] }), child("y", { dependsOn: ["x"] })])).join()).toMatch(
      /dependency_invalid|work_unit_graph_invalid/u
    );
    const names = store.events("m1").map((event) => event.name);
    expect(names.filter((name) => name === "child.requested")).toHaveLength(3);
    expect(names.filter((name) => name === "child.denied")).toHaveLength(3);
    expect(store.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
  });

  it("denies a unit created outside request_child_work instead of letting it inherit the whole mission", () => {
    const { store, ledger } = setup();
    store.addWorkUnits(
      "m1",
      [{ unitId: "sneaky", kind: "agent", title: "s", parentUnitId: "root", payload: { role: "r", prompt: "p" } }],
      at(1000)
    );
    store.releaseReadyUnits("m1", at(1100));
    store.claimUnit("m1", "sneaky", { token: "sneaky-token", workerId: "w-sneaky", route: {}, claimedAt: at(1200) });
    expect(
      denied(
        ledger.requestChildWork({
          missionId: "m1",
          parentUnitId: "sneaky",
          workerId: "w-sneaky",
          claimToken: "sneaky-token",
          children: [child("grand")]
        })
      )
    ).toEqual(["parent_authority_missing"]);
    expect(store.workUnits("m1").some((unit) => unit.unitId === "grand")).toBe(false);
  });

  it("fingerprints mission policy, so tampering with it after approval is detected", () => {
    const { store, ledger, ask } = setup();
    store.db.exec("DROP TRIGGER mission_authority_no_update");
    store.db.exec(`UPDATE mission_authority SET policy_json = '{"allowPrivilegedChildren":true}'`);
    expect(() => ledger.missionAuthority("m1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    expect(
      denied(ask([child("c", { requestedAuthority: { ...ROOT, maximumPrivileges: ["process.privileged"] } })]))
    ).toEqual(["authority_integrity_failure"]);
  });

  it("rechecks revocation of the backing grant on every request", () => {
    const { store, ask } = setup();
    expect(ask([child("before")])).toMatchObject({ ok: true });
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS autonomous_authority_revocations (grant_id TEXT PRIMARY KEY, actor_id TEXT, reason TEXT, audit_event_id TEXT)"
    );
    store.db.exec("INSERT INTO autonomous_authority_revocations VALUES ('grant-1', 'human-1', 'compromised', 'evt-9')");
    expect(denied(ask([child("after")]))).toEqual(["grant_revoked"]);
    expect(store.workUnits("m1").some((unit) => unit.unitId === "after")).toBe(false);
  });

  it("requires the claimant to be the actor the authority was issued to", () => {
    const { ask } = setup({
      ledger: { resolveActor: (workerId) => (workerId === "lead-worker" ? "actor:someone-else" : undefined) }
    });
    expect(denied(ask([child("c")]))).toEqual(["worker_not_authorized_for_authority"]);
    const unmapped = setup({ ledger: { resolveActor: () => undefined } });
    expect(denied(unmapped.ask([child("c")]))).toEqual(["worker_not_authorized_for_authority"]);
  });

  it("refuses to treat a missing intermediate authority record as a root", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: narrower({ maximumPrivileges: ["fs.read"] }) })]);
    store.releaseReadyUnits("m1", at(1500));
    store.claimUnit("m1", "c1", { token: "ct", workerId: "w", route: {}, claimedAt: at(1600) });
    ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "c1",
      workerId: "w",
      claimToken: "ct",
      children: [child("g1")]
    });
    store.db.exec("DROP TRIGGER work_unit_authority_no_delete");
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.exec("DELETE FROM work_unit_authority WHERE unit_id = 'c1'");
    expect(() => ledger.unitAuthority("m1", "g1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
  });

  it("bounds child titles", () => {
    const { ask, store } = setup();
    expect(denied(ask([child("t1", { title: "x".repeat(161) })]))).toContain("t1:title_invalid");
    expect(denied(ask([child("t2", { title: "" })]))).toContain("t2:title_invalid");
    expect(ask([child("t3", { title: "x".repeat(160) })])).toMatchObject({ ok: true });
    expect(store.workUnits("m1").find((unit) => unit.unitId === "t3")?.title).toHaveLength(160);
  });

  it("cancels failed descendants that a retry could still revive, but leaves final failures alone", () => {
    const { ask, store, ledger, claim } = setup();
    ask([child("soft"), child("hard")]);
    store.releaseReadyUnits("m1", at(1500));
    store.claimUnit("m1", "soft", { token: "ts", workerId: "w", route: {}, claimedAt: at(1600) });
    store.claimUnit("m1", "hard", { token: "th", workerId: "w", route: {}, claimedAt: at(1600) });
    store.failUnit("m1", "soft", "ts", { category: "tool_failure", retryable: false, now: at(1700) });
    store.failUnit("m1", "hard", "th", { category: "policy_denied", retryable: false, now: at(1700) });
    const result = ledger.cancelChildren("m1", "root", {
      reason: "stop",
      authorization: { kind: "parent_claim", workerId: "lead-worker", claimToken: claim.token }
    });
    expect(result.cancelled).toEqual(["soft"]);
    const statuses = Object.fromEntries(store.workUnits("m1").map((unit) => [unit.unitId, unit.status]));
    expect(statuses).toMatchObject({ soft: "cancelled", hard: "failed" });
    expect(store.retryUnit("m1", "soft", at(1800))).toEqual({ ok: false, outcome: "not_retryable" });
  });
});

describe("reduction authority and integrity", () => {
  function reduced() {
    const ctx = setup({ budget: { maxChildWorkUnits: 8 } });
    ctx.ask([child("a"), child("b")]);
    ctx.store.releaseReadyUnits("m1", at(1500));
    for (const [unitId, hash] of [
      ["a", "h1"],
      ["b", "h2"]
    ] as const) {
      ctx.store.claimUnit("m1", unitId, { token: `t-${unitId}`, workerId: "w", route: {}, claimedAt: at(1600) });
      ctx.store.completeOperation("m1", unitId, `t-${unitId}`, { resultHash: hash, files: [] });
    }
    return ctx;
  }
  const own = (ctx: ReturnType<typeof setup>) => ({
    kind: "parent_claim" as const,
    workerId: "lead-worker",
    claimToken: ctx.claim.token
  });

  it("only the parent's live claim or a verified operator may record a reduction, and a refusal is evidence", () => {
    const ctx = reduced();
    const base = { missionId: "m1", parentUnitId: "root", strategy: "select" as const, selectedUnitId: "b" };
    expect(() =>
      ctx.ledger.reduceChildren({
        ...base,
        authorization: { kind: "parent_claim", workerId: "lead-worker", claimToken: "stale" }
      })
    ).toThrow(expect.objectContaining({ code: "reduce_not_authorized" }));
    expect(() =>
      ctx.ledger.reduceChildren({ ...base, authorization: { kind: "operator", operatorId: "nobody" } })
    ).toThrow(expect.objectContaining({ code: "reduce_not_authorized" }));
    expect(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_reductions").get()).toEqual({ n: 0 });
    expect(ctx.store.events("m1").filter((event) => event.name === "authority.denied")).toHaveLength(2);
    expect(ctx.ledger.reduceChildren({ ...base, authorization: own(ctx) })).toMatchObject({
      status: "reduced",
      selectedUnitId: "b",
      recorded: true
    });
  });

  it("makes the reduction final: nothing beneath the parent can be retried afterwards", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8, maxRetriesPerWorkUnit: 3 } });
    ctx.ask([child("a"), child("b")]);
    ctx.store.releaseReadyUnits("m1", at(1500));
    ctx.store.claimUnit("m1", "a", { token: "ta", workerId: "w", route: {}, claimedAt: at(1600) });
    ctx.store.completeOperation("m1", "a", "ta", { resultHash: "h1", files: [] });
    ctx.store.claimUnit("m1", "b", { token: "tb", workerId: "w", route: {}, claimedAt: at(1600) });
    ctx.store.failUnit("m1", "b", "tb", { category: "tool_failure", retryable: false, now: at(1700) });
    expect(
      ctx.ledger.reduceChildren({
        missionId: "m1",
        parentUnitId: "root",
        strategy: "all_succeeded",
        authorization: own(ctx)
      })
    ).toMatchObject({ status: "failed" });
    expect(ctx.store.retryUnit("m1", "b", at(1800))).toEqual({ ok: false, outcome: "not_retryable" });
    expect(ctx.store.workUnits("m1").find((unit) => unit.unitId === "b")?.status).toBe("failed");
  });

  it("waits for a child that is parked as retryable instead of recording a premature result", () => {
    const ctx = setup({ budget: { maxChildWorkUnits: 8, maxRetriesPerWorkUnit: 3 } });
    ctx.ask([child("a")]);
    ctx.store.releaseReadyUnits("m1", at(1500));
    ctx.store.claimUnit("m1", "a", { token: "ta", workerId: "w", route: {}, claimedAt: at(1600) });
    ctx.store.failUnit("m1", "a", "ta", { category: "timeout", retryable: true, now: at(1700) });
    expect(
      ctx.ledger.reduceChildren({
        missionId: "m1",
        parentUnitId: "root",
        strategy: "all_succeeded",
        authorization: own(ctx)
      })
    ).toEqual({
      status: "incomplete",
      waitingOn: ["a"]
    });
  });

  it("verifies a persisted reduction before returning it", () => {
    const ctx = reduced();
    const args = { missionId: "m1", parentUnitId: "root", strategy: "all_succeeded" as const, authorization: own(ctx) };
    expect(ctx.ledger.reduceChildren(args)).toMatchObject({ status: "reduced", recorded: true });
    ctx.store.db.exec("DROP TRIGGER work_unit_reductions_no_update");
    ctx.store.db.exec("UPDATE work_unit_reductions SET outcome = 'reduced', result_hash = 'forged'");
    expect(() => ctx.ledger.reduceChildren(args)).toThrow(expect.objectContaining({ code: "authority_integrity" }));
  });

  it("puts the selected child and result hash in the audit event", () => {
    const ctx = reduced();
    ctx.ledger.reduceChildren({
      missionId: "m1",
      parentUnitId: "root",
      strategy: "select",
      selectedUnitId: "a",
      authorization: own(ctx)
    });
    expect(ctx.store.events("m1").find((event) => event.name === "child.reduced")?.body).toMatchObject({
      outcome: "reduced",
      selectedUnitId: "a",
      resultHash: "h1",
      by: { workerId: "lead-worker" }
    });
  });
});
