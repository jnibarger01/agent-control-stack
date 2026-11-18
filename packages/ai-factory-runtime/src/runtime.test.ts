import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryProposal, factoryMissionSummary, FACTORY_INTENT_VERSION } from "@agent-control-stack/ai-factory";
import { CodingMissionStore } from "@agent-control-stack/coding-mission";
import {
  buildExecutionEnvelope,
  type BuildExecutionEnvelopeInput,
  type CodexSwarmAttemptOutcome,
  type SwarmExecutionEvidence
} from "@agent-control-stack/engine-adapter";
import { dispatchFactoryUnit, type FactoryEngineFactory } from "./dispatch.js";
import { createFactoryGitReader, verifyFactoryResult, type FactoryIndependentVerifier } from "./verify.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  }).trim();
}

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-factory-repo-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "apps/gateway/src/secrets"), { recursive: true });
  writeFileSync(join(dir, "apps/gateway/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "apps/gateway/src/secrets/key.ts"), "export const k = 0;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  return { dir, base };
}

function commit(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "change");
  const head = git(dir, "rev-parse", "HEAD");
  return { head, tree: git(dir, "rev-parse", "HEAD^{tree}") };
}

function intentFor(baseSha: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: FACTORY_INTENT_VERSION,
    orderId: "order_rt",
    objective: "Add a scoped health endpoint with tests",
    repository: "jnibarger01/agent-control-stack",
    baseSha,
    acceptanceCriteria: ["Healthy fixture returns HTTP 200"],
    permittedPaths: ["apps/gateway/src"],
    forbiddenPaths: ["apps/gateway/src/secrets"],
    budget: { maxLanes: 2, maxWallClockMs: 3_600_000, maxSpendMicrousd: 0 },
    delivery: { mode: "draft_pr" },
    ...overrides
  };
}

function mission(baseSha: string, units: { unitId: string; paths: string[] }[]) {
  const root = mkdtempSync(join(tmpdir(), "acs-factory-rt-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new CodingMissionStore(join(root, "control.db"));
  cleanups.push(() => store.close());
  const intent = intentFor(baseSha);
  const proposal = createFactoryProposal(intent);
  const missionId = "factory-" + "a".repeat(48);
  const now = new Date().toISOString();
  store.create({
    missionId,
    repository: "jnibarger01/agent-control-stack",
    baseRef: baseSha,
    baseSha,
    summary: factoryMissionSummary({ orderId: proposal.intent.orderId, intentHash: proposal.intentHash }),
    branch: "acs/mission/" + missionId,
    deploymentRequired: false,
    deploymentAction: "none",
    deploymentImpact: "Draft pull request only.",
    now,
    budget: { maxWallClockMs: 3_600_000, maxParallelWorkUnits: 2 },
    initiatorId: "alice"
  });
  store.addWorkUnits(
    missionId,
    units.map((unit) => ({
      unitId: unit.unitId,
      kind: "coding" as const,
      title: "Implement " + unit.unitId,
      payload: { kind: "coding", files: unit.paths, repository: "jnibarger01/agent-control-stack", baseSha },
      verificationPolicy: "independent" as const
    })),
    now
  );
  for (const unit of units) {
    store.setVerificationRequirement(missionId, unit.unitId, [{ id: "acceptance-1", description: "Healthy fixture returns HTTP 200", expected: "verified" }], now);
  }
  return { store, missionId, intent };
}

function evidenceFor(
  envelope: { acsAttemptId: string; envelopeHash: string; leaseId: string; fencingEpoch: number },
  lanes: { laneId: string; files: string[] }[],
  integration: { head: string; tree: string; diffHash: string; overlaps?: number; order?: string[] } | null,
  overrides: Partial<SwarmExecutionEvidence> = {}
): SwarmExecutionEvidence {
  const now = new Date().toISOString();
  return {
    schemaVersion: "acs.codex-swarm-evidence.v1",
    acsAttemptId: envelope.acsAttemptId,
    envelopeHash: envelope.envelopeHash,
    leaseId: envelope.leaseId,
    fencingEpoch: envelope.fencingEpoch,
    exitStatus: "completed",
    startedAt: now,
    endedAt: now,
    laneResults: lanes.map((lane) => ({
      laneId: lane.laneId,
      ownerProfile: "codex",
      transportId: "codex-exec",
      startedAt: now,
      endedAt: now,
      workerRunStatus: "completed" as const,
      baseSha: "a".repeat(40),
      headSha: integration?.head ?? "b".repeat(40),
      headTreeSha: null,
      commits: [],
      filesChanged: lane.files,
      footprintResult: { ok: true, violations: [] },
      acceptanceResults: [],
      validationResults: [],
      gateVerdict: "PASS" as const,
      secretScanResult: { clean: true, findingCount: 0, coverageNotes: [] },
      blockers: [],
      warnings: []
    })),
    integration: integration
      ? {
          integrationBranch: "acs/integration",
          integratedHeadSha: integration.head,
          integratedTreeSha: integration.tree,
          topologicalOrder: integration.order ?? lanes.map((lane) => lane.laneId),
          overlaps: Array.from({ length: integration.overlaps ?? 0 }, (_, i) => ({ a: "l1", b: "l2", paths: ["f" + i] }))
        }
      : null,
    aggregateVerdict: "PASS",
    swarmInternalRecommendationIdentity: null,
    loopIterationsRun: 0,
    loopStopReason: null,
    evidenceBundle: { auditEventCount: 1, auditLogHash: "0".repeat(64), diffHash: integration?.diffHash ?? "0".repeat(64) },
    ...overrides
  };
}

/** Engine double: signs like the real adapter, returns caller-shaped evidence, exposes the fence it was given. */
function engine(
  shape: (envelope: { acsAttemptId: string; envelopeHash: string; leaseId: string; fencingEpoch: number }) => CodexSwarmAttemptOutcome | SwarmExecutionEvidence,
  during?: (fence: () => boolean) => void
): FactoryEngineFactory {
  return (fence) => ({
    async runAttempt(input: BuildExecutionEnvelopeInput) {
      const envelope = buildExecutionEnvelope(input, "s".repeat(40));
      during?.(fence);
      const result = shape(envelope);
      if ("status" in result) return result;
      return { status: "evidence", envelope, evidence: result, reaped: true };
    }
  });
}

const request = (missionId: string, intent: unknown, unitId = "u1", hostPath = "/tmp/acs-ws") => ({
  missionId,
  unitId,
  intent,
  planId: "plan-1",
  planDigest: "d".repeat(64),
  workspace: { allocationId: "ws-1", hostPath },
  workerId: "worker-1"
});

describe("F6 bounded lane dispatch with authority fencing", () => {
  it("dispatches one claimed attempt and leaves a successful run awaiting independent verification", async () => {
    const { store, missionId, intent } = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src/health.ts"] }]);
    const fenceSeen: boolean[] = [];
    const result = await dispatchFactoryUnit(
      { store, engine: engine((env) => evidenceFor(env, [{ laneId: "l1", files: ["apps/gateway/src/health.ts"] }], null), (fence) => fenceSeen.push(fence())) },
      request(missionId, intent)
    );
    expect(result.status).toBe("awaiting_verification");
    expect(fenceSeen).toEqual([true]);
    expect(store.workUnitClaim(missionId, "u1")?.status).toBe("running");
  });

  it("fences a late result after the claim is revoked mid-run and leaves the unit to its new owner", async () => {
    const { store, missionId, intent } = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    const fenceSeen: boolean[] = [];
    const result = await dispatchFactoryUnit(
      {
        store,
        engine: engine(
          (env) => evidenceFor(env, [{ laneId: "l1", files: ["apps/gateway/src/x.ts"] }], null),
          (fence) => {
            fenceSeen.push(fence());
            store.resetClaim(missionId, "u1");
            fenceSeen.push(fence());
          }
        )
      },
      request(missionId, intent)
    );
    expect(result).toEqual({ status: "fenced", reason: "late_result_fenced" });
    expect(fenceSeen).toEqual([true, false]);
    expect(store.workUnitClaim(missionId, "u1")?.status).not.toBe("succeeded");
  });

  it("runs two units concurrently within the parallel budget and refuses a third claim", async () => {
    const { store, missionId, intent } = mission("a".repeat(40), [
      { unitId: "u1", paths: ["apps/gateway/src/a"] },
      { unitId: "u2", paths: ["apps/gateway/src/b"] },
      { unitId: "u3", paths: ["apps/gateway/src/c"] }
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: FactoryEngineFactory = (fence) => ({
      async runAttempt(input) {
        const envelope = buildExecutionEnvelope(input, "s".repeat(40));
        await gate;
        expect(fence()).toBe(true);
        return { status: "evidence", envelope, evidence: evidenceFor(envelope, [{ laneId: "l1", files: [input.permittedPaths[0] + "/f.ts"] }], null), reaped: true };
      }
    });
    const first = dispatchFactoryUnit({ store, engine: slow }, request(missionId, intent, "u1"));
    const second = dispatchFactoryUnit({ store, engine: slow }, request(missionId, intent, "u2"));
    const third = await dispatchFactoryUnit({ store, engine: slow }, request(missionId, intent, "u3"));
    expect(third).toEqual({ status: "not_claimed", outcome: "budget_exhausted" });
    release();
    expect((await first).status).toBe("awaiting_verification");
    expect((await second).status).toBe("awaiting_verification");
  });

  it("blocks integration on lane overlap or an invalid integration order", async () => {
    const { store, missionId, intent } = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    const overlap = await dispatchFactoryUnit(
      {
        store,
        engine: engine((env) =>
          evidenceFor(env, [{ laneId: "l1", files: ["apps/gateway/src/x.ts"] }, { laneId: "l2", files: ["apps/gateway/src/x.ts"] }], {
            head: "b".repeat(40),
            tree: "c".repeat(40),
            diffHash: "0".repeat(64),
            overlaps: 1
          })
        )
      },
      request(missionId, intent)
    );
    expect(overlap).toMatchObject({ status: "blocked_integration", reason: "lane_overlap" });
    expect(store.workUnitClaim(missionId, "u1")?.status).toBe("conflict");

    const second = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    const disorder = await dispatchFactoryUnit(
      {
        store: second.store,
        engine: engine((env) =>
          evidenceFor(env, [{ laneId: "l1", files: ["apps/gateway/src/x.ts"] }, { laneId: "l2", files: ["apps/gateway/src/y.ts"] }], {
            head: "b".repeat(40),
            tree: "c".repeat(40),
            diffHash: "0".repeat(64),
            order: ["l1", "l1"]
          })
        )
      },
      request(second.missionId, second.intent)
    );
    expect(disorder).toMatchObject({ status: "blocked_integration", reason: "integration_order_invalid" });
  });

  it("refuses out-of-scope files even when every gate says PASS", async () => {
    const { store, missionId, intent } = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src/health"] }]);
    for (const file of ["apps/gateway/src/other.ts", "apps/gateway/src/secrets/key.ts", ".github/workflows/ci.yml"]) {
      const fresh = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src/health"] }]);
      const result = await dispatchFactoryUnit(
        { store: fresh.store, engine: engine((env) => evidenceFor(env, [{ laneId: "l1", files: [file] }], null)) },
        request(fresh.missionId, fresh.intent)
      );
      expect(result).toEqual({ status: "refused", reason: "out_of_scope_files" });
      expect(fresh.store.workUnitClaim(fresh.missionId, "u1")?.status).toBe("failed");
    }
    expect(store.workUnitClaim(missionId, "u1")?.status).toBe("pending");
    void intent;
  });

  it("refuses more lanes than the budget allows, records unknown outcomes as unknown, and rejects a mismatched intent", async () => {
    const lanes = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    const tooMany = await dispatchFactoryUnit(
      {
        store: lanes.store,
        engine: engine((env) =>
          evidenceFor(env, ["l1", "l2", "l3"].map((laneId) => ({ laneId, files: ["apps/gateway/src/" + laneId] })), null)
        )
      },
      request(lanes.missionId, lanes.intent)
    );
    expect(tooMany).toEqual({ status: "refused", reason: "lane_budget_exceeded" });

    const unknown = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    const result = await dispatchFactoryUnit(
      { store: unknown.store, engine: engine(() => ({ status: "unknown", reason: "timeout", reaped: true })) },
      request(unknown.missionId, unknown.intent)
    );
    expect(result).toEqual({ status: "unknown", reason: "timeout" });
    expect(unknown.store.workUnitClaim(unknown.missionId, "u1")?.status).toBe("unknown");

    const mismatch = mission("a".repeat(40), [{ unitId: "u1", paths: ["apps/gateway/src"] }]);
    expect(
      await dispatchFactoryUnit(
        { store: mismatch.store, engine: engine(() => ({ status: "unknown", reason: "x", reaped: true })) },
        request(mismatch.missionId, intentFor("a".repeat(40), { objective: "Different objective here" }))
      )
    ).toEqual({ status: "refused_before_dispatch", reason: "intent_mismatch" });
  });
});

describe("F7 result validation and independent verification", () => {
  const passVerifier: FactoryIndependentVerifier = { id: "claude-verifier", verify: async () => ({ verdict: "PASS", summary: "ok" }) };
  const runner = (code = 0) => ({ run: async () => ({ exitCode: code, output: "" }) });

  async function prepared(options: { files?: Record<string, string>; reported?: string[]; unitPaths?: string[] } = {}) {
    const { dir, base } = repo();
    const files = options.files ?? { "apps/gateway/src/health.ts": "export const ok = true;\n" };
    const { head, tree } = commit(dir, files);
    const diff = execFileSync("git", ["-C", dir, "diff", "--no-renames", "--binary", "--no-color", base, head]);
    const diffHash = createHash("sha256").update(diff).digest("hex");
    const unitPaths = options.unitPaths ?? ["apps/gateway/src/health.ts"];
    const m = mission(base, [{ unitId: "u1", paths: unitPaths }]);
    const reported = options.reported ?? Object.keys(files);
    const dispatched = await dispatchFactoryUnit(
      {
        store: m.store,
        engine: engine((env) => evidenceFor(env, [{ laneId: "l1", files: reported.filter((f) => f.startsWith("apps/gateway/src/health")) }], { head, tree, diffHash }))
      },
      request(m.missionId, m.intent, "u1", dir)
    );
    if (dispatched.status !== "awaiting_verification") throw new Error("dispatch failed: " + JSON.stringify(dispatched));
    const verifyInput = (overrides: Record<string, unknown> = {}) => ({
      missionId: m.missionId,
      unitId: "u1",
      claimToken: dispatched.claimToken,
      intent: m.intent,
      unitPaths,
      acceptanceCommands: [["npm", "test"]],
      envelope: dispatched.envelope,
      evidence: { ...dispatched.evidence, laneResults: dispatched.evidence.laneResults.map((lane) => ({ ...lane, filesChanged: reported })) },
      ...overrides
    });
    return { dir, base, head, tree, diffHash, store: m.store, missionId: m.missionId, git: createFactoryGitReader(dir), verifyInput };
  }

  it("completes the unit only after ACS re-derives tree, diff and scope, re-runs acceptance, and an independent verifier passes", async () => {
    const ctx = await prepared();
    const result = await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(0), verifier: passVerifier }, ctx.verifyInput());
    expect(result).toMatchObject({ status: "verified", files: ["apps/gateway/src/health.ts"], verifierId: "claude-verifier" });
    expect(ctx.store.workUnitClaim(ctx.missionId, "u1")?.status).toBe("succeeded");
  });

  it.each([
    ["a fabricated PASS with the wrong tree", (ctx: Awaited<ReturnType<typeof prepared>>) => {
      const input = ctx.verifyInput();
      return { ...input, evidence: { ...input.evidence, integration: { ...input.evidence.integration!, integratedTreeSha: "e".repeat(40) } } };
    }, "tree_mismatch"],
    ["a corrupted diff/audit hash", (ctx: Awaited<ReturnType<typeof prepared>>) => {
      const input = ctx.verifyInput();
      return { ...input, evidence: { ...input.evidence, evidenceBundle: { ...input.evidence.evidenceBundle, diffHash: "f".repeat(64) } } };
    }, "diff_hash_mismatch"],
    ["a zero-test result", (ctx: Awaited<ReturnType<typeof prepared>>) => ctx.verifyInput({ acceptanceCommands: [] }), "zero_test_result"],
    ["a lane report that hides a changed file", (ctx: Awaited<ReturnType<typeof prepared>>) => {
      const input = ctx.verifyInput();
      return { ...input, evidence: { ...input.evidence, laneResults: input.evidence.laneResults.map((lane) => ({ ...lane, filesChanged: [] })) } };
    }, "reported_files_mismatch"],
    ["an integrated commit that does not exist", (ctx: Awaited<ReturnType<typeof prepared>>) => {
      const input = ctx.verifyInput();
      return { ...input, evidence: { ...input.evidence, integration: { ...input.evidence.integration!, integratedHeadSha: "9".repeat(40) } } };
    }, "integrated_commit_missing"]
  ])("blocks %s", async (_label, mutate, reason) => {
    const ctx = await prepared();
    const result = await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(0), verifier: passVerifier }, mutate(ctx));
    expect(result).toEqual({ status: "rejected", reason });
    expect(ctx.store.workUnitClaim(ctx.missionId, "u1")?.status).toBe("failed");
  });

  it("blocks a malicious 'success, exit 0' report when ACS's own acceptance run fails", async () => {
    const ctx = await prepared();
    expect(await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(1), verifier: passVerifier }, ctx.verifyInput())).toEqual({
      status: "rejected",
      reason: "acceptance_failed"
    });
  });

  it("blocks a divergent independent verifier and refuses a Swarm-derived verifier", async () => {
    const divergent = await prepared();
    const fail: FactoryIndependentVerifier = { id: "claude-verifier", verify: async () => ({ verdict: "FAIL", summary: "criterion unmet" }) };
    expect(await verifyFactoryResult({ store: divergent.store, git: divergent.git, runner: runner(0), verifier: fail }, divergent.verifyInput())).toEqual({
      status: "rejected",
      reason: "verifier_divergent"
    });
    const selfVerify = await prepared();
    const swarm: FactoryIndependentVerifier = { id: "codex-swarm-gate", verify: async () => ({ verdict: "PASS", summary: "" }) };
    expect(await verifyFactoryResult({ store: selfVerify.store, git: selfVerify.git, runner: runner(0), verifier: swarm }, selfVerify.verifyInput())).toEqual({
      status: "rejected",
      reason: "verifier_not_independent"
    });
  });

  it("reports a stale snapshot without accepting or failing when the workspace moved", async () => {
    const ctx = await prepared();
    commit(ctx.dir, { "apps/gateway/src/health.ts": "export const ok = false;\n" });
    expect(await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(0), verifier: passVerifier }, ctx.verifyInput())).toEqual({
      status: "stale",
      reason: "snapshot_stale"
    });
    expect(ctx.store.workUnitClaim(ctx.missionId, "u1")?.status).toBe("running");
  });

  it("rejects a forbidden file in the real diff even if the lane honestly reports it", async () => {
    const ctx = await prepared({
      files: { "apps/gateway/src/health.ts": "x\n", "apps/gateway/src/secrets/key.ts": "leak\n" },
      unitPaths: ["apps/gateway/src/health.ts"]
    });
    expect(await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(0), verifier: passVerifier }, ctx.verifyInput())).toEqual({
      status: "rejected",
      reason: "out_of_scope_files"
    });
  });

  it("does nothing for a claim that has moved on", async () => {
    const ctx = await prepared();
    ctx.store.resetClaim(ctx.missionId, "u1");
    expect(await verifyFactoryResult({ store: ctx.store, git: ctx.git, runner: runner(0), verifier: passVerifier }, ctx.verifyInput())).toEqual({
      status: "stale",
      reason: "claim_not_current"
    });
  });
});
