import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAuthoritativeRoute,
  evaluateShadowGates,
  resolveNimbleRoutingConfig,
  summarizeRoutingComparisons,
  type RouteUnitContext,
  type StrategyChooser
} from "@agent-control-stack/actor-router";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const actorId = "actor_system_bootstrap";
const now = new Date();
const transition = { via: "domain_service" } as const;

const nimble =
  (executorId: string): typeof fetch =>
  async () =>
    new Response(
      JSON.stringify({
        model: "nimble:latest",
        answers: {
          executor: {
            type: "choice",
            choice: executorId,
            confidence: 0.95,
            probabilities: { alpha: executorId === "alpha" ? 0.95 : 0.05, beta: executorId === "beta" ? 0.95 : 0.05 }
          }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
const config = () => ({ ...resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1" }), enabled: true as const });

function fixture(agentIds: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "acs-route-enrich-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  for (const id of agentIds) {
    store.createRegistryAgent({
      id,
      name: id,
      kind: "repository_read",
      acpRole: "IMPLEMENTATION_AGENT",
      provider: "local",
      model: `${id}-m`,
      status: "AVAILABLE",
      actorId
    });
    store.replaceAgentCapabilities(id, [{ name: "fs.read" }], actorId);
    store.recordAgentHeartbeat(id, { status: "AVAILABLE", actorId, now });
  }
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);
  const created = tools.create_work_item({
    title: "Route",
    requester: "user",
    intent: "inspect",
    target: { cwd: "/repo", services: agentIds },
    requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"], write: false } }],
    risk: "low"
  });
  if (created.status === "needs_approval") {
    for (const evaluation of policy.evaluateWorkItem(created, "approver", "approve")) {
      tools.approve_work_item({
        id: created.id,
        approvedBy: "approver",
        reason: "test",
        actionHash: evaluation.actionHash
      });
    }
  }
  if (store.get(created.id)?.status !== "approved") store.approveWorkItem(created.id, transition);
  return { directory, store, workItemId: created.id };
}

describe("route enrichment (ADR 0025)", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const open = (ids = ["alpha", "beta"]) => {
    const fx = fixture(ids);
    directories.push(fx.directory);
    return fx;
  };
  const unit = (
    verificationPolicy: RouteUnitContext["verificationPolicy"] = "none",
    kind: RouteUnitContext["kind"] = "coding"
  ): RouteUnitContext => ({
    kind,
    verificationPolicy
  });
  const route = (
    fx: ReturnType<typeof open>,
    choice: string,
    extra: Partial<Parameters<typeof decideAuthoritativeRoute>[0]> & {
      workUnit?: RouteUnitContext;
      routePolicy?: object;
    } = {}
  ) => {
    const { workUnit, routePolicy, ...rest } = extra;
    return decideAuthoritativeRoute({
      agents: fx.store.listRegistryAgents(),
      context: {
        missionId: fx.workItemId,
        workItemId: fx.workItemId,
        operationType: "fs.read",
        requiredCapabilities: ["fs.read"],
        lane: "dc",
        now,
        ...(workUnit ? { workUnit } : {}),
        ...(routePolicy ? { routePolicy } : {})
      },
      config: config(),
      store: fx.store,
      transition,
      fetchImpl: nimble(choice),
      ...rest
    });
  };

  it("persists the structured strategy beside the incumbent route, and replays it without re-deciding", async () => {
    const fx = open();
    let asked = 0;
    const chooser: StrategyChooser = () => {
      asked += 1;
      return "plan_execute";
    };
    const first = await route(fx, "alpha", { workUnit: unit("independent"), strategyChooser: chooser });
    expect(first).toMatchObject({ decision: "route", executorId: "alpha", source: "nimble" });
    expect(first.enrichment).toMatchObject({
      executorClass: "coding",
      strategy: "plan_execute",
      strategySource: "model",
      parallelism: 1,
      verificationRequired: true,
      version: "acs-route-enrichment@1"
    });
    const stored = fx.store.getLatestAuthoritativeRoutingEvidence(fx.workItemId);
    expect(stored?.enrichment).toEqual(first.enrichment);
    expect(stored?.enrichment?.deterministicEvidence).toContainEqual({ kind: "eligible_count", value: 2 });

    const again = await route(fx, "beta", { workUnit: unit("independent"), strategyChooser: chooser });
    expect(again).toMatchObject({ disposition: "resumed", decisionId: first.decisionId, executorId: "alpha" });
    expect(again.enrichment).toEqual(first.enrichment);
    expect(asked).toBe(1);
  });

  it("never changes which executor is chosen, whatever the strategy or chooser says", async () => {
    const plain = open();
    const baseline = await route(plain, "beta");
    const enriched = open();
    const hostile = await route(enriched, "beta", {
      workUnit: unit("independent"),
      routePolicy: { maxParallelism: 4 },
      strategyChooser: () => "parallel_candidates"
    });
    expect(hostile.executorId).toBe(baseline.executorId);
    expect(hostile.source).toBe(baseline.source);
    expect(hostile.reasonCode).toBe(baseline.reasonCode);
  });

  it("persists nothing for a route made without a work-unit context", async () => {
    const fx = open();
    const result = await route(fx, "alpha");
    expect(result.enrichment).toBeUndefined();
    expect(fx.store.getLatestAuthoritativeRoutingEvidence(fx.workItemId)?.enrichment).toBeUndefined();
    const [comparison] = fx.store.listRoutingComparisons();
    expect(comparison).toMatchObject({ decisionId: result.decisionId });
    expect(comparison?.strategy).toBeUndefined();
  });

  it("rejects an out-of-set strategy recommendation and records why", async () => {
    const fx = open();
    const result = await route(fx, "alpha", {
      workUnit: unit("none", "shell"),
      strategyChooser: () => "specialist_delegation"
    });
    expect(result.enrichment).toMatchObject({ strategy: "single", strategySource: "deterministic" });
    expect(result.enrichment?.reasons).toContainEqual({
      code: "strategy_recommendation_rejected",
      detail: "specialist_delegation"
    });
  });

  it("fails closed when the policy allow-list leaves no strategy, for routes and fallbacks", async () => {
    for (const [ids, allowedStrategies] of [
      [["alpha", "beta"], []],
      [["alpha"], ["cua_recovery"]]
    ] as const) {
      const fx = open([...ids]);
      let asked = 0;
      const result = await route(fx, "alpha", {
        workUnit: unit("none", "shell"),
        routePolicy: { allowedStrategies },
        strategyChooser: () => {
          asked += 1;
          return "single";
        }
      });
      expect(result).toMatchObject({ decision: "reject", reasonCode: "route_strategy_rejected" });
      expect(result.executorId).toBeUndefined();
      expect(result.enrichment).toBeUndefined();
      expect(asked).toBe(0);
      const stored = fx.store.getLatestAuthoritativeRoutingEvidence(fx.workItemId);
      expect(stored).toMatchObject({ decision: "reject", reasonCode: "route_strategy_rejected" });
      expect(stored?.normalizedDecision).toMatchObject({
        strategyRejection: {
          reasons: [
            {
              code: "allowed_strategies_rejected",
              detail: allowedStrategies.length === 0 ? "empty" : allowedStrategies.join(",")
            }
          ],
          deterministicEvidence: expect.arrayContaining([{ kind: "candidate_strategies", value: [] }])
        }
      });
    }
  });

  it("enriches a deterministic fallback and a sole-candidate route too", async () => {
    const solo = open(["alpha"]);
    const sole = await route(solo, "alpha", { workUnit: unit() });
    expect(sole).toMatchObject({ decision: "fallback", reasonCode: "deterministic_fallback" });
    expect(sole.enrichment).toMatchObject({ strategy: "single", verificationRequired: false });
    expect(sole.enrichment?.deterministicEvidence).toContainEqual({ kind: "eligible_count", value: 1 });

    const down = open();
    const broken = await decideAuthoritativeRoute({
      agents: down.store.listRegistryAgents(),
      context: {
        workItemId: down.workItemId,
        operationType: "fs.read",
        requiredCapabilities: ["fs.read"],
        now,
        workUnit: unit("independent")
      },
      config: config(),
      store: down.store,
      transition,
      fetchImpl: async () => {
        throw new Error("nimble down");
      }
    });
    expect(broken.source).toBe("deterministic_fallback");
    expect(broken.enrichment).toMatchObject({ strategy: "single", verificationRequired: true });
  });

  it("does not enrich a rejected route", async () => {
    const fx = open();
    const result = await decideAuthoritativeRoute({
      agents: [],
      context: {
        workItemId: fx.workItemId,
        operationType: "fs.read",
        requiredCapabilities: ["fs.read"],
        now,
        workUnit: unit()
      },
      config: config(),
      store: fx.store,
      transition
    });
    expect(result.decision).toBe("reject");
    expect(result.enrichment).toBeUndefined();
  });

  it("joins the route, strategy, Nimble choice, Jev shadow and outcome into one comparison row", async () => {
    const fx = open();
    const pending: Promise<void>[] = [];
    const result = await route(fx, "alpha", {
      workUnit: unit("independent"),
      routeShadow: {
        observer: async () => ({ status: "recommended", recommendedExecutorId: "beta", confidence: 0.7 }),
        recorder: fx.store,
        track: (settled) => void pending.push(settled)
      }
    });
    await Promise.all(pending);
    fx.store.recordRoutingExecutionOutcome(
      {
        decisionId: result.decisionId,
        executorId: "alpha",
        latencyMs: 250,
        success: true,
        timedOut: false,
        verificationResult: "passed",
        retryCount: 1,
        actualStrategy: "single",
        toolCalls: 7,
        modelTokens: 1200,
        idempotencyKey: "outcome-1"
      },
      transition
    );
    const [row] = fx.store.listRoutingComparisons();
    expect(row).toMatchObject({
      decisionId: result.decisionId,
      source: "nimble",
      executorId: "alpha",
      nimbleConfidence: 0.95,
      executorClass: "coding",
      strategy: "single",
      strategySource: "deterministic",
      verificationRequired: true,
      jevStatus: "recommended",
      jevRecommended: "beta",
      jevAgrees: false,
      actualExecutor: "alpha",
      actualStrategy: "single",
      success: true,
      verificationResult: "passed",
      wallMs: 250,
      retryCount: 1,
      toolCalls: 7,
      modelTokens: 1200
    });
    // Cost was never reported, so it is absent, not zero.
    expect(row?.costMicroUsd).toBeUndefined();
    const summary = summarizeRoutingComparisons([row!]);
    expect(summary.outcomes.costMicroUsd).toEqual({ reportedFor: 0, total: 0 });
    expect(summary.jev).toMatchObject({ observed: 1, disagreements: 1, trustedOutcomes: 1 });
    expect(evaluateShadowGates(summary).verdict).toBe("NOT_PROMOTABLE");
  });

  it("does not store the Jev recommendation in the replayed route evidence", async () => {
    const fx = open();
    const pending: Promise<void>[] = [];
    await route(fx, "alpha", {
      workUnit: unit(),
      routeShadow: {
        observer: async () => ({ status: "recommended", recommendedExecutorId: "beta", confidence: 0.99 }),
        recorder: fx.store,
        track: (settled) => void pending.push(settled)
      }
    });
    await Promise.all(pending);
    const evidence = JSON.stringify(fx.store.getLatestAuthoritativeRoutingEvidence(fx.workItemId));
    expect(evidence).not.toContain("jev");
    expect(evidence).not.toContain("0.99");
  });

  it("keeps outcome accounting optional and the latest outcome authoritative in the comparison view", async () => {
    const fx = open();
    const result = await route(fx, "alpha", { workUnit: unit() });
    const base = { decisionId: result.decisionId, executorId: "alpha", latencyMs: 10, timedOut: false, retryCount: 0 };
    fx.store.recordRoutingExecutionOutcome(
      { ...base, success: false, idempotencyKey: "o1", now: new Date(now.getTime() + 1000) },
      transition
    );
    fx.store.recordRoutingExecutionOutcome(
      { ...base, success: true, idempotencyKey: "o2", now: new Date(now.getTime() + 2000) },
      transition
    );
    const rows = fx.store.listRoutingComparisons();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: true });
    expect(rows[0]?.toolCalls).toBeUndefined();
  });
});
