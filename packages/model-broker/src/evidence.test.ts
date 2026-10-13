import { describe, expect, it } from "vitest";
import { GiB, iso, policy, store } from "./fixtures.test-support.js";
import type { RoutingDecision } from "./types.js";

const body = (overrides: Partial<Omit<RoutingDecision, "decisionId" | "replayed">> = {}): Omit<RoutingDecision, "decisionId" | "replayed"> => ({
  requestId: "r1",
  taskType: "code_generation",
  privacy: "internal",
  mode: "default_priority",
  ranking: [],
  rejected: [],
  computeHash: "h",
  createdAt: iso(),
  ...overrides
});
const outcome = (decisionId: string, attempt: number, extra: Record<string, unknown> = {}) => ({
  decisionId,
  attempt,
  providerId: "ollama",
  model: "small:4b",
  taskType: "code_generation",
  ok: true,
  latencyMs: 100,
  recordedAt: iso(attempt * 1000),
  ...extra
});
const NOW = new Date(iso(60_000));

describe("decisions", () => {
  it("stores once per request id and returns the first on replay", () => {
    const { store: s } = store();
    const first = s.recordDecision(body());
    expect(first.replayed).toBe(false);
    const second = s.recordDecision(body({ mode: "evidence", createdAt: iso(5000) }));
    expect(second).toMatchObject({ decisionId: first.decisionId, mode: "default_priority", replayed: true });
    expect(s.findDecision("r1")).toMatchObject({ decisionId: first.decisionId, replayed: true });
    expect(s.findDecision("absent")).toBeUndefined();
  });

  it("detects a stored decision that no longer matches its hash", () => {
    const { db, store: s } = store();
    s.recordDecision(body());
    db.exec("DROP TRIGGER model_route_decisions_no_update");
    db.exec(`UPDATE model_route_decisions SET body_json = replace(body_json, 'default_priority', 'evidence')`);
    expect(() => s.findDecision("r1")).toThrowError(expect.objectContaining({ code: "model_route_integrity" }));
  });

  it("stores no prompt: only request metadata", () => {
    const { db, store: s } = store();
    s.recordDecision(body());
    const stored = (db.prepare("SELECT body_json FROM model_route_decisions").get() as { body_json: string }).body_json;
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(
      ["computeHash", "createdAt", "mode", "privacy", "ranking", "rejected", "requestId", "taskType"].sort()
    );
  });
});

describe("outcomes and verifications", () => {
  it("records an outcome once per decision and attempt", () => {
    const { db, store: s } = store();
    const { decisionId } = s.recordDecision(body());
    const id = s.recordOutcome(outcome(decisionId, 1));
    expect(s.recordOutcome(outcome(decisionId, 1, { latencyMs: 999, ok: false, failureKind: "provider" }))).toBe(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_route_outcomes").get()).toEqual({ n: 1 });
    expect(s.nextAttempt(decisionId)).toBe(2);
  });

  it("stores unreported measurements as null, not zero", () => {
    const { db, store: s } = store();
    const { decisionId } = s.recordDecision(body());
    s.recordOutcome(outcome(decisionId, 1, { latencyMs: undefined }));
    expect(db.prepare("SELECT latency_ms, tokens_in, cost_micro_usd FROM model_route_outcomes").get()).toEqual({
      latency_ms: null,
      tokens_in: null,
      cost_micro_usd: null
    });
  });

  it("verifies only successful outcomes, once, and refuses a contradiction", () => {
    const { store: s } = store();
    const { decisionId } = s.recordDecision(body());
    const good = s.recordOutcome(outcome(decisionId, 1));
    const bad = s.recordOutcome(outcome(decisionId, 2, { ok: false, failureKind: "provider" }));
    s.recordVerification({ outcomeId: good, passed: true, verifier: "v", recordedAt: iso() });
    s.recordVerification({ outcomeId: good, passed: true, verifier: "v", recordedAt: iso(1) });
    expect(() => s.recordVerification({ outcomeId: good, passed: false, verifier: "v", recordedAt: iso() })).toThrowError(
      expect.objectContaining({ code: "model_route_verification_conflict" })
    );
    expect(() => s.recordVerification({ outcomeId: bad, passed: true, verifier: "v", recordedAt: iso() })).toThrowError(
      expect.objectContaining({ code: "model_route_verification_invalid" })
    );
    expect(() => s.recordVerification({ outcomeId: "f".repeat(64), passed: true, verifier: "v", recordedAt: iso() })).toThrowError(
      expect.objectContaining({ code: "model_route_outcome_unknown" })
    );
  });
});

describe("stats", () => {
  function seed(s: ReturnType<typeof store>["store"], passed: number, failed: number) {
    const { decisionId } = s.recordDecision(body());
    let attempt = 0;
    for (let i = 0; i < passed + failed; i += 1) {
      attempt += 1;
      const id = s.recordOutcome(outcome(decisionId, attempt, { latencyMs: 100 * attempt }));
      s.recordVerification({ outcomeId: id, passed: i < passed, verifier: "v", recordedAt: iso(attempt) });
    }
  }

  it("reports no correctness below the minimum sample size", () => {
    const { store: s } = store();
    seed(s, 3, 1);
    const stats = s.stats("ollama", "small:4b", "code_generation", policy(), NOW);
    expect(stats).toMatchObject({ attempts: 4, verified: 4, verifiedPassed: 3 });
    expect(stats.correctnessLowerBound).toBeUndefined();
  });

  it("reports a conservative lower bound once there are enough verified outcomes", () => {
    const { store: s } = store();
    seed(s, 9, 1);
    const stats = s.stats("ollama", "small:4b", "code_generation", policy(), NOW);
    expect(stats.correctnessLowerBound).toBeGreaterThan(0.55);
    expect(stats.correctnessLowerBound).toBeLessThan(0.9);
    expect(stats.latencyP50Ms).toBeDefined();
    expect(stats.meanCostMicroUsd).toBeUndefined();
    expect(stats.costReportedFor).toBe(0);
  });

  it("counts unverified successes as attempts but not as correctness evidence", () => {
    const { store: s } = store();
    const { decisionId } = s.recordDecision(body());
    for (let i = 1; i <= 10; i += 1) s.recordOutcome(outcome(decisionId, i));
    const stats = s.stats("ollama", "small:4b", "code_generation", policy(), NOW);
    expect(stats).toMatchObject({ attempts: 10, verified: 0 });
    expect(stats.correctnessLowerBound).toBeUndefined();
  });

  it("averages only reported costs and excludes failed attempts from latency", () => {
    const { store: s } = store();
    const { decisionId } = s.recordDecision(body());
    s.recordOutcome(outcome(decisionId, 1, { costMicroUsd: 100, latencyMs: 10 }));
    s.recordOutcome(outcome(decisionId, 2, { costMicroUsd: 300, latencyMs: 30 }));
    s.recordOutcome(outcome(decisionId, 3));
    s.recordOutcome(outcome(decisionId, 4, { ok: false, failureKind: "provider", latencyMs: 99_999 }));
    const stats = s.stats("ollama", "small:4b", "code_generation", policy(), NOW);
    expect(stats).toMatchObject({ meanCostMicroUsd: 200, costReportedFor: 2, providerFailures: 1 });
    expect(stats.latencyP95Ms).toBeLessThan(1000);
  });

  it("separates models and task types, and honors the evidence window", () => {
    const { store: s } = store();
    const { decisionId } = s.recordDecision(body());
    s.recordOutcome(outcome(decisionId, 1));
    s.recordOutcome(outcome(decisionId, 2, { model: "large:20b" }));
    s.recordOutcome(outcome(decisionId, 3, { taskType: "summarization" }));
    expect(s.stats("ollama", "small:4b", "code_generation", policy(), NOW).attempts).toBe(1);
    expect(s.stats("ollama", "small:4b", "code_generation", policy({ evidenceWindowMs: 500 }), new Date(iso(10_000_000))).attempts).toBe(0);
  });
});

describe("circuit from stored outcomes", () => {
  it("opens after repeated provider failures and closes after a success", () => {
    const { store: s } = store();
    const { decisionId } = s.recordDecision(body());
    for (let i = 1; i <= 3; i += 1) s.recordOutcome(outcome(decisionId, i, { ok: false, failureKind: "provider", recordedAt: iso(i * 1000) }));
    expect(s.circuit("ollama", policy(), new Date(iso(10_000)))).toBe("open");
    expect(s.circuit("ollama", policy(), new Date(iso(10_000_000)))).toBe("half_open");
    s.recordOutcome(outcome(decisionId, 4, { recordedAt: iso(20_000_000) }));
    expect(s.circuit("ollama", policy(), new Date(iso(20_001_000)))).toBe("closed");
    expect(s.circuit("other", policy(), NOW)).toBe("closed");
  });
});

describe("append-only", () => {
  it("refuses update, delete and replace on all three tables", () => {
    const { db, store: s } = store();
    const { decisionId } = s.recordDecision(body());
    const outcomeId = s.recordOutcome(outcome(decisionId, 1));
    s.recordVerification({ outcomeId, passed: true, verifier: "v", recordedAt: iso() });
    for (const table of ["model_route_decisions", "model_route_outcomes", "model_route_verifications"]) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
    }
    expect(() => db.exec(`UPDATE model_route_decisions SET mode = 'evidence'`)).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE model_route_outcomes SET ok = 0, failure_kind = 'provider'`)).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE model_route_verifications SET passed = 0`)).toThrow(/append-only/);
    expect(() =>
      db.prepare(`INSERT OR REPLACE INTO model_route_verifications (outcome_id, passed, verifier, recorded_at) VALUES (?, 0, 'x', ?)`).run(outcomeId, iso())
    ).toThrow(/append-only/);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO model_route_outcomes (outcome_id, decision_id, attempt, provider_id, model, task_type, ok, recorded_at)
           VALUES (?, ?, 1, 'p', 'm', 't', 1, ?)`
        )
        .run("a".repeat(64), decisionId, iso())
    ).toThrow(/append-only/);
  });

  it("rejects an outcome that claims success and failure kind together", () => {
    const { db, store: s } = store();
    const { decisionId } = s.recordDecision(body());
    expect(() =>
      db
        .prepare(
          `INSERT INTO model_route_outcomes (outcome_id, decision_id, attempt, provider_id, model, task_type, ok, failure_kind, recorded_at)
           VALUES (?, ?, 9, 'p', 'm', 't', 1, 'provider', ?)`
        )
        .run("b".repeat(64), decisionId, iso())
    ).toThrow();
    expect(GiB).toBeGreaterThan(0);
  });
});
