import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { codingMissionPortsFromEnv } from "./default-runtime.js";
import {
  CodingMissionController,
  CodingMissionStore,
  routeCodingOperationWithNimble,
  type CodingMissionPorts,
  type ExternalOutcome
} from "./index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const NOW = "2026-10-02T12:00:00.000Z";

function agent(id: string): RegistryAgentDetail {
  return {
    id,
    name: id,
    kind: "coding",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    createdAt: NOW,
    updatedAt: NOW,
    createdByActorId: "system",
    updatedByActorId: "system",
    lastHeartbeatAt: NOW,
    capabilities: [
      {
        id: `${id}-cap`,
        agentId: id,
        name: "repository_write",
        createdAt: NOW,
        updatedAt: NOW,
        createdByActorId: "system",
        updatedByActorId: "system"
      }
    ]
  };
}

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

interface Script {
  ports: CodingMissionPorts;
  calls: {
    execute: number;
    publish: number;
    merge: number;
    deploy: number;
    verify: number;
    prCreates: number;
  };
  dbPath: string;
  pr: { prNumber: number; prUrl: string; headSha: string } | undefined;
  observeOperation: ExternalOutcome<{ resultHash: string; files: string[] }>;
  publishOutcome: ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }> | undefined;
  mergeOutcome: ExternalOutcome<{ mergeSha: string; alreadyMerged?: boolean }> | undefined;
  deployOutcome: ExternalOutcome<{ deploymentId: string }> | undefined;
  baseSha: string;
  admission: "allow" | "policy" | "capacity";
  verificationPassed: boolean;
  conflicts: string[];
  operations: Array<{ operationId: string; dependsOn: string[]; title: string }>;
  grantId?: string;
}

function script(root: string, patch: Partial<Script> = {}): Script {
  const calls = { execute: 0, publish: 0, merge: 0, deploy: 0, verify: 0, prCreates: 0 };
  const state: Script = {
    calls,
    dbPath: join(root, "control.db"),
    pr: undefined,
    observeOperation: { status: "absent" },
    publishOutcome: undefined,
    mergeOutcome: undefined,
    deployOutcome: undefined,
    baseSha: BASE,
    admission: "allow",
    verificationPassed: true,
    conflicts: [],
    operations: [
      { operationId: "edit-api", dependsOn: [], title: "edit api" },
      { operationId: "edit-docs", dependsOn: ["edit-api"], title: "edit docs" }
    ],
    ports: undefined as unknown as CodingMissionPorts
  };
  Object.assign(state, patch);
  state.ports = {
    now: () => NOW,
    deploymentPolicy: {
      requirement: () => ({ required: true, action: "restart", impact: "gateway restart" })
    },
    planner: { decompose: () => state.operations },
    router: {
      route: async () => ({
        workerId: "semantic-winner",
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: "semantic-winner" }
      })
    },
    coder: {
      execute: async ({ operationId }) => {
        calls.execute += 1;
        return ok({ resultHash: `result-${operationId}`, files: [`${operationId}.ts`] });
      },
      observe: async () => state.observeOperation
    },
    reconciler: {
      reconcile: async () =>
        state.conflicts.length
          ? ok({ headSha: HEAD, conflicts: state.conflicts })
          : ok({ headSha: HEAD, conflicts: [] })
    },
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
      publish: async () => {
        calls.publish += 1;
        if (state.publishOutcome) return state.publishOutcome;
        if (!state.pr) {
          calls.prCreates += 1;
          state.pr = { prNumber: 123, prUrl: "https://example.test/pull/123", headSha: HEAD };
        }
        return ok(state.pr);
      },
      observe: async () => (state.pr ? ok(state.pr) : { status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => state.baseSha },
    admission: {
      acquire: async () => {
        if (state.admission === "policy") return { denied: "policy", code: "policy_denied" };
        if (state.admission === "capacity") return { denied: "capacity", code: "admission_deferred" };
        return { permitId: "permit-1" };
      }
    },
    merger: {
      merge: async () => {
        calls.merge += 1;
        if (state.mergeOutcome) return state.mergeOutcome;
        return ok({ mergeSha: MERGE });
      },
      observe: async () => (state.mergeOutcome?.status === "succeeded" ? state.mergeOutcome : { status: "absent" })
    },
    deployer: {
      deploy: async () => {
        calls.deploy += 1;
        if (state.deployOutcome) return state.deployOutcome;
        return ok({ deploymentId: "deploy-1" });
      },
      observe: async () => (state.deployOutcome?.status === "succeeded" ? state.deployOutcome : { status: "absent" })
    },
    verifier: {
      verify: async () => {
        calls.verify += 1;
        return { passed: state.verificationPassed, checks: { merge: state.verificationPassed ? "PASS" : "FAIL" } };
      }
    },
    authorityGrant: {
      covers: (_mission, hash) => (state.grantId && hash ? { grantId: state.grantId } : undefined)
    },
    ...patch.ports
  };
  return state;
}

function controller(state: Script, store?: CodingMissionStore): CodingMissionController {
  return new CodingMissionController(store ?? state.dbPath, state.ports);
}

describe("coding mission controller", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("prepares one change set and does not merge before approval", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root);
    const mission = controller(state);
    mission.create({
      missionId: "mission-1",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Ship the fix"
    });
    const waiting = await mission.runUntilStable("mission-1");
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(waiting.changeSetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.calls.merge).toBe(0);
    expect(state.calls.deploy).toBe(0);
    expect(state.calls.prCreates).toBe(1);
    expect(state.calls.execute).toBe(2);
    const view = mission.approvalView("mission-1");
    expect(view.approvalAction).toBe("APPROVE_CHANGE_SET");
    expect(view.pullRequest).toEqual({ number: 123, url: "https://example.test/pull/123" });
    expect(view.checks.tests).toBe("PASS");
    expect(view.deploymentImpact).toBe("gateway restart");
    expect(view.files).toEqual(["edit-api.ts", "edit-docs.ts"]);
    mission.close();
  });

  it("skips completed work, routes with Nimble, and rejects a self-assigned algorithm", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, {
      operations: [
        { operationId: "edit-api", dependsOn: [], title: "edit api" },
        { operationId: "edit-docs", dependsOn: [], title: "edit docs" }
      ]
    });
    const mission = controller(state);
    mission.create({
      missionId: "mission-route",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Route"
    });
    await mission.advance("mission-route");
    const routed = await routeCodingOperationWithNimble(
      {
        agents: [agent("heuristic-winner"), agent("semantic-winner")],
        requiredCapabilities: ["repository_write"],
        taskType: "coding",
        freeCapacity: { "heuristic-winner": 1, "semantic-winner": 1 },
        now: new Date(NOW),
        stateForAgent: (candidate) => ({
          title: "Route",
          intent: "edit",
          requestedActionKinds: ["repository_write"],
          requestedActionDescriptions: ["edit"],
          targetServices: [],
          targetRepositories: ["example/repo"],
          candidateAgentId: candidate.id,
          candidateRole: "IMPLEMENTATION_AGENT",
          candidateDescription: "coding",
          candidateCapabilities: ["repository_write"]
        })
      },
      {
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as { state: { candidate_agent_id: string } };
          const score = request.state.candidate_agent_id === "semantic-winner" ? 0.96 : 0.81;
          return new Response(
            JSON.stringify({ model: "nimble:latest", answers: { appropriate: { type: "noul", noul: score } } }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
      }
    );
    expect(routed.workerId).toBe("semantic-winner");
    state.ports.router.route = async () => ({ workerId: "local", algorithm: "worker-self-assign", decision: {} });
    await expect(mission.advance("mission-route")).rejects.toThrow(/Nimble/);
    mission.close();
  });

  it("reconciles an unknown operation without a second execution when the result is observed", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    const mission = controller(state);
    mission.create({
      missionId: "mission-restart",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Restart"
    });
    state.ports.coder.execute = async () => {
      state.calls.execute += 1;
      return { status: "unknown" };
    };
    await mission.advance("mission-restart");
    const unknown = await mission.advance("mission-restart");
    expect(unknown.code).toBe("unknown_operation");
    expect(state.calls.execute).toBe(1);
    state.observeOperation = ok({ resultHash: "result-edit-api", files: ["edit-api.ts"] });
    const resumed = controller(state);
    const next = await resumed.advance("mission-restart");
    expect(next.code).toBe("operation_reconciled");
    expect(state.calls.execute).toBe(1);
    mission.close();
    resumed.close();
  });

  it("stops on conflicting edits instead of guessing", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    state.ports.coder.execute = async () => ({ status: "rejected", code: "conflict" });
    const mission = controller(state);
    mission.create({
      missionId: "mission-conflict",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Conflict"
    });
    const result = await mission.runUntilStable("mission-conflict");
    expect(result.state).toBe("DEGRADED");
    expect(result.code).toBe("reconciliation_required");
    expect(state.calls.merge).toBe(0);
    mission.close();
  });

  it("reuses one pull request after an unknown publish and across concurrent publishers", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    state.publishOutcome = { status: "unknown" };
    const mission = controller(state);
    mission.create({
      missionId: "mission-pr",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "PR"
    });
    const unknown = await mission.runUntilStable("mission-pr");
    expect(unknown.state).toBe("PUBLISHING_PROPOSAL");
    expect(unknown.code).toBe("unknown_pr");
    state.publishOutcome = undefined;
    state.pr = { prNumber: 7, prUrl: "https://example.test/pull/7", headSha: HEAD };
    const resumed = controller(state);
    const waiting = await resumed.runUntilStable("mission-pr");
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(state.calls.prCreates).toBe(0);
    expect(resumed.approvalView("mission-pr").pullRequest?.number).toBe(7);
    const other = controller(state);
    await other.advance("mission-pr");
    expect(state.calls.prCreates).toBe(0);
    mission.close();
    resumed.close();
    other.close();
  });

  it("rejects a changed proposal and then executes exactly once after a fresh approval", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    const mission = controller(state);
    mission.create({
      missionId: "mission-approve",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Approve"
    });
    const waiting = await mission.runUntilStable("mission-approve");
    expect(state.calls.merge).toBe(0);
    await expect(
      mission.approve("mission-approve", { approverId: "human", expectedChangeSetHash: "f".repeat(64) })
    ).rejects.toThrow(/immutable change set/);
    state.ports.onTransition = () => {
      mission.store.db
        .prepare("UPDATE coding_missions SET head_sha = ? WHERE mission_id = ?")
        .run("d".repeat(40), "mission-approve");
    };
    const stale = await mission.approve("mission-approve", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(stale.state).toBe("DEGRADED");
    expect(stale.code).toBe("stale_approval");
    expect(state.calls.merge).toBe(0);
    mission.close();
  });

  it("merges, deploys, verifies, and does not repeat those effects after restart", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    const mission = controller(state);
    mission.create({
      missionId: "mission-run",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Run"
    });
    const waiting = await mission.runUntilStable("mission-run");
    const done = await mission.approve("mission-run", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(done.state).toBe("COMPLETED");
    expect(state.calls.merge).toBe(1);
    expect(state.calls.deploy).toBe(1);
    expect(state.calls.verify).toBe(1);
    const again = controller(state);
    const replay = await again.runUntilStable("mission-run");
    expect(replay.state).toBe("COMPLETED");
    expect(state.calls.merge).toBe(1);
    expect(state.calls.deploy).toBe(1);
    expect(state.calls.verify).toBe(1);
    expect(again.store.events("mission-run").filter((event) => event.name === "coding_mission.completed")).toHaveLength(
      1
    );
    const duplicate = await again.approve("mission-run", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(duplicate.state).toBe("COMPLETED");
    expect(state.calls.merge).toBe(1);
    mission.close();
    again.close();
  });

  it("honors an existing authority grant without a human prompt", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, {
      operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }],
      grantId: "grant-7"
    });
    const mission = controller(state);
    mission.create({
      missionId: "mission-grant",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Grant"
    });
    const done = await mission.runUntilStable("mission-grant");
    expect(done.state).toBe("COMPLETED");
    expect(mission.store.require("mission-grant").grantId).toBe("grant-7");
    expect(state.calls.merge).toBe(1);
    mission.close();
  });

  it("fails closed on policy denial, branch protection, failed verification, and a stale base", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const denied = script(root, {
      operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }],
      admission: "policy"
    });
    const mission = controller(denied);
    mission.create({
      missionId: "mission-policy",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Policy"
    });
    const waiting = await mission.runUntilStable("mission-policy");
    const failed = await mission.approve("mission-policy", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(failed.code).toBe("policy_denied");
    expect(denied.calls.merge).toBe(0);
    mission.close();

    const protectedBranch = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    protectedBranch.mergeOutcome = { status: "rejected", code: "branch_protection" };
    const second = controller(protectedBranch);
    second.create({
      missionId: "mission-protect",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Protect"
    });
    const waitingProtection = await second.runUntilStable("mission-protect");
    const blocked = await second.approve("mission-protect", {
      approverId: "human",
      expectedChangeSetHash: waitingProtection.changeSetHash!
    });
    expect(blocked.code).toBe("branch_protection");
    second.close();

    const unverified = script(root, {
      operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }],
      verificationPassed: false
    });
    const third = controller(unverified);
    third.create({
      missionId: "mission-verify",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Verify"
    });
    const waitingVerify = await third.runUntilStable("mission-verify");
    const verification = await third.approve("mission-verify", {
      approverId: "human",
      expectedChangeSetHash: waitingVerify.changeSetHash!
    });
    expect(verification.code).toBe("verification_failed");
    expect(third.store.require("mission-verify").state).toBe("FAILED");
    third.close();

    const staleBase = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    const fourth = controller(staleBase);
    fourth.create({
      missionId: "mission-base",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Base"
    });
    const waitingBase = await fourth.runUntilStable("mission-base");
    staleBase.baseSha = "e".repeat(40);
    const moved = await fourth.approve("mission-base", {
      approverId: "human",
      expectedChangeSetHash: waitingBase.changeSetHash!
    });
    expect(moved.code).toBe("stale_base");
    expect(staleBase.calls.merge).toBe(0);
    fourth.close();
  });

  it("degrades when the pull request head no longer matches the approved change set", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    state.mergeOutcome = { status: "rejected", code: "stale_head" };
    const mission = controller(state);
    mission.create({
      missionId: "mission-head",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Head"
    });
    const waiting = await mission.runUntilStable("mission-head");
    const moved = await mission.approve("mission-head", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(moved.state).toBe("DEGRADED");
    expect(moved.code).toBe("stale_head");
    expect(state.calls.merge).toBe(1);
    expect(state.calls.deploy).toBe(0);
    mission.close();
  });

  it("reconciles an unknown merge without merging twice", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    state.mergeOutcome = { status: "unknown" };
    const mission = controller(state);
    mission.create({
      missionId: "mission-merge",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Merge"
    });
    const waiting = await mission.runUntilStable("mission-merge");
    const unknown = await mission.approve("mission-merge", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(unknown.code).toBe("unknown_merge");
    expect(state.calls.merge).toBe(1);
    state.mergeOutcome = ok({ mergeSha: MERGE, alreadyMerged: true });
    const resumed = controller(state);
    const done = await resumed.runUntilStable("mission-merge");
    expect(done.state).toBe("COMPLETED");
    expect(state.calls.merge).toBe(1);
    mission.close();
    resumed.close();
  });

  it("observes a merge GitHub accepted after the response was lost", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    mkdirSync(join(root, "acme", "app"), { recursive: true });
    let githubAccepted = false;
    const puts: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/pulls/123")) {
        return Response.json(
          githubAccepted
            ? { merged: true, merge_commit_sha: MERGE, head: { sha: HEAD } }
            : { merged: false, head: { sha: HEAD } }
        );
      }
      if (method === "PUT" && url.endsWith("/merge")) {
        const body = JSON.parse(String(init?.body)) as { sha?: string; merge_method?: string };
        expect(body).toEqual({ sha: HEAD, merge_method: "merge" });
        puts.push(url);
        githubAccepted = true;
        throw new Error("socket hang up before the merge response");
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const runtime = codingMissionPortsFromEnv(
      {
        ACS_GITHUB_TOKEN: "test-token",
        ACS_CODING_CHECKOUT_ROOT: root,
        ACS_GITHUB_API: "https://github.test"
      },
      { dbPath: join(root, "control.db"), fetchImpl }
    );
    expect(runtime?.merger).toBeDefined();
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    state.ports.merger = runtime!.merger;
    const mission = controller(state);
    mission.create({
      missionId: "mission-lost",
      repository: "acme/app",
      baseRef: "main",
      baseSha: BASE,
      summary: "Lost response"
    });
    const waiting = await mission.runUntilStable("mission-lost");
    const unknown = await mission.approve("mission-lost", {
      approverId: "human",
      expectedChangeSetHash: waiting.changeSetHash!
    });
    expect(unknown.code).toBe("unknown_merge");
    expect(unknown.state).toBe("EXECUTING");
    expect(puts).toHaveLength(1);
    expect(state.calls.deploy).toBe(0);
    expect(mission.store.require("mission-lost").mergeSha).toBeUndefined();
    expect(mission.store.effect("mission-lost", "merge")).toEqual({ kind: "merge", outcome: "unknown" });

    const resumed = controller(state);
    const done = await resumed.runUntilStable("mission-lost");
    expect(done.state).toBe("COMPLETED");
    expect(puts).toHaveLength(1);
    expect(resumed.store.require("mission-lost").mergeSha).toBe(MERGE);
    expect(resumed.store.effect("mission-lost", "merge")?.outcome).toBe("succeeded");
    expect(state.calls.deploy).toBe(1);
    mission.close();
    resumed.close();
  });

  it("lets only one of two workers claim the same pending operation", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-coding-"));
    const state = script(root, { operations: [{ operationId: "edit-api", dependsOn: [], title: "edit" }] });
    const first = controller(state);
    const secondStore = new CodingMissionStore(state.dbPath);
    const second = controller(state, secondStore);
    first.create({
      missionId: "mission-race",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Race"
    });
    await first.advance("mission-race");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.ports.coder.execute = async () => {
      await gate;
      state.calls.execute += 1;
      return ok({ resultHash: "result-edit-api", files: ["edit-api.ts"] });
    };
    const left = first.advance("mission-race");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const right = second.advance("mission-race");
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const settled = await Promise.all([left, right]);
    expect(settled.map((result) => result.code)).toContain("in_progress");
    expect(state.calls.execute).toBe(1);
    first.close();
    second.close();
  });
});
