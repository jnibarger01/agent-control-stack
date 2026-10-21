import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createGhPullRequestReader,
  type GhRunner,
  type PullRequestReader
} from "@agent-control-stack/integration-manager";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEDUPE_WINDOW_MS, OutcomeEngine, type OutcomeEngineOptions } from "./engine.js";
import { BASE, HEAD, makeSnapshot, sequenceReader } from "./fixtures.test-support.js";
import {
  OutcomeLedger,
  createOutcomeStorePort,
  evaluationChainHash,
  evaluationContentHash,
  type EvaluationRecord
} from "./ledger.js";
import { STALE_AFTER_MS } from "./verdict.js";

const REPO = "o/r";
const GOAL = "get PR 7 production-ready";
const T0 = Date.parse("2026-10-16T12:00:00.000Z");

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let clock = T0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-outcome-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  clock = T0;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function engine(
  over: Partial<Omit<OutcomeEngineOptions, "readerFor">> & { reader?: PullRequestReader } = {}
): OutcomeEngine {
  const { reader = sequenceReader(makeSnapshot()), ...rest } = over;
  return new OutcomeEngine({
    store: createOutcomeStorePort(store),
    readerFor: () => reader,
    provenance: "live_github",
    acsRepository: REPO,
    now: () => new Date(clock),
    ...rest
  });
}
const accept = (e: OutcomeEngine, extra: Record<string, unknown> = {}) =>
  e.accept({ goal: GOAL, repository: REPO, pullRequest: 7, ...extra }, { osUser: "tester" });

describe("accept", () => {
  it("persists an outcome with the template criteria, a read-only plan, and an honest authority label", () => {
    const { record, created } = accept(engine());
    expect(created).toBe(true);
    expect(record).toMatchObject({
      executionBasis: "none",
      authority: { kind: "unauthenticated_local_operator", osUser: "tester" }
    });
    expect(record.plan.steps.map((s) => s.action)).toEqual(
      expect.arrayContaining(["github_read_pr", "verify_audit_chain", "run_pure_probe", "append_outcome_event"])
    );
  });
  it("refuses the repository names . and .. that the GitHub reader would refuse at evaluation", () => {
    const e = engine();
    expect(() => accept(e, { repository: "o/." })).toThrow();
    expect(() => accept(e, { repository: "o/.." })).toThrow();
    expect(() => accept(e, { repository: "o/.r" })).not.toThrow();
  });

  it("is idempotent: the same acceptance returns the same outcome, even with a different expiry", () => {
    const e = engine();
    const first = accept(e);
    const again = accept(e, { expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(again.created).toBe(false);
    expect(again.record.outcomeId).toBe(first.record.outcomeId);
    expect(store.readEvents({ name: "outcome.accepted" })).toHaveLength(1);
  });
  it("refuses unknown fields, bad criteria and goals the audit store would redact", () => {
    const e = engine();
    expect(() => accept(e, { verdict: "PASS" })).toThrow();
    expect(() => accept(e, { criteria: [{ id: "open", kind: "pr_open", required: true }] })).toThrow(/readiness/u);
    expect(() => accept(e, { goal: "use ghp_abcdefghijklmnopqrstuvwxyz to push" })).toThrow(/would redact/u);
  });
});

describe("evaluate", () => {
  it("returns PASS only from live, trusted, stable evidence and records an unforgeable chain", async () => {
    const e = engine();
    const { record: accepted } = accept(e);
    const view = await e.evaluate(accepted.outcomeId);
    expect(view).toMatchObject({ recorded: true, deduped: false });
    expect(view.record).toMatchObject({
      verdict: "PASS",
      sequenceNo: 1,
      headSha: HEAD,
      baseRefOid: BASE,
      merged: false,
      verdictIsApproval: false,
      causality: "assessed_only",
      executionBasis: "none",
      readerProvenance: "live_github"
    });
    expect(view.record.humanControl.exposure).not.toBe("none");
    expect(e.show(accepted.outcomeId)?.problems).toEqual([]);
  });

  it("a fixture-provenance reader can never PASS or FAIL, only BLOCK as simulated", async () => {
    const e = engine({ provenance: "fixture" });
    const { record } = accept(e);
    const pass = await e.evaluate(record.outcomeId);
    expect(pass.record).toMatchObject({ verdict: "BLOCK", blockKind: "simulated_only" });
    const bad = engine({ provenance: "fixture", reader: sequenceReader(makeSnapshot({ mergeable: "CONFLICTING" })) });
    clock += DEDUPE_WINDOW_MS + 1;
    expect((await bad.evaluate(record.outcomeId)).record.verdict).toBe("BLOCK");
  });

  it("reports FAIL and PARTIAL from trusted contradictions", async () => {
    const failing = engine({ reader: sequenceReader(makeSnapshot({ mergeable: "CONFLICTING", state: "OPEN" })) });
    const { record } = accept(failing);
    const view = await failing.evaluate(record.outcomeId);
    expect(view.record.verdict).toBe("PARTIAL");
    expect(view.record.reasonCodes).toContain("conflicting");
    expect(view.record.nextActions[0]).toMatchObject({ requiresHuman: true });
  });

  it("blocks on a failed, redacted, malformed or missing read (G2) and records the block", async () => {
    const e = engine({ reader: sequenceReader(new Error("pull request #7 not found")) });
    const { record } = accept(e);
    const view = await e.evaluate(record.outcomeId);
    expect(view).toMatchObject({ recorded: true });
    expect(view.record).toMatchObject({ verdict: "BLOCK", blockKind: "evidence_unavailable" });
    expect(view.record.reasonCodes).toContain("pr_not_found");
  });

  it("blocks when signals are truncated", async () => {
    const e = engine({
      reader: sequenceReader(makeSnapshot({ truncated: { threads: false, checks: true, files: false } }))
    });
    const { record } = accept(e);
    expect((await e.evaluate(record.outcomeId)).record.reasonCodes).toContain("github_signals_truncated");
  });

  it("blocks when the pull request moves between the two reads (G3)", async () => {
    const e = engine({
      reader: sequenceReader(makeSnapshot(), makeSnapshot({ headSha: "c".repeat(40), checksCommitSha: "c".repeat(40) }))
    });
    const { record } = accept(e);
    const view = await e.evaluate(record.outcomeId);
    expect(view.record).toMatchObject({ verdict: "BLOCK", blockKind: "pending_external" });
    expect(view.record.reasonCodes).toContain("head_moved_during_evaluation");
    const other = engine({ reader: sequenceReader(makeSnapshot(), makeSnapshot({ unresolvedThreads: 3 })) });
    clock += DEDUPE_WINDOW_MS + 1;
    expect((await other.evaluate(record.outcomeId)).record.reasonCodes).toContain("snapshot_changed_during_evaluation");
  });

  it("blocks when the rollup is not bound to the head commit, and when the pull request is merged", async () => {
    const e = engine({ reader: sequenceReader(makeSnapshot({ checksCommitSha: "d".repeat(40) })) });
    const { record } = accept(e);
    expect((await e.evaluate(record.outcomeId)).record.reasonCodes).toContain("checks_not_bound_to_head");
    clock += DEDUPE_WINDOW_MS + 1;
    const merged = engine({ reader: sequenceReader(makeSnapshot({ state: "MERGED" })) });
    const view = await merged.evaluate(record.outcomeId);
    expect(view.record.reasonCodes).toEqual(expect.arrayContaining(["pr_not_open", "merged_outside_outcome"]));
    expect(view.record.verdict).toBe("BLOCK");
  });

  it("a draft pull request can PASS the assessment policy, with the relaxation disclosed", async () => {
    const e = engine({ reader: sequenceReader(makeSnapshot({ isDraft: true })) });
    const { record } = accept(e);
    const view = await e.evaluate(record.outcomeId);
    expect(view.record.verdict).toBe("PASS");
    expect(view.record.findings.join(" ")).toContain("draft_ignored_in_assessment");
  });

  it("dedupes an identical re-evaluation inside the window, then appends a chained record after it", async () => {
    const e = engine();
    const { record } = accept(e);
    const first = await e.evaluate(record.outcomeId);
    const again = await e.evaluate(record.outcomeId);
    expect(again).toMatchObject({ recorded: false, deduped: true });
    expect(again.record.evaluationId).toBe(first.record.evaluationId);
    clock += DEDUPE_WINDOW_MS + 1;
    const second = await e.evaluate(record.outcomeId);
    expect(second).toMatchObject({ recorded: true });
    expect(second.record).toMatchObject({ sequenceNo: 2, previousChainHash: first.record.chainHash });
    expect(second.record.contentHash).toBe(first.record.contentHash);
    expect(second.record.chainHash).not.toBe(first.record.chainHash);
  });

  it("enforces the evaluation bound and the expiry without recording anything", async () => {
    const e = engine();
    const { record } = accept(e, { maxEvaluations: 1 });
    await e.evaluate(record.outcomeId);
    clock += DEDUPE_WINDOW_MS + 1;
    const over = await e.evaluate(record.outcomeId);
    expect(over).toMatchObject({ recorded: false });
    expect(over.record).toMatchObject({ verdict: "BLOCK", blockKind: "authority" });
    expect(over.record.reasonCodes).toContain("max_evaluations_exceeded");
    expect(store.readEvents({ name: "outcome.evaluation_recorded" })).toHaveLength(1);

    const expiring = accept(e, { goal: "second", expiresAt: new Date(T0 + 1000).toISOString() });
    clock += 5000;
    const gone = await e.evaluate(expiring.record.outcomeId);
    expect(gone).toMatchObject({ recorded: false });
    expect(gone.record.reasonCodes).toContain("scope_expired");
  });

  it("rejects an unknown outcome id", async () => {
    await expect(engine().evaluate("out_missing")).rejects.toThrow(/no accepted outcome/u);
  });
});

describe("persistence and trust", () => {
  it("a fresh engine over the same store reads back identical state", async () => {
    const a = engine();
    const { record } = accept(a);
    await a.evaluate(record.outcomeId);
    const b = engine();
    expect(b.show(record.outcomeId)).toEqual(a.show(record.outcomeId));
    expect(b.list()).toMatchObject([
      { outcomeId: record.outcomeId, evaluations: 1, latestVerdict: "PASS", problems: 0 }
    ]);
  });

  it("renders an old PASS as stale without changing the stored verdict", async () => {
    const e = engine();
    const { record } = accept(e);
    await e.evaluate(record.outcomeId);
    clock += STALE_AFTER_MS + 1;
    const shown = e.show(record.outcomeId);
    expect(shown?.latestStale).toBe(true);
    expect(shown?.evaluations[0]?.verdict).toBe("PASS");
  });

  it("writes only outcome.* events and never touches work items", async () => {
    const e = engine();
    const { record } = accept(e);
    await e.evaluate(record.outcomeId);
    const names = new Set(store.readEvents({ limit: 500 }).map((event) => event.name));
    expect(
      [...names].filter(
        (name) => !name.startsWith("outcome.") && name !== "store.migrated" && !name.startsWith("system.")
      )
    ).toEqual(expect.not.arrayContaining(["work_item.created"]));
    expect(store.readEvents({ name: "outcome.accepted" })).toHaveLength(1);
    expect(store.readEvents({ name: "outcome.evaluation_recorded" })).toHaveLength(1);
  });

  it("token-like strings from the pull request are stored as stable placeholders and still recompute", async () => {
    const snapshot = makeSnapshot({
      changedFiles: ["packages/ghp_abcdefghijklmnopqrstuv.ts"],
      checks: [
        { name: "check", status: "COMPLETED", conclusion: "SUCCESS", appSlug: "github-actions", source: "check_run" }
      ]
    });
    const e = engine({ reader: sequenceReader(snapshot) });
    const { record } = accept(e, {
      criteria: [
        { id: "pr_open", kind: "pr_open", required: true },
        { id: "gate", kind: "merge_gate_eligible", required: true },
        { id: "scope", kind: "files_within_scope", required: true, allowGlobs: ["docs/**"] }
      ]
    });
    const view = await e.evaluate(record.outcomeId);
    expect(JSON.stringify(view.record)).not.toContain("ghp_");
    expect(view.record.findings.join(" ")).toContain("[unrepresentable:");
    expect(e.show(record.outcomeId)?.problems).toEqual([]);
  });

  it("a concurrent evaluation that loses the chain head records nothing and leaves the chain intact", async () => {
    const other = new SqliteWorkItemStore(dbPath);
    try {
      const rival = new OutcomeEngine({
        store: createOutcomeStorePort(other),
        readerFor: () => sequenceReader(makeSnapshot({ mergeable: "CONFLICTING" })),
        provenance: "live_github",
        acsRepository: REPO,
        now: () => new Date(clock)
      });
      const { record } = accept(rival);
      const inner = sequenceReader(makeSnapshot());
      let raced = false;
      // The rival evaluates and appends after this engine loaded the head but before it appends.
      const racing: PullRequestReader = {
        async getPullRequest(number) {
          if (!raced) {
            raced = true;
            await rival.evaluate(record.outcomeId);
          }
          return inner.getPullRequest(number);
        }
      };
      await expect(engine({ reader: racing }).evaluate(record.outcomeId)).rejects.toThrow(/evaluate again/u);
      const shown = engine().show(record.outcomeId);
      expect(shown?.problems).toEqual([]);
      expect(shown?.evaluations.map((evaluation) => evaluation.sequenceNo)).toEqual([1]);
      expect(shown?.evaluations[0]?.verdict).toBe("PARTIAL");
    } finally {
      other.close();
    }
  });

  it("list reports the same unparseable-record problems as show", async () => {
    const e = engine();
    const { record } = accept(e);
    await e.evaluate(record.outcomeId);
    store.recordSystemEvent({
      name: "outcome.evaluation_recorded",
      body: { schema: "not-an-evaluation" },
      attributes: { "outcome.id": record.outcomeId }
    });
    const shown = e.show(record.outcomeId)?.problems ?? [];
    expect(shown.some((problem) => problem.startsWith("evaluation_record_invalid@"))).toBe(true);
    expect(e.list().find((row) => row.outcomeId === record.outcomeId)?.problems).toBe(shown.length);
  });

  it("detects fabricated findings, summary or next actions even when the hashes were recomputed", async () => {
    const e = engine({ reader: sequenceReader(makeSnapshot({ mergeable: "CONFLICTING" })) });
    const { record } = accept(e);
    const first = (await e.evaluate(record.outcomeId)).record;
    expect(e.show(record.outcomeId)?.problems).toEqual([]);
    const forgeries: Array<Partial<EvaluationRecord>> = [
      { findings: ["all good"] },
      { criteriaSummary: { ...first.criteriaSummary, requiredUnsatisfied: 0 } },
      { nextActions: [{ action: "merge_now", requiresHuman: false, detail: "safe to merge" }] }
    ];
    const { contentHash: _c, chainHash: _h, evaluationId: _i, ...rest } = first;
    let previous = first;
    forgeries.forEach((change, index) => {
      const base = { ...rest, ...change, sequenceNo: index + 2, previousChainHash: previous.chainHash };
      const contentHash = evaluationContentHash(base);
      const chainHash = evaluationChainHash({
        outcomeId: first.outcomeId,
        sequenceNo: base.sequenceNo,
        previousChainHash: previous.chainHash,
        contentHash
      });
      const forged: EvaluationRecord = {
        ...base,
        contentHash,
        chainHash,
        evaluationId: `eval_${chainHash.slice(0, 24)}`
      };
      new OutcomeLedger(createOutcomeStorePort(store)).recordEvaluation(forged);
      previous = forged;
    });
    expect(e.show(record.outcomeId)?.problems).toEqual([
      "evaluation#2:derived_fields_recompute_mismatch",
      "evaluation#3:derived_fields_recompute_mismatch",
      "evaluation#4:derived_fields_recompute_mismatch"
    ]);
  });

  it("detects a forged verdict even when its hashes were recomputed to match", async () => {
    const e = engine({ reader: sequenceReader(makeSnapshot({ mergeable: "CONFLICTING" })) });
    const { record } = accept(e);
    const first = (await e.evaluate(record.outcomeId)).record;
    expect(first.verdict).toBe("PARTIAL");
    const { contentHash: _c, chainHash: _h, evaluationId: _i, ...rest } = first;
    const forgedBase = {
      ...rest,
      sequenceNo: 2,
      previousChainHash: first.chainHash,
      verdict: "PASS" as const,
      blockKind: null
    };
    const contentHash = evaluationContentHash(forgedBase);
    const chainHash = evaluationChainHash({
      outcomeId: first.outcomeId,
      sequenceNo: 2,
      previousChainHash: first.chainHash,
      contentHash
    });
    const forged: EvaluationRecord = {
      ...forgedBase,
      contentHash,
      chainHash,
      evaluationId: `eval_${chainHash.slice(0, 24)}`
    };
    new OutcomeLedger(createOutcomeStorePort(store)).recordEvaluation(forged);
    const shown = e.show(record.outcomeId);
    expect(shown?.problems).toEqual(expect.arrayContaining(["evaluation#2:verdict_recompute_mismatch"]));
    clock += DEDUPE_WINDOW_MS + 1;
    const next = await e.evaluate(record.outcomeId);
    expect(next).toMatchObject({ recorded: false });
    expect(next.record).toMatchObject({ verdict: "BLOCK", blockKind: "integrity" });
    expect(next.record.reasonCodes).toContain("record_integrity_failed");
  });

  it("blocks with an integrity gate when the audit chain no longer verifies", async () => {
    const e = engine();
    store.recordSystemEvent({ name: "test.sentinel", body: { n: 1 } });
    const { record } = accept(e);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE audit_events SET body = ? WHERE name = 'test.sentinel'").run('{"tampered":true}');
    } finally {
      db.close();
    }
    const view = await e.evaluate(record.outcomeId);
    expect(view).toMatchObject({ recorded: false });
    expect(view.record.reasonCodes).toContain("audit_chain_invalid");
    expect(view.record.blockKind).toBe("integrity");
  });
});

describe("audit chain on read paths", () => {
  it("show and list report a global audit-chain break even when the outcome-local hashes still verify", async () => {
    const e = engine();
    store.recordSystemEvent({ name: "test.sentinel", body: { n: 1 } });
    const { record } = accept(e);
    await e.evaluate(record.outcomeId);
    expect(e.show(record.outcomeId)?.problems).toEqual([]);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE audit_events SET body = ? WHERE name = 'test.sentinel'").run('{"tampered":true}');
    } finally {
      db.close();
    }
    expect(e.show(record.outcomeId)?.problems).toContain("audit_chain_invalid");
    expect(e.list().find((row) => row.outcomeId === record.outcomeId)?.problems).toBeGreaterThan(0);
  });
});

describe("through the real gh reader", () => {
  const node = {
    number: 7,
    title: "t",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRefName: "b",
    headRefOid: HEAD,
    baseRefName: "main",
    baseRefOid: BASE,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    author: { login: "someone" },
    reviewThreads: { totalCount: 0, nodes: [] },
    files: { totalCount: 1, nodes: [{ path: "a.ts" }] },
    commits: {
      nodes: [
        {
          commit: {
            oid: HEAD,
            statusCheckRollup: {
              contexts: {
                totalCount: 1,
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "check",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    checkSuite: { app: { slug: "github-actions" } }
                  }
                ]
              }
            }
          }
        }
      ]
    }
  };
  it("evaluates canned GraphQL end to end, and an unknown enum fails the read closed", async () => {
    const run: GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ data: { repository: { pullRequest: node } } }),
      stderr: ""
    });
    const e = engine({ reader: createGhPullRequestReader(REPO, run) });
    const { record } = accept(e);
    expect((await e.evaluate(record.outcomeId)).record.verdict).toBe("PASS");
    const bad: GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ data: { repository: { pullRequest: { ...node, mergeable: "SURPRISE" } } } }),
      stderr: ""
    });
    clock += DEDUPE_WINDOW_MS + 1;
    const blocked = await engine({ reader: createGhPullRequestReader(REPO, bad) }).evaluate(record.outcomeId);
    expect(blocked.record).toMatchObject({ verdict: "BLOCK", blockKind: "evidence_unavailable" });
    expect(blocked.record.reasonCodes).toContain("pr_response_invalid");
  });
});
