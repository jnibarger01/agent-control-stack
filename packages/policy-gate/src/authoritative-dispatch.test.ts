import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionAdmissionScheduler } from "@agent-control-stack/execution-admission";
import { stableHash } from "@agent-control-stack/shared";
import { decideAuthoritativeRoute, resolveNimbleRoutingConfig } from "@agent-control-stack/actor-router";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { claimNextAuthoritativeWorkItem, recordAuthoritativeExecutionOutcome } from "./authoritative-dispatch.js";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const actorId = "actor_system_bootstrap";
const now = new Date();

function choice(executorId: string, confidence = 0.95): Response {
  return new Response(
    JSON.stringify({
      model: "nimble:latest",
      answers: {
        executor: {
          type: "choice",
          choice: executorId,
          confidence,
          probabilities: {
            alpha: executorId === "alpha" ? confidence : 1 - confidence,
            beta: executorId === "beta" ? confidence : 1 - confidence
          }
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function config(overrides: Partial<ReturnType<typeof resolveNimbleRoutingConfig>> = {}) {
  return {
    ...resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1" }),
    ...overrides,
    enabled: true as const
  };
}

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "acs-nimble-route-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  for (const agent of [
    { id: "alpha", provider: "local" },
    { id: "beta", provider: "local" },
    { id: "blind", provider: "local" },
    { id: "admin-exec", provider: "admin-only" }
  ]) {
    store.createRegistryAgent({
      id: agent.id,
      name: agent.id,
      kind: "repository_read",
      acpRole: "IMPLEMENTATION_AGENT",
      provider: agent.provider,
      model: `${agent.id}-model`,
      status: "AVAILABLE",
      actorId
    });
    store.replaceAgentCapabilities(
      agent.id,
      agent.id === "blind" ? [{ name: "fs.write" }] : [{ name: "fs.read" }],
      actorId
    );
    store.recordAgentHeartbeat(agent.id, { status: "AVAILABLE", actorId, now });
  }
  return { directory, dbPath, store };
}

function readyItem(store: SqliteWorkItemStore, policy: PolicyEngine): WorkItem {
  const tools = createWorkItemTools(store, policy);
  const created = tools.create_work_item({
    title: "Route a read",
    requester: "user",
    intent: "inspect the repository",
    target: { cwd: "/repo", services: ["alpha", "beta", "blind", "admin-exec"] },
    requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"], write: false } }],
    risk: "low"
  });
  if (created.status === "needs_approval") {
    for (const evaluation of policy.evaluateWorkItem(created, "approver", "approve")) {
      tools.approve_work_item({
        id: created.id,
        approvedBy: "approver",
        reason: "approved for routing test",
        actionHash: evaluation.actionHash
      });
    }
  }
  let current = store.get(created.id);
  if (current && current.status !== "approved") {
    current = store.approveWorkItem(current.id, { via: "domain_service" });
  }
  if (!current || current.status !== "approved") {
    throw new Error(`fixture did not become approved: ${current?.status}`);
  }
  return current;
}

describe("authoritative Nimble routing", () => {
  const directories: string[] = [];
  const priorEnabled = process.env.ACS_NIMBLE_ROUTING_ENABLED;
  afterEach(() => {
    if (priorEnabled === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
    else process.env.ACS_NIMBLE_ROUTING_ENABLED = priorEnabled;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("dispatches the Nimble-selected executor and keeps the result bound to that decision", async () => {
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const fixture = openStore();
    directories.push(fixture.directory);
    const policy = createPolicyEngine();
    const item = readyItem(fixture.store, policy);
    const calls: string[] = [];
    const claimed = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "beta",
      config: config(),
      now,
      fetchImpl: async (_url, init) => {
        calls.push(String(init?.body));
        return choice("beta");
      }
    });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.running.workerId).toBe("beta");
    expect(claimed.decision).toMatchObject({
      decision: "route",
      source: "nimble",
      executorId: "beta",
      reasonCode: "nimble_choice"
    });
    const request = calls[0] ?? "";
    expect(request).toContain('"beta"');
    expect(request).not.toContain('"blind"');
    expect(request).not.toContain('"admin-exec"');
    expect(JSON.parse(request).questions.executor.criteria.alpha).toBeTypeOf("string");

    const tools = createWorkItemTools(fixture.store, policy);
    tools.submit_work_result({
      workItemId: claimed.running.id,
      attemptId: claimed.running.attemptId,
      leaseId: claimed.running.leaseId,
      workerId: claimed.running.workerId,
      actionHash: claimed.running.actionHash,
      planHash: claimed.running.planHash,
      inputHash: claimed.running.inputHash,
      fencingEpoch: claimed.running.fencingEpoch,
      idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.running.attemptId }),
      outcome: "succeeded",
      startedAt: claimed.running.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: "routed read completed",
      structuredOutput: { simulated: true },
      artifacts: [],
      simulationMetadata: { executionMode: "dry_run", simulated: true }
    });
    const outcome = recordAuthoritativeExecutionOutcome(fixture.store, claimed.decision, {
      executorId: "beta",
      model: claimed.decision.model,
      latencyMs: 12,
      success: true,
      timedOut: false,
      verificationResult: "passed",
      testsResult: "passed",
      retryCount: 0,
      idempotencyKey: `outcome.${claimed.decision.decisionId}`
    });
    expect(fixture.store.listRoutingExecutionOutcomes(claimed.decision.decisionId)).toEqual([
      expect.objectContaining({
        decisionId: claimed.decision.decisionId,
        executorId: "beta",
        success: true,
        latencyMs: 12
      })
    ]);
    expect(outcome?.decisionId).toBe(claimed.decision.decisionId);
    expect(fixture.store.get(item.id)?.status).toBe("succeeded");
    claimed.releaseAdmission();

    const callsBeforeRestart = calls.length;
    fixture.store.close();
    const restarted = new SqliteWorkItemStore(fixture.dbPath);
    const again = await claimNextAuthoritativeWorkItem({
      store: restarted,
      policy,
      workerId: "beta",
      config: config(),
      fetchImpl: async () => {
        calls.push("restart");
        return choice("alpha");
      }
    });
    expect(again.claimed).toBe(false);
    expect(calls).toHaveLength(callsBeforeRestart);
    expect(restarted.listAuthoritativeRoutingEvidence(item.id)).toHaveLength(1);
    expect(restarted.get(item.id)?.status).toBe("succeeded");
    restarted.close();
  });

  it("falls back deterministically when Nimble is unavailable and does not call Nimble for an empty set", async () => {
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const fixture = openStore();
    directories.push(fixture.directory);
    const policy = createPolicyEngine();
    const item = readyItem(fixture.store, policy);
    let calls = 0;
    const fallback = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "alpha",
      config: config({ timeoutMs: 50 }),
      now,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("connection refused");
      }
    });
    expect(fallback.claimed).toBe(true);
    if (!fallback.claimed) return;
    expect(fallback.decision).toMatchObject({
      decision: "fallback",
      source: "deterministic_fallback",
      executorId: "alpha",
      fallbackReason: "unavailable"
    });
    expect(fallback.running.workerId).toBe("alpha");
    expect(calls).toBe(1);
    fallback.releaseAdmission();

    fixture.store.close();
    const sole = new SqliteWorkItemStore(fixture.dbPath);
    sole.updateRegistryAgent("beta", { status: "OFFLINE", actorId, now: new Date() });
    const soleItem = createWorkItemTools(sole, policy).create_work_item({
      title: "Only alpha",
      requester: "user",
      intent: "one eligible executor",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"], write: false } }],
      risk: "low"
    });
    if (sole.get(soleItem.id)?.status !== "approved") {
      sole.approveWorkItem(soleItem.id, { via: "domain_service" });
    }
    let soleCalls = 0;
    const soleClaim = await claimNextAuthoritativeWorkItem({
      store: sole,
      policy,
      workerId: "alpha",
      config: config(),
      now,
      fetchImpl: async () => {
        soleCalls += 1;
        return choice("alpha");
      }
    });
    expect(soleCalls).toBe(0);
    expect(soleClaim.claimed).toBe(true);
    if (soleClaim.claimed) {
      expect(soleClaim.decision).toMatchObject({
        decision: "fallback",
        fallbackReason: "sole_eligible_candidate",
        executorId: "alpha"
      });
      soleClaim.releaseAdmission();
    }
    sole.close();

    const empty = new SqliteWorkItemStore(fixture.dbPath);
    empty.updateRegistryAgent("alpha", { status: "OFFLINE", actorId, now: new Date() });
    empty.updateRegistryAgent("beta", { status: "OFFLINE", actorId, now: new Date() });
    const blocked = empty.get(item.id);
    expect(blocked?.status).toBe("running");
    const fresh = createWorkItemTools(empty, policy).create_work_item({
      title: "No candidates",
      requester: "user",
      intent: "nothing eligible",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"], write: false } }],
      risk: "low"
    });
    if (fresh.status !== "approved") {
      empty.approveWorkItem(fresh.id, { via: "domain_service" });
    }
    let emptyCalls = 0;
    const rejected = await claimNextAuthoritativeWorkItem({
      store: empty,
      policy,
      workerId: "alpha",
      config: config(),
      fetchImpl: async () => {
        emptyCalls += 1;
        return choice("alpha");
      }
    });
    expect(emptyCalls).toBe(0);
    expect(rejected.claimed).toBe(false);
    const evidence = empty.listAuthoritativeRoutingEvidence(fresh.id);
    expect(evidence.at(-1)).toMatchObject({ decision: "reject", reasonCode: "no_eligible_candidate" });
    empty.close();
  });

  it("rejects an executor outside the candidate set, low confidence, malformed responses, and timeouts", async () => {
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const cases: Array<{
      name: string;
      fetchImpl: typeof fetch;
      config: ReturnType<typeof config>;
      match: Record<string, unknown>;
    }> = [
      {
        name: "unknown",
        fetchImpl: async () => choice("not-an-executor"),
        config: config(),
        match: { decision: "fallback", fallbackReason: "unknown_executor", executorId: "alpha" }
      },
      {
        name: "malformed",
        fetchImpl: async () => new Response("{}", { status: 200 }),
        config: config(),
        match: { decision: "fallback", fallbackReason: "malformed_response", executorId: "alpha" }
      },
      {
        name: "timeout",
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
        config: config({ timeoutMs: 20 }),
        match: { decision: "fallback", fallbackReason: "timeout", executorId: "alpha" }
      },
      {
        name: "low-confidence-fallback",
        fetchImpl: async () => choice("beta", 0.1),
        config: config({ lowConfidencePolicy: "fallback" }),
        match: { decision: "fallback", fallbackReason: "low_confidence", executorId: "alpha" }
      }
    ];
    for (const entry of cases) {
      const fixture = openStore();
      directories.push(fixture.directory);
      const policy = createPolicyEngine();
      readyItem(fixture.store, policy);
      const claimed = await claimNextAuthoritativeWorkItem({
        store: fixture.store,
        policy,
        workerId: "alpha",
        config: entry.config,
        now,
        fetchImpl: entry.fetchImpl
      });
      expect(claimed.claimed, entry.name).toBe(true);
      if (claimed.claimed) {
        expect(claimed.decision, entry.name).toMatchObject(entry.match);
        expect(claimed.running.workerId).toBe("alpha");
        claimed.releaseAdmission();
      }
      fixture.store.close();
    }

    const fixture = openStore();
    directories.push(fixture.directory);
    const policy = createPolicyEngine();
    const item = readyItem(fixture.store, policy);
    const rejected = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "beta",
      config: config({ lowConfidencePolicy: "reject" }),
      now,
      fetchImpl: async () => choice("beta", 0.2)
    });
    expect(rejected.claimed).toBe(false);
    expect(fixture.store.getLatestAuthoritativeRoutingEvidence(item.id)).toMatchObject({
      decision: "reject",
      source: "nimble",
      reasonCode: "low_confidence"
    });
    expect(fixture.store.get(item.id)?.status).toBe("approved");
    fixture.store.close();
  });

  it("resumes a persisted decision, replaces an invalidated candidate, and blocks on admission and authorization", async () => {
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const fixture = openStore();
    directories.push(fixture.directory);
    const policy = createPolicyEngine();
    const item = readyItem(fixture.store, policy);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return choice("beta");
    };
    const first = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "alpha",
      config: config(),
      now,
      fetchImpl
    });
    expect(first.claimed).toBe(false);
    if (first.claimed) return;
    expect(first.reason).toBe("routed_to_other_executor");
    const before = fixture.store.listAuthoritativeRoutingEvidence(item.id);
    expect(before).toHaveLength(1);
    const second = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "alpha",
      config: config(),
      now,
      fetchImpl
    });
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.reason).toBe("routed_to_other_executor");
    expect(calls).toBe(1);
    expect(fixture.store.listAuthoritativeRoutingEvidence(item.id)).toHaveLength(1);

    fixture.store.updateRegistryAgent("beta", { status: "OFFLINE", actorId, now: new Date() });
    const replaced = await claimNextAuthoritativeWorkItem({
      store: fixture.store,
      policy,
      workerId: "alpha",
      config: config(),
      now,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("one remaining executor must not call Nimble");
      }
    });
    expect(replaced.claimed).toBe(true);
    if (!replaced.claimed) return;
    expect(calls).toBe(1);
    const records = fixture.store.listAuthoritativeRoutingEvidence(item.id);
    expect(records.map((record) => record.reasonCode)).toEqual([
      "nimble_choice",
      "candidate_invalidated",
      "deterministic_fallback"
    ]);
    expect(records[2]).toMatchObject({ fallbackReason: "sole_eligible_candidate", selectedActorId: "alpha" });
    expect(records[1]?.supersedesDecisionId).toBe(records[0]?.decisionId);
    expect(records[2]?.decisionId).not.toBe(records[0]?.decisionId);
    expect(replaced.running.workerId).toBe("alpha");
    const reconcile = await decideAuthoritativeRoute({
      agents: fixture.store.listRegistryAgents(),
      context: {
        missionId: item.id,
        workItemId: item.id,
        operationType: "fs.read",
        requiredCapabilities: ["fs.read"],
        now
      },
      config: config(),
      store: fixture.store,
      transition: { via: "domain_service" },
      fetchImpl: async () => {
        throw new Error("completed or in-flight work must not call Nimble");
      }
    });
    expect(reconcile.disposition).toBe("reconcile");
    expect(fixture.store.listAuthoritativeRoutingEvidence(item.id)).toHaveLength(3);
    replaced.releaseAdmission();

    const held = openStore();
    directories.push(held.directory);
    const heldItem = readyItem(held.store, policy);
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 1,
        queueTimeoutMs: 1_000,
        waitMaxInflight: 1
      }
    });
    const permit = await scheduler.acquire({
      requestId: "held",
      lane: "dc",
      executorId: "beta",
      actorId: "beta",
      toolName: "authoritative_dispatch",
      executionClass: "execution",
      enqueuedAt: Date.now(),
      deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal
    });
    const blocked = await claimNextAuthoritativeWorkItem({
      store: held.store,
      policy,
      workerId: "beta",
      config: config(),
      now,
      admission: {
        acquire: (input) =>
          scheduler.acquire({
            requestId: input.requestId,
            lane: input.lane,
            executorId: input.executorId,
            actorId: input.actorId,
            toolName: "authoritative_dispatch",
            executionClass: "execution",
            enqueuedAt: Date.now(),
            deadlineAt: Date.now() + 1_000,
            signal: AbortSignal.timeout(50)
          })
      },
      fetchImpl: async () => choice("beta")
    });
    expect(blocked).toMatchObject({ claimed: false, reason: "admission_blocked" });
    expect(held.store.get(heldItem.id)?.status).toBe("approved");
    permit.release();
    scheduler.shutdown();

    const denied = openStore();
    directories.push(denied.directory);
    const deniedItem = readyItem(denied.store, policy);
    const denyPolicy: PolicyEngine = {
      evaluateWorkItem: () => [
        {
          action: deniedItem.requestedActions[0]!,
          actionHash: "deny",
          context: {
            workItemId: deniedItem.id,
            actor: "beta",
            operation: "claim",
            requester: "user",
            risk: "low",
            action: deniedItem.requestedActions[0]!
          },
          decision: { decision: "deny", reason: "denied for test", matchedRules: ["test"] }
        }
      ],
      summarize: () => ({ decision: "deny", reason: "denied for test", matchedRules: ["test"] })
    };
    const unauthorized = await claimNextAuthoritativeWorkItem({
      store: denied.store,
      policy: denyPolicy,
      workerId: "beta",
      config: config(),
      now,
      fetchImpl: async () => choice("beta")
    });
    expect(unauthorized).toMatchObject({ claimed: false, reason: "authorization_blocked" });
    expect(denied.store.get(deniedItem.id)?.status).toBe("blocked");
    fixture.store.close();
    held.store.close();
    denied.store.close();
  });

  it("does not treat Nimble or JEV as advisory once a decision is persisted", () => {
    const source = [
      readFileSync(new URL("./authoritative-dispatch.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../actor-router/src/authoritative.ts", import.meta.url), "utf8")
    ].join("\n");
    expect(source).not.toMatch(/jev/i);
    expect(source).not.toMatch(/advisory/i);
    expect(source).not.toMatch(/routeAndPersistActor/);
    expect(source).toMatch(/decideAuthoritativeRoute/);
  });
});
