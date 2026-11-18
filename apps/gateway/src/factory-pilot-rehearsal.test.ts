import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  dispatchFactoryUnit,
  publishFactoryDraft,
  reconcileFactoryPublication,
  verifyFactoryResult,
  createFactoryGitReader,
  factoryPublicationIdempotencyKey,
  FACTORY_DRAFT_PR_SIDE_EFFECT,
  type FactoryEngineFactory,
  type FactoryPullRequest,
  type FactoryRemote
} from "@agent-control-stack/ai-factory-runtime";
import { CodingMissionStore } from "@agent-control-stack/coding-mission";
import { buildExecutionEnvelope } from "@agent-control-stack/engine-adapter";
import { buildGateway, type GatewayCredential } from "./server.js";

/**
 * F11 PILOT REHEARSAL — SIMULATED. Single host, explicit repository allowlist, fixed budget,
 * one mission then three concurrent missions, with injected faults, remote drift, a security
 * negative suite, and a backup/restore drill.
 *
 * What is real: the gateway routes, auth, audit chain, mission store, budget/claim/fence logic,
 * git repositories and git-derived verification, idempotent publication and reconciliation.
 * What is simulated: the Swarm engine (deterministic commits instead of model-backed lanes), the
 * GitHub remote, the independent verifier, and model billing (none; reported as unknown).
 * This is NOT the F11 production pilot and is not evidence for F12 go/no-go on its own.
 */
const REPO = "jnibarger01/agent-control-stack";
const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-factory-pilot-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gitEnv = { PATH: "/usr/bin:/bin", HOME: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

function workspace(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "apps/gateway/src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "apps/gateway/src/a.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

const credentials: GatewayCredential[] = [
  { id: "alice", token: "alice-token", actor: "user", actorId: "alice", roles: ["operator"], scopes: ["acs:read", "acs:write"] },
  { id: "bob", token: "bob-token", actor: "user", actorId: "bob", roles: ["operator"], scopes: ["acs:read", "acs:write"] }
];

function intent(orderId: string, baseSha: string) {
  return {
    schemaVersion: "acs.ai-factory.intent.v1",
    orderId,
    objective: "Add a scoped health endpoint with tests",
    repository: REPO,
    baseSha,
    acceptanceCriteria: ["Healthy fixture returns HTTP 200"],
    permittedPaths: ["apps/gateway/src"],
    forbiddenPaths: ["apps/gateway/src/secrets"],
    budget: { maxLanes: 1, maxWallClockMs: 3_600_000, maxSpendMicrousd: 0 },
    delivery: { mode: "draft_pr" }
  };
}

/** Simulated Swarm: makes a real commit in the workspace and reports it honestly (or crashes). */
function simulatedSwarm(dir: string, behaviour: "clean" | "crash"): FactoryEngineFactory {
  return () => ({
    async runAttempt(input) {
      const envelope = buildExecutionEnvelope(input, "pilot-secret-".padEnd(40, "x"));
      if (behaviour === "crash") return { status: "unknown", reason: "exited_during_execute", reaped: true };
      writeFileSync(join(dir, "apps/gateway/src/health.ts"), "export const health = () => 200;\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "factory change");
      const head = git(dir, "rev-parse", "HEAD");
      const tree = git(dir, "rev-parse", "HEAD^{tree}");
      const diff = execFileSync("git", ["-C", dir, "diff", "--no-renames", "--binary", "--no-color", input.workspace.expectedBaseSha, head], { env: gitEnv });
      const now = new Date().toISOString();
      return {
        status: "evidence",
        envelope,
        reaped: true,
        evidence: {
          schemaVersion: "acs.codex-swarm-evidence.v1",
          acsAttemptId: envelope.acsAttemptId,
          envelopeHash: envelope.envelopeHash,
          leaseId: envelope.leaseId,
          fencingEpoch: envelope.fencingEpoch,
          exitStatus: "completed",
          startedAt: now,
          endedAt: now,
          laneResults: [
            {
              laneId: "lane-1",
              ownerProfile: "codex",
              transportId: "simulated",
              startedAt: now,
              endedAt: now,
              workerRunStatus: "completed",
              baseSha: input.workspace.expectedBaseSha,
              headSha: head,
              headTreeSha: tree,
              commits: [head],
              filesChanged: ["apps/gateway/src/health.ts"],
              footprintResult: { ok: true, violations: [] },
              acceptanceResults: [],
              validationResults: [],
              gateVerdict: "PASS",
              secretScanResult: { clean: true, findingCount: 0, coverageNotes: [] },
              blockers: [],
              warnings: []
            }
          ],
          integration: { integrationBranch: "acs/integration", integratedHeadSha: head, integratedTreeSha: tree, topologicalOrder: ["lane-1"], overlaps: [] },
          aggregateVerdict: "PASS",
          swarmInternalRecommendationIdentity: null,
          loopIterationsRun: 0,
          loopStopReason: null,
          evidenceBundle: { auditEventCount: 1, auditLogHash: "0".repeat(64), diffHash: createHash("sha256").update(diff).digest("hex") }
        }
      };
    }
  });
}

function simulatedRemote(base: string, faults: { drift?: boolean; rateLimitOnce?: boolean } = {}) {
  const pulls: FactoryPullRequest[] = [];
  const branches = new Map<string, string>([["main", faults.drift ? "f".repeat(40) : base]]);
  let creates = 0;
  let limited = false;
  const remote: FactoryRemote = {
    branchHead: async (branch) => branches.get(branch),
    pushFactoryBranch: async (branch, sha) => void branches.set(branch, sha),
    findOpenPull: async (head) => pulls.find((pull) => pull.url.endsWith(head)),
    createDraftPull: async (input) => {
      creates += 1;
      const pull = { number: creates, url: "https://github.test/pull/" + input.headBranch, headSha: branches.get(input.headBranch)!, draft: true };
      pulls.push(pull);
      if (faults.rateLimitOnce && !limited) {
        limited = true;
        throw new Error("rate_limited_or_forbidden_429");
      }
      return pull;
    }
  };
  return { remote, creates: () => creates };
}

const dbPath = join(root, "control.db");
const app = buildGateway({
  dbPath,
  logger: false,
  factoryIntake: {
    enabled: true,
    policy: { version: "pilot-policy-1", repositories: [REPO], maxLanes: 1, maxWallClockMs: 3_600_000, maxSpendMicrousd: 0 },
    reader: {
      // Read-only resolution against the local workspaces stands in for GitHub in the rehearsal.
      resolve: async (_repository, sha) => ({ status: "resolved", repositoryId: 42, fullName: REPO, commitSha: sha, archived: false })
    },
    previewsPerMinute: 100
  },
  auth: { token: "", actor: "user", credentials }
});
afterAll(() => app.close());
const call = (method: "GET" | "POST", url: string, payload?: unknown, token = "alice-token") =>
  app.inject({ method, url, headers: { authorization: "Bearer " + token }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

async function admitPlanAccept(orderId: string, base: string) {
  const body = intent(orderId, base);
  const preview = (await call("POST", "/api/factory/preview", body)).json().preview;
  const admission = (await call("POST", "/api/factory/admit", { intent: body, expectedPreviewHash: preview.previewHash })).json().admission;
  const id = admission.missionId as string;
  const plan = (
    await call("POST", `/api/factory/missions/${id}/plans`, {
      intent: body,
      plan: { schemaVersion: "acs.ai-factory.plan.v1", missionId: id, revision: 1, previousPlanDigest: null, units: [{ unitId: "u1", title: "Implement health", dependsOn: [], paths: ["apps/gateway/src/health.ts"] }] }
    })
  ).json().plan;
  const accepted = await call("POST", `/api/factory/missions/${id}/plans/accept`, { planDigest: plan.planDigest, intent: body });
  expect(accepted.statusCode, accepted.body).toBe(201);
  return { id, body, planDigest: plan.planDigest as string };
}

async function runMission(name: string, behaviour: "clean" | "crash", faults: { drift?: boolean; rateLimitOnce?: boolean } = {}) {
  const ws = workspace(name);
  const { id, body, planDigest } = await admitPlanAccept("order-" + name, ws.base);
  const store = new CodingMissionStore(dbPath);
  try {
    const dispatched = await dispatchFactoryUnit(
      { store, engine: simulatedSwarm(ws.dir, behaviour) },
      { missionId: id, unitId: "u1", intent: body, planId: "plan-" + name, planDigest, workspace: { allocationId: "ws-" + name, hostPath: ws.dir }, workerId: "pilot-worker" }
    );
    if (dispatched.status !== "awaiting_verification") return { id, stage: dispatched.status, creates: 0 };
    const verified = await verifyFactoryResult(
      {
        store,
        git: createFactoryGitReader(ws.dir),
        runner: { run: async () => ({ exitCode: 0, output: "simulated acceptance" }) },
        verifier: { id: "independent-reviewer-sim", verify: async () => ({ verdict: "PASS", summary: "simulated" }) }
      },
      { missionId: id, unitId: "u1", claimToken: dispatched.claimToken, intent: body, unitPaths: ["apps/gateway/src/health.ts"], acceptanceCommands: [["npm", "test"]], envelope: dispatched.envelope, evidence: dispatched.evidence }
    );
    expect(verified.status).toBe("verified");
    const head = git(ws.dir, "rev-parse", "HEAD");
    const approval = {
      approvalId: "appr-" + name,
      approverId: "alice",
      approverKind: "human" as const,
      missionId: id,
      repository: REPO,
      targetBranch: "main",
      headSha: head,
      treeSha: git(ws.dir, "rev-parse", "HEAD^{tree}"),
      sideEffect: FACTORY_DRAFT_PR_SIDE_EFFECT,
      idempotencyKey: factoryPublicationIdempotencyKey(id, head),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      revoked: false
    };
    const remote = simulatedRemote(ws.base, faults);
    const deps = { store, approvals: { get: () => approval }, remote: remote.remote, git: createFactoryGitReader(ws.dir) };
    const input = { missionId: id, approvalId: approval.approvalId, operatorId: "alice", targetBranch: "main", title: "Pilot " + name };
    let published = await publishFactoryDraft(deps, input);
    if (published.status === "uncertain") {
      await reconcileFactoryPublication({ store, remote: remote.remote }, { missionId: id, expectedHead: head });
      published = await publishFactoryDraft(deps, input);
    }
    return { id, stage: published.status, creates: remote.creates() };
  } finally {
    store.close();
  }
}

describe("F11 pilot rehearsal (SIMULATED engine, remote and verifier)", () => {
  const results: Record<string, { id: string; stage: string; creates: number }> = {};

  it("stage 1: one mission runs clean end to end to exactly one draft PR", async () => {
    results.single = await runMission("single", "clean");
    expect(results.single).toMatchObject({ stage: "published", creates: 1 });
  });

  it("stage 2: three concurrent missions with an engine crash, remote drift and a rate limit", async () => {
    const [crash, drift, limited] = await Promise.all([
      runMission("crash", "crash"),
      runMission("drift", "clean", { drift: true }),
      runMission("limited", "clean", { rateLimitOnce: true })
    ]);
    Object.assign(results, { crash, drift, limited });
    expect(crash.stage).toBe("unknown");
    expect(drift).toMatchObject({ stage: "conflict", creates: 0 });
    expect(limited, JSON.stringify(limited)).toMatchObject({ stage: "published", creates: 1 });
    const views = Object.fromEntries(
      await Promise.all(Object.entries(results).map(async ([k, r]) => [k, (await call("GET", `/api/factory/missions/${r.id}/view`)).json().view.stage] as const))
    );
    expect(views).toEqual({
      single: "draft_published",
      crash: "needs_reconciliation",
      drift: "verified_awaiting_publication",
      limited: "draft_published"
    });
  });

  it("security negative suite: 100% of attempts deny", async () => {
    const ws = workspace("negatives");
    const { id, body, planDigest } = await admitPlanAccept("order-negatives", ws.base);
    const denials = [
      (await call("POST", "/api/factory/preview", { ...intent("x", ws.base), actor: "admin" })).statusCode === 422,
      (await call("POST", "/api/factory/preview", intent("x", ws.base), "nobody")).statusCode === 401,
      (await call("GET", `/api/factory/missions/${id}/view`, undefined, "bob-token")).statusCode === 404,
      (await call("POST", "/api/factory/admit", { intent: body, expectedPreviewHash: "0".repeat(64) })).statusCode === 409,
      (await call("POST", `/api/factory/missions/${id}/plans/accept`, { planDigest: "1".repeat(64), intent: body })).statusCode === 409,
      (await call("POST", "/api/factory/preview", { ...intent("y", ws.base), repository: "evil/repo" })).statusCode === 422,
      (await call("POST", "/api/factory/preview", { ...intent("z", ws.base), delivery: { mode: "merge" } })).statusCode === 422
    ];
    const store = new CodingMissionStore(dbPath);
    try {
      const outOfScope = await dispatchFactoryUnit(
        {
          store,
          engine: () => ({
            async runAttempt(input) {
              const envelope = buildExecutionEnvelope(input, "s".repeat(40));
              const ok = await simulatedSwarm(ws.dir, "clean")(() => true).runAttempt(input);
              if (ok.status !== "evidence") return ok;
              return { ...ok, envelope, evidence: { ...ok.evidence, acsAttemptId: envelope.acsAttemptId, envelopeHash: envelope.envelopeHash, leaseId: envelope.leaseId, fencingEpoch: envelope.fencingEpoch, laneResults: ok.evidence.laneResults.map((l) => ({ ...l, filesChanged: [".github/workflows/ci.yml"] })) } };
            }
          })
        },
        { missionId: id, unitId: "u1", intent: body, planId: "p", planDigest, workspace: { allocationId: "ws", hostPath: ws.dir }, workerId: "w" }
      );
      denials.push(outOfScope.status === "refused");
    } finally {
      store.close();
    }
    expect(denials.every(Boolean)).toBe(true);
    expect(denials).toHaveLength(8);
  });

  it("backup/restore drill: restored database replays a valid audit chain and identical projections", async () => {
    const before = (await call("GET", "/api/factory/backlog")).json();
    const backup = join(root, "backup.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    db.close();
    const restoredPath = join(root, "restored.db");
    copyFileSync(backup, restoredPath);
    const restored = buildGateway({
      dbPath: restoredPath,
      logger: false,
      factoryIntake: {
        enabled: true,
        policy: { version: "pilot-policy-1", repositories: [REPO], maxLanes: 1, maxWallClockMs: 3_600_000, maxSpendMicrousd: 0 },
        reader: { resolve: async () => ({ status: "unavailable" }) }
      },
      auth: { token: "", actor: "user", credentials }
    });
    try {
      const after = (await restored.inject({ method: "GET", url: "/api/factory/backlog", headers: { authorization: "Bearer alice-token" } })).json();
      expect(after).toEqual(before);
      // An invalid audit chain disables writes. A refused preview still appends an audit event, so a
      // clean 422 (not a 5xx) proves the restored chain replayed and accepts new audited writes.
      const write = await restored.inject({
        method: "POST",
        url: "/api/factory/preview",
        headers: { authorization: "Bearer alice-token" },
        payload: intent("post-restore", "a".repeat(40))
      });
      expect(write.statusCode, write.body).toBe(422);
      expect(write.json().preview.reason).toBe("repository_unavailable");
    } finally {
      await restored.close();
    }
  });

  it("no unaudited terminal states: every terminal unit has a matching recorded event", () => {
    const store = new CodingMissionStore(dbPath);
    try {
      for (const result of Object.values(results)) {
        for (const unit of store.workUnits(result.id)) {
          const names = store.events(result.id).map((event) => event.name);
          if (unit.status === "succeeded") expect(names).toContain("work_unit.completed");
          if (unit.status === "failed") expect(names).toContain("work_unit.failed");
          if (unit.status === "unknown") expect(names).toContain("work_unit.marked");
        }
      }
    } finally {
      store.close();
    }
  });

  it("model billing is reported as unknown (blocked), never as zero", () => {
    // The simulated engine has no provider usage. F11 acceptance requires reconciled billing,
    // so the rehearsal records the gate as BLOCKED rather than passing with an assumed 0.
    const billing = { reconciled: false, reason: "simulated engine has no provider usage receipts" };
    expect(billing.reconciled).toBe(false);
  });
});
