import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSubsetOf, type AuthorityEnvelope } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET, type MissionBudget } from "./budget.js";
import { MissionAuthorityLedger, type ApprovalVerifier, type ChildWorkItem } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-09T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const ROOT: AuthorityEnvelope = {
  actions: ["fs.read", "fs.write", "shell.exec", "privileged_exec"],
  resources: ["repo/acme/app", "repo/acme/docs"],
  tools: ["read_file", "write_file", "start_process"],
  expiresAt: "2026-10-09T02:00:00.000Z"
};
let n = 0;

/** A mutable ACS clock and a verifier that approves what the test says a human approved. */
function harness(overrides: Partial<ApprovalVerifier> = {}) {
  const state = { now: at(1000) };
  const calls: Array<Parameters<ApprovalVerifier["verifyMissionApproval"]>[0]> = [];
  const approvals: ApprovalVerifier = {
    verifyMissionApproval: (input) => {
      calls.push(input);
      return true;
    },
    verifyOperator: (operatorId) => operatorId === "operator-1",
    ...overrides
  };
  return { approvals, calls, clock: () => state.now, set: (ms: number) => (state.now = at(ms)), state };
}

const child = (unitId: string, overrides: Partial<ChildWorkItem> = {}): ChildWorkItem => ({
  unitId,
  workType: "research",
  purpose: `purpose of ${unitId}`,
  payload: { role: "researcher", prompt: "look into it" },
  ...overrides
});

function setup(
  options: {
    budget?: MissionBudget;
    grant?: boolean;
    policy?: Parameters<MissionAuthorityLedger["grantMissionAuthority"]>[0]["policy"];
    store?: CodingMissionStore;
    verifier?: Partial<ApprovalVerifier>;
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
  const h = harness(options.verifier);
  const ledger = new MissionAuthorityLedger(store, { approvals: h.approvals, clock: h.clock });
  if (options.grant !== false) {
    ledger.grantMissionAuthority({
      missionId: "m1",
      envelope: ROOT,
      ...(options.policy ? { policy: options.policy } : {}),
      approverId: "human-1",
      reason: "approved by operator",
      grantId: "grant-1"
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

describe("mission authority", () => {
  it("is granted once with an approver and reason, audited, and never widened", () => {
    const { store, ledger } = setup();
    expect(ledger.missionAuthority("m1")).toMatchObject({ approverId: "human-1", reason: "approved by operator" });
    const granted = store.events("m1").find((event) => event.name === "authority.granted");
    expect(granted?.body).toMatchObject({ approverId: "human-1", privileged: ["privileged_exec"] });
    // Same grant again is idempotent; a wider one is refused.
    expect(() =>
      ledger.grantMissionAuthority({ missionId: "m1", envelope: ROOT, approverId: "human-1", reason: "again" })
    ).not.toThrow();
    expect(() =>
      ledger.grantMissionAuthority({
        missionId: "m1",
        envelope: { ...ROOT, actions: [...ROOT.actions, "net.fetch"] },
        approverId: "human-1",
        reason: "widen"
      })
    ).toThrow(expect.objectContaining({ code: "mission_authority_exists" }));
    expect(() => store.db.exec("UPDATE mission_authority SET approver_id = 'x'")).toThrow(/append-only/);
  });

  it("refuses an expired envelope, a missing approver or reason, and wildcard actions", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "s", now: T0 });
    const ledger = new MissionAuthorityLedger(store, { approvals: harness().approvals, clock: () => T0 });
    const base = { missionId: "m1", envelope: ROOT, approverId: "h", reason: "r" };
    expect(() =>
      ledger.grantMissionAuthority({ ...base, envelope: { ...ROOT, expiresAt: "2026-10-08T00:00:00Z" } })
    ).toThrow(/authority_expired/);
    expect(() => ledger.grantMissionAuthority({ ...base, approverId: "" })).toThrow(/approver/);
    expect(() => ledger.grantMissionAuthority({ ...base, reason: "" })).toThrow(/reason/);
    expect(() => ledger.grantMissionAuthority({ ...base, envelope: { ...ROOT, actions: ["*"] } })).toThrow(
      /action_invalid/
    );
    expect(ledger.missionAuthority("m1")).toBeUndefined();
  });
});

describe("request_child_work", () => {
  it("creates children with strictly narrowed authority and records the derivation", () => {
    const { store, ledger, ask } = setup();
    const result = ask([
      child("c1", {
        requestedAuthority: { actions: ["fs.read"], resources: ["repo/acme/app/src"], tools: ["read_file"] }
      }),
      child("c2", { workType: "coding", payload: { instructions: "do" } })
    ]);
    expect(result).toMatchObject({ ok: true, created: ["c1", "c2"] });
    const c1 = ledger.unitAuthority("m1", "c1")!;
    const c2 = ledger.unitAuthority("m1", "c2")!;
    expect(c1.envelope).toMatchObject({ actions: ["fs.read"], resources: ["repo/acme/app/src"], tools: ["read_file"] });
    expect(isSubsetOf(c1.envelope, ROOT)).toBe(true);
    expect(isSubsetOf(c2.envelope, ROOT)).toBe(true);
    expect(c2.envelope.actions).not.toContain("privileged_exec");
    expect(c1.derivedFromHash).toBe(ledger.missionAuthority("m1")!.envelopeHash);
    expect(c1).toMatchObject({ parentUnitId: "root", purpose: "purpose of c1" });
    expect(store.workUnits("m1").filter((unit) => unit.parentUnitId === "root")).toHaveLength(2);
    expect(store.workUnits("m1").find((unit) => unit.unitId === "c2")).toMatchObject({ kind: "coding", depth: 1 });
    const names = store.events("m1").map((event) => event.name);
    expect(names).toEqual(expect.arrayContaining(["child.requested", "child.admitted"]));
  });

  it("derives a grandchild from the child's envelope, never the mission's", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: { actions: ["fs.read", "fs.write"], resources: ["repo/acme/app"] } })]);
    const token = "child-token";
    store.releaseReadyUnits("m1", at(2000));
    expect(store.claimUnit("m1", "c1", { token, workerId: "w-c1", route: {}, claimedAt: at(2000) })).toMatchObject({
      ok: true
    });
    const grand = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "c1",
      workerId: "w-c1",
      claimToken: token,
      children: [child("g1", { requestedAuthority: { actions: ["fs.write"], resources: ["repo/acme/app/lib"] } })]
    });
    expect(grand).toMatchObject({ ok: true });
    expect(ledger.unitAuthority("m1", "g1")!.derivedFromHash).toBe(ledger.unitAuthority("m1", "c1")!.envelopeHash);
    // The grandchild may not reach back up for what the child never had.
    const escalate = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "c1",
      workerId: "w-c1",
      claimToken: token,
      children: [child("g2", { requestedAuthority: { actions: ["shell.exec"] } })]
    });
    expect(denied(escalate)).toContain("g2:action_not_in_parent:shell.exec");
  });

  it("DENIES a child that requests privileged_exec when the parent lacks it", () => {
    const store = new CodingMissionStore(":memory:");
    const { ledger, ask } = setup({ store });
    void ledger;
    // Narrow the mission itself: a different mission whose approved authority has no privileged action.
    const other = new CodingMissionStore(":memory:");
    other.createGeneral({ missionId: "m1", summary: "s", budget: { ...DEFAULT_DELEGATION_BUDGET }, now: T0 });
    other.addWorkUnits("m1", [{ unitId: "root", kind: "agent", title: "r", payload: { role: "r", prompt: "p" } }], T0);
    const l2 = new MissionAuthorityLedger(other, { approvals: harness().approvals, clock: () => at(1000) });
    l2.grantMissionAuthority({
      missionId: "m1",
      envelope: { ...ROOT, actions: ["fs.read"] },
      approverId: "h",
      reason: "r"
    });
    other.claimUnit("m1", "root", { token: "t", workerId: "lead-worker", route: {}, claimedAt: T0 });
    const result = l2.requestChildWork({
      missionId: "m1",
      parentUnitId: "root",
      workerId: "lead-worker",
      claimToken: "t",
      children: [child("evil", { requestedAuthority: { actions: ["privileged_exec"] } })]
    });
    expect(denied(result)).toContain("evil:action_not_in_parent:privileged_exec");
    expect(other.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
    expect(other.events("m1").map((event) => event.name)).toEqual(
      expect.arrayContaining(["child.denied", "authority.denied"])
    );
    void ask;
  });

  it("denies privileged_exec even when the parent holds it, unless mission policy allows privileged children", () => {
    const { ask, ledger } = setup();
    expect(denied(ask([child("p1", { requestedAuthority: { actions: ["privileged_exec"] } })]))).toContain(
      "p1:privileged_child_not_allowed:privileged_exec"
    );
    expect(ledger.unitAuthority("m1", "p1")).toBeUndefined();
    const allowed = setup({ policy: { allowPrivilegedChildren: true } });
    expect(allowed.ask([child("p1", { requestedAuthority: { actions: ["privileged_exec"] } })])).toMatchObject({
      ok: true
    });
    expect(allowed.ledger.unitAuthority("m1", "p1")!.envelope.actions).toEqual(["privileged_exec"]);
  });

  it("is all-or-nothing: one bad child creates none", () => {
    const { store, ask } = setup();
    const result = ask([child("ok1"), child("bad", { requestedAuthority: { resources: ["repo/secrets"] } })]);
    expect(denied(result)).toEqual(["bad:resource_not_in_parent:repo/secrets"]);
    expect(store.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
  });

  it("fails when the mission authority has expired", () => {
    const { ask, h } = setup();
    h.state.now = "2026-10-09T03:00:00.000Z";
    expect(denied(ask([child("late")]))).toContain("late:authority_expired");
  });

  it("fails for a mission with no approved authority", () => {
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

  it("rejects a requested child budget that exceeds the mission budget", () => {
    const { ask } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxToolCalls: 10 } });
    expect(denied(ask([child("c", { requestedBudget: { maxToolCalls: 99 } })]))).toContain(
      "c:budget_exceeds_mission:tool_calls"
    );
    expect(ask([child("d", { requestedBudget: { maxToolCalls: 5 } })])).toMatchObject({ ok: true });
  });
});

describe("delegation caps (durable)", () => {
  it("enforces the total child cap and reports it as an explicit outcome", () => {
    const { ask, store } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxChildWorkUnits: 2 } });
    expect(ask([child("a"), child("b")])).toMatchObject({ ok: true });
    const refused = ask([child("c")]);
    expect(refused).toMatchObject({
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
    const deeper = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "c1",
      workerId: "w",
      claimToken: "ct",
      children: [child("g1")]
    });
    expect(deeper).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "child_depth" })] }
    });
  });

  it("enforces the parallel cap when children are claimed", () => {
    const { ask, store } = setup({ budget: { ...DEFAULT_DELEGATION_BUDGET, maxParallelWorkUnits: 2 } });
    ask([child("a"), child("b"), child("c")]);
    store.releaseReadyUnits("m1", at(1500));
    // root already occupies one slot, so exactly one child may start.
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
    const ledgerTwo = new MissionAuthorityLedger(two, { approvals: harness().approvals, clock: () => at(1000) });
    const results = [
      ctx.ask([child("race-a")]),
      ledgerTwo.requestChildWork({
        missionId: "m1",
        parentUnitId: "root",
        workerId: "lead-worker",
        claimToken: ctx.claim.token,
        children: [child("race-b")]
      })
    ];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ outcome: "budget_exhausted" });
    // Reopen: the cap and the stored authority survive a restart.
    one.close();
    const reopened = new CodingMissionStore(path);
    const again = new MissionAuthorityLedger(reopened, {
      approvals: harness().approvals,
      clock: () => at(2000)
    }).requestChildWork({
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
    // A late result from the cancelled child is rejected.
    expect(() => store.completeOperation("m1", "a", "ta", { resultHash: "late", files: [] })).toThrow();
  });

  it("mission cancellation cancels child work as well", () => {
    const { ask, store } = setup();
    ask([child("a"), child("b")]);
    const cancelled = store.cancelMission("m1", { reason: "operator", now: at(3000) });
    expect(cancelled).toMatchObject({ ok: true });
    expect(store.workUnits("m1").every((unit) => unit.status === "cancelled")).toBe(true);
    const parent = ask([child("late")]);
    expect(denied(parent)).toEqual(["mission_not_active"]);
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
      ...(selectedUnitId ? { selectedUnitId } : {})
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
    const result = wall.ask([child("c")], { now: at(1) } as never);
    expect(result).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "wall_clock_ms" })] }
    });
  });

  it("refuses to record authority the control plane has not verified, and shows the verifier the privileged actions", () => {
    const verifier = { verifyMissionApproval: () => false };
    const { ledger, store } = setup({ grant: false, verifier });
    expect(() =>
      ledger.grantMissionAuthority({
        missionId: "m1",
        envelope: ROOT,
        approverId: "forged-human",
        reason: "trust me",
        grantId: "g-fake"
      })
    ).toThrow(expect.objectContaining({ code: "mission_authority_unverified" }));
    expect(ledger.missionAuthority("m1")).toBeUndefined();
    expect(store.events("m1").find((event) => event.name === "authority.denied")?.body).toMatchObject({
      reason: "approval_not_verified"
    });

    const accepting = setup({ grant: false });
    accepting.ledger.grantMissionAuthority({
      missionId: "m1",
      envelope: ROOT,
      approverId: "human-1",
      reason: "ok",
      grantId: "grant-9"
    });
    expect(accepting.h.calls[0]).toMatchObject({
      missionId: "m1",
      approverId: "human-1",
      grantId: "grant-9",
      privilegedActions: ["privileged_exec"],
      envelopeHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("fails closed when persisted authority no longer matches its hash", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: { actions: ["fs.read"] } })]);
    const widened = JSON.stringify({ ...ROOT, actions: [...ROOT.actions, "net.fetch"] });
    store.db.exec("DROP TRIGGER mission_authority_no_update");
    store.db.prepare("UPDATE mission_authority SET envelope_json = ? WHERE mission_id = 'm1'").run(widened);
    expect(() => ledger.missionAuthority("m1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    expect(denied(ask([child("c2")]))).toEqual(["authority_integrity_failure"]);
    expect(
      store
        .workUnits("m1")
        .map((unit) => unit.unitId)
        .sort()
    ).toEqual(["c1", "root"]);
  });

  it("detects a tampered or mis-derived unit envelope", () => {
    const { store, ledger, ask } = setup();
    ask([child("c1", { requestedAuthority: { actions: ["fs.read"] } })]);
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.prepare("UPDATE work_unit_authority SET derived_from_hash = ? WHERE unit_id = 'c1'").run("f".repeat(64));
    expect(() => ledger.unitAuthority("m1", "c1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
    const wide = JSON.stringify({ ...ROOT, actions: ["fs.read", "net.fetch"] });
    store.db
      .prepare("UPDATE work_unit_authority SET envelope_json = ?, derived_from_hash = ? WHERE unit_id = 'c1'")
      .run(wide, ledger.missionAuthority("m1")!.envelopeHash);
    expect(() => ledger.unitAuthority("m1", "c1")).toThrow(expect.objectContaining({ code: "authority_integrity" }));
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

  it("does not persist credential-looking values from denied requests", () => {
    const { ask, store } = setup();
    const secret = "sk-live-0123456789abcdefghijklmnop";
    ask([child("c1", { requestedAuthority: { resources: [`repo/${secret}`] } })]);
    ask([child("c2", { requestedAuthority: { actions: ["Bearer abcdefghijklmnopqrstuvwxyz0123456789"] } })]);
    const events = JSON.stringify(store.events("m1"));
    expect(events).not.toContain(secret);
    expect(events).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(events).toContain("child.denied");
  });

  it("validates every requested budget dimension against the mission budget", () => {
    const cap = { ...DEFAULT_DELEGATION_BUDGET, maxWallClockMs: 60_000, maxSpendUsd: 5, maxToolCalls: 10 };
    const { ask } = setup({ budget: cap });
    const reasons = (requestedBudget: MissionBudget) => denied(ask([child(`b${(n += 1)}`, { requestedBudget })]));
    expect(reasons({ maxWallClockMs: 120_000 }).join()).toContain("budget_exceeds_mission:wall_clock_ms");
    expect(reasons({ maxParallelWorkUnits: 9 }).join()).toContain("budget_exceeds_mission:parallel_work_units");
    expect(reasons({ maxRetriesPerWorkUnit: 3 }).join()).toContain("budget_exceeds_mission:retries_per_work_unit");
    expect(reasons({ maxSpendUsd: 6 }).join()).toContain("budget_exceeds_mission:spend_micro_usd");
    expect(reasons({ maxToolCalls: -1 }).join()).toContain("budget_invalid");
    expect(reasons({ maxToolCalls: 1.5 }).join()).toContain("budget_invalid");
    expect(reasons({ maxSpendUsd: Number.NaN }).join()).toContain("budget_invalid");
    expect(
      ask([child("fine", { requestedBudget: { maxWallClockMs: 30_000, maxSpendUsd: 1.25, maxRetriesPerWorkUnit: 1 } })])
    ).toMatchObject({ ok: true });
  });

  it("records the verified requester, attempt and a claim-token hash — never the token", () => {
    const { ask, store, claim } = setup();
    ask([child("c1")]);
    const requested = store.events("m1").find((event) => event.name === "child.requested")?.body as {
      requester: Record<string, unknown>;
    };
    expect(requested.requester).toMatchObject({ workerId: "lead-worker", verified: true, parentAttempt: 1 });
    expect(requested.requester.claimFence).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(store.events("m1"))).not.toContain(claim.token);
    expect(
      (store.events("m1").find((event) => event.name === "child.admitted")?.body as { requester: unknown }).requester
    ).toMatchObject({ verified: true });
    const rejected = ask([child("c2")], { workerId: "impostor" });
    expect(denied(rejected)).toEqual(["claim_mismatch"]);
    const unverified = store
      .events("m1")
      .filter((event) => event.name === "child.requested")
      .at(-1)?.body as { requester: Record<string, unknown> };
    expect(unverified.requester).toMatchObject({ workerId: "impostor", verified: false });
  });

  it("turns invalid payloads and dependencies into durable denials instead of rolling the audit trail back", () => {
    const { ask, store } = setup();
    const badPayload = ask([child("p", { workType: "testing", payload: { argv: [], grant: "admin" } })]);
    expect(denied(badPayload)).toContain("p:payload_invalid");
    const badDependency = ask([child("d", { dependsOn: ["ghost"] })]);
    expect(denied(badDependency)).toContain("d:dependency_invalid");
    const cyclic = ask([child("x", { dependsOn: ["y"] }), child("y", { dependsOn: ["x"] })]);
    expect(denied(cyclic).join()).toMatch(/work_unit_graph_invalid|dependency_invalid/u);
    const names = store.events("m1").map((event) => event.name);
    expect(names.filter((name) => name === "child.requested")).toHaveLength(3);
    expect(names.filter((name) => name === "child.denied")).toHaveLength(3);
    expect(store.workUnits("m1").map((unit) => unit.unitId)).toEqual(["root"]);
  });

  it("denies a unit created outside request_child_work instead of letting it inherit the whole mission", () => {
    const { store, ledger, ask } = setup();
    store.addWorkUnits(
      "m1",
      [{ unitId: "sneaky", kind: "agent", title: "s", parentUnitId: "root", payload: { role: "r", prompt: "p" } }],
      at(1000)
    );
    store.releaseReadyUnits("m1", at(1100));
    store.claimUnit("m1", "sneaky", { token: "sneaky-token", workerId: "w-sneaky", route: {}, claimedAt: at(1200) });
    const result = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "sneaky",
      workerId: "w-sneaky",
      claimToken: "sneaky-token",
      children: [child("grand")]
    });
    expect(denied(result)).toEqual(["parent_authority_missing"]);
    expect(store.workUnits("m1").some((unit) => unit.unitId === "grand")).toBe(false);
    void ask;
  });
});
