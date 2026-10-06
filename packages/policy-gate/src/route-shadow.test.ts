import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAuthoritativeRoute,
  resolveNimbleRoutingConfig,
  type RouteShadowObserver,
  type RouteShadowOptions
} from "@agent-control-stack/actor-router";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { createJevRouteShadow, createJevRouteShadowObserver } from "./jev-shadow.js";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const actorId = "actor_system_bootstrap";
const now = new Date();
const transition = { via: "domain_service" } as const;

function nimbleChoice(executorId: string): typeof fetch {
  return async () =>
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
}

function config() {
  return { ...resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1" }), enabled: true as const };
}

interface Fixture {
  directory: string;
  store: SqliteWorkItemStore;
  workItemId: string;
}

function fixture(agentIds: string[]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "acs-route-shadow-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  for (const id of agentIds) {
    store.createRegistryAgent({
      id,
      name: id,
      kind: "repository_read",
      acpRole: "IMPLEMENTATION_AGENT",
      provider: "local",
      model: `${id}-model`,
      status: "AVAILABLE",
      actorId
    });
    store.replaceAgentCapabilities(id, [{ name: "fs.read" }], actorId);
    store.recordAgentHeartbeat(id, { status: "AVAILABLE", actorId, now });
  }
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);
  const created = tools.create_work_item({
    title: "Route a read",
    requester: "user",
    intent: "inspect the repository",
    target: { cwd: "/repo", services: agentIds },
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
  const current = store.get(created.id);
  if (current && current.status !== "approved") store.approveWorkItem(current.id, transition);
  if (store.get(created.id)?.status !== "approved") throw new Error("fixture did not become approved");
  return { directory, store, workItemId: created.id };
}

function route(fx: Fixture, choice: string, routeShadow?: RouteShadowOptions) {
  return decideAuthoritativeRoute({
    agents: fx.store.listRegistryAgents(),
    context: {
      missionId: fx.workItemId,
      workItemId: fx.workItemId,
      operationType: "fs.read",
      requiredCapabilities: ["fs.read"],
      lane: "dc",
      now
    },
    config: config(),
    store: fx.store,
    transition,
    fetchImpl: nimbleChoice(choice),
    ...(routeShadow ? { routeShadow } : {})
  });
}

/** The persisted authority state with run-specific ids, timestamps and Nimble's own wall-clock latency masked. */
function authoritativeSnapshot(fx: Fixture) {
  const mask = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value)
        .split(fx.workItemId)
        .join("<item>")
        .replace(/"latencyMs":\d+/g, '"latencyMs":0')
    );
  return fx.store.listAuthoritativeRoutingEvidence(fx.workItemId).map((evidence) => {
    const { decisionId: _decisionId, createdAt: _createdAt, idempotencyKey: _key, ...rest } = evidence;
    void _decisionId;
    void _createdAt;
    void _key;
    return mask(rest);
  });
}

function shadowOptions(fx: Fixture, observer: RouteShadowObserver, timeoutMs?: number) {
  const pending: Promise<void>[] = [];
  const options: RouteShadowOptions = {
    observer,
    recorder: fx.store,
    ...(timeoutMs ? { timeoutMs } : {}),
    track: (settled) => void pending.push(settled)
  };
  return { options, drain: () => Promise.all(pending).then(() => undefined) };
}

describe("route shadow (ADR 0025): non-interference", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const open = (ids = ["alpha", "beta"]) => {
    const fx = fixture(ids);
    directories.push(fx.directory);
    return fx;
  };

  const observers: Array<[string, RouteShadowObserver]> = [
    ["agrees", async () => ({ status: "recommended", recommendedExecutorId: "alpha", confidence: 0.9 })],
    ["disagrees", async () => ({ status: "recommended", recommendedExecutorId: "beta", confidence: 0.99 })],
    [
      "names an executor outside the candidate set",
      async () => ({ status: "recommended", recommendedExecutorId: "admin-exec", confidence: 1 })
    ],
    ["throws", async () => Promise.reject(new Error("jev exploded"))],
    [
      "throws synchronously",
      () => {
        throw new Error("sync boom");
      }
    ],
    ["degrades", async () => ({ status: "degraded", failureReason: "UNAVAILABLE" })],
    ["hangs", () => new Promise(() => undefined)]
  ];

  it.each(observers)("leaves the persisted route unchanged when the observer %s", async (_name, observer) => {
    const baseline = open();
    const baselineResult = await route(baseline, "alpha");
    const baselineSnapshot = authoritativeSnapshot(baseline);

    const shadowed = open();
    const { options, drain } = shadowOptions(shadowed, observer, 30);
    const result = await route(shadowed, "alpha", options);
    await drain();

    expect({ ...result, decisionId: "x", evidence: undefined }).toEqual({
      ...baselineResult,
      decisionId: "x",
      evidence: undefined
    });
    expect(authoritativeSnapshot(shadowed)).toEqual(baselineSnapshot);
    expect(shadowed.store.listAuthoritativeRoutingEvidence(shadowed.workItemId)).toHaveLength(1);
    expect(result.executorId).toBe("alpha");
    expect(result.source).toBe("nimble");
  });

  it("does not wait for a slow observer", async () => {
    const fx = open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { options, drain } = shadowOptions(fx, async () => {
      await gate;
      return { status: "recommended", recommendedExecutorId: "beta" };
    });
    const result = await route(fx, "alpha", options);
    expect(result.executorId).toBe("alpha");
    expect(fx.store.listRouteShadowObservations(result.decisionId)).toEqual([]);
    release();
    await drain();
    expect(fx.store.listRouteShadowObservations(result.decisionId)).toHaveLength(1);
  });

  it("hands the observer a frozen copy it cannot use to alter the context", async () => {
    const fx = open();
    let frozen = false;
    const { options, drain } = shadowOptions(fx, async (input) => {
      frozen = Object.isFrozen(input) && Object.isFrozen(input.candidates) && Object.isFrozen(input.authoritative);
      return { status: "no_recommendation" };
    });
    await route(fx, "alpha", options);
    await drain();
    expect(frozen).toBe(true);
  });

  it("records agreement, disagreement and invalid recommendations beside the decision", async () => {
    const cases: Array<[string, RouteShadowObserver, Record<string, unknown>]> = [
      [
        "agree",
        async () => ({ status: "recommended", recommendedExecutorId: "alpha", confidence: 0.8 }),
        { status: "recommended", agrees: true, recommendedExecutorId: "alpha", confidence: 0.8 }
      ],
      [
        "disagree",
        async () => ({ status: "recommended", recommendedExecutorId: "beta", confidence: 0.7 }),
        { status: "recommended", agrees: false, recommendedExecutorId: "beta" }
      ],
      [
        "invalid",
        async () => ({ status: "recommended", recommendedExecutorId: "admin-exec", confidence: 1 }),
        { status: "invalid_recommendation", recommendedExecutorId: "admin-exec" }
      ],
      ["degraded", async () => ({ status: "degraded", failureReason: "UNAVAILABLE" }), { status: "degraded" }],
      ["error", async () => Promise.reject(new Error("x")), { status: "error", failureReason: "observer_threw" }]
    ];
    for (const [, observer, expected] of cases) {
      const fx = open();
      const { options, drain } = shadowOptions(fx, observer);
      const result = await route(fx, "alpha", options);
      await drain();
      const [observation] = fx.store.listRouteShadowObservations(result.decisionId);
      expect(observation).toMatchObject({
        source: "jev",
        mode: "shadow",
        authoritativeExecutorId: "alpha",
        authoritativeSource: "nimble",
        candidates: ["alpha", "beta"],
        ...expected
      });
      if (expected.status === "invalid_recommendation") expect(observation?.agrees).toBeUndefined();
    }
  });

  it("records a hung observer as a timeout", async () => {
    const fx = open();
    const { options, drain } = shadowOptions(fx, () => new Promise(() => undefined), 20);
    const result = await route(fx, "alpha", options);
    await drain();
    expect(fx.store.listRouteShadowObservations(result.decisionId)[0]).toMatchObject({
      status: "timeout",
      failureReason: "shadow_timeout"
    });
  });

  it("records the outcome by joining on the decision id, not by copying it", async () => {
    const fx = open();
    const { options, drain } = shadowOptions(fx, async () => ({
      status: "recommended",
      recommendedExecutorId: "beta"
    }));
    const result = await route(fx, "alpha", options);
    await drain();
    fx.store.recordRoutingExecutionOutcome(
      {
        decisionId: result.decisionId,
        executorId: "alpha",
        latencyMs: 10,
        success: true,
        timedOut: false,
        retryCount: 0,
        idempotencyKey: "outcome-1"
      },
      transition
    );
    expect(fx.store.listRoutingExecutionOutcomes(result.decisionId)).toHaveLength(1);
    expect(fx.store.listRouteShadowObservations(result.decisionId)[0]).toMatchObject({ agrees: false });
  });

  it("does not shadow replays, so a resume never re-queries the observer", async () => {
    const fx = open();
    let calls = 0;
    const { options, drain } = shadowOptions(fx, async () => {
      calls += 1;
      return { status: "no_recommendation" };
    });
    const first = await route(fx, "alpha", options);
    await drain();
    const second = await route(fx, "beta", options);
    await drain();
    expect(first.disposition).toBe("fresh");
    expect(second.disposition).toBe("resumed");
    expect(second.decisionId).toBe(first.decisionId);
    expect(calls).toBe(1);
  });

  it("does not shadow a sole-candidate decision", async () => {
    const fx = open(["alpha"]);
    let calls = 0;
    const { options, drain } = shadowOptions(fx, async () => {
      calls += 1;
      return { status: "no_recommendation" };
    });
    const result = await route(fx, "alpha", options);
    await drain();
    expect(result.reasonCode).toBe("deterministic_fallback");
    expect(calls).toBe(0);
  });

  it("keeps the observation table append-only with one row per decision", async () => {
    const fx = open();
    const { options, drain } = shadowOptions(fx, async () => ({ status: "no_recommendation" }));
    const result = await route(fx, "alpha", options);
    await drain();
    const again = fx.store.recordRouteShadowObservation(
      { decisionId: result.decisionId, status: "recommended", recommendedExecutorId: "beta" },
      transition
    );
    expect(again.status).toBe("no_recommendation");
    expect(fx.store.listRouteShadowObservations(result.decisionId)).toHaveLength(1);
    const db = (fx.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    expect(() => db.prepare(`UPDATE routing_shadow_observations SET agrees = 1`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM routing_shadow_observations`).run()).toThrow(/append-only/);
  });

  it("refuses a recommended status without an executor, and any non-shadow mode at the schema level", async () => {
    const fx = open();
    const result = await route(fx, "alpha");
    expect(() =>
      fx.store.recordRouteShadowObservation({ decisionId: result.decisionId, status: "recommended" }, transition)
    ).toThrow();
    const db = (fx.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    expect(() =>
      db
        .prepare(
          `INSERT INTO routing_shadow_observations (observation_id, decision_id, work_item_id, source, mode, status,
             authoritative_source, candidate_json, created_at)
           VALUES ('x', ?, ?, 'jev', 'advisory', 'no_recommendation', 'nimble', '[]', ?)`
        )
        .run(result.decisionId, fx.workItemId, now.toISOString())
    ).toThrow(/CHECK/);
  });

  it("requires a privileged transition to record", () => {
    const fx = open();
    expect(() =>
      (fx.store.recordRouteShadowObservation as (input: unknown, options?: unknown) => unknown)({
        decisionId: "x",
        status: "no_recommendation"
      })
    ).toThrow(/policy or domain service/);
  });
});

describe("Jev route shadow observer", () => {
  const candidates = [
    { id: "alpha", capabilities: ["fs.read"] },
    { id: "beta", capabilities: ["fs.read"] }
  ];
  const input = (signal: AbortSignal) => ({
    decisionId: "d",
    workItemId: "w",
    operationType: "fs.read",
    requiredCapabilities: ["fs.read"],
    authoritative: { executorId: "alpha", source: "nimble" as const },
    candidates,
    signal
  });
  const jevFetch =
    (answers: Record<string, number>): typeof fetch =>
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers: Object.fromEntries(Object.entries(answers).map(([key, p]) => [key, { type: "noul", noul: p }]))
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

  it("is inert while Jev is disabled", () => {
    const prior = process.env.ACS_JEV_ENABLED;
    delete process.env.ACS_JEV_ENABLED;
    try {
      expect(createJevRouteShadow({ recordRouteShadowObservation: () => undefined })).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env.ACS_JEV_ENABLED = prior;
    }
  });

  it("recommends the strictly most probable candidate and keeps ids out of question keys", async () => {
    let body = "";
    const observer = createJevRouteShadowObserver({
      enabled: true,
      fetchImpl: async (url, init) => {
        body = String(init?.body);
        return jevFetch({ fit_0: 0.2, fit_1: 0.9 })(url, init);
      }
    });
    const report = await observer(input(new AbortController().signal));
    expect(report).toMatchObject({ status: "recommended", recommendedExecutorId: "beta", confidence: 0.9 });
    expect(report.probabilities).toEqual({ alpha: 0.2, beta: 0.9 });
    expect(body).not.toContain('"alpha"');
  });

  it("reports ties and missing answers as no recommendation, never a guess", async () => {
    const tie = await createJevRouteShadowObserver({ enabled: true, fetchImpl: jevFetch({ fit_0: 0.5, fit_1: 0.5 }) })(
      input(new AbortController().signal)
    );
    expect(tie).toMatchObject({ status: "no_recommendation", failureReason: "tie" });
    const partial = await createJevRouteShadowObserver({ enabled: true, fetchImpl: jevFetch({ fit_0: 0.5 }) })(
      input(new AbortController().signal)
    );
    // An incomplete answer set is rejected by the adapter itself; nothing is guessed from the remainder.
    expect(partial).toMatchObject({ status: "degraded", failureReason: "NO_ADVICE" });
  });

  it("reports an unavailable runtime as degraded", async () => {
    const report = await createJevRouteShadowObserver({
      enabled: true,
      fetchImpl: async () => {
        throw new Error("connection refused");
      }
    })(input(new AbortController().signal));
    expect(report).toMatchObject({ status: "degraded", failureReason: "UNAVAILABLE" });
    expect(report.recommendedExecutorId).toBeUndefined();
  });
});
