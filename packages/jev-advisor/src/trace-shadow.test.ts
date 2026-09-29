import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
  CANONICAL_TRACE_GENESIS_HASH,
  canonicalTraceEventHash,
  canonicalTracePayloadHash,
  type CanonicalTraceEvent,
  type CanonicalTraceEventKind
} from "@agent-control-stack/work-items";
import {
  JEV_TRACE_FAILURE_MODES,
  JEV_TRACE_QUESTION_SET_VERSION,
  JEV_TRACE_QUESTIONS,
  classifyJevTrace,
  projectCanonicalTraceForJev,
  runJevTraceShadow,
  type JevCapability
} from "./index.js";

const FULL_CAPABILITY: JevCapability = {
  promptVersion: "typed-v1",
  supportsNoul: true,
  supportsChoice: true,
  supportsScore: true,
  fingerprint: "trace-test-full"
};

function trace(kinds: readonly CanonicalTraceEventKind[], payloads: Record<number, Record<string, unknown>> = {}) {
  const events: CanonicalTraceEvent[] = [];
  let prev = CANONICAL_TRACE_GENESIS_HASH;
  for (let index = 0; index < kinds.length; index += 1) {
    const payload = payloads[index] ?? {};
    const event: CanonicalTraceEvent = {
      schema_version: CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
      event_id: ("0000000000000000000000000" + (index + 1).toString(32).toUpperCase()).slice(-26),
      trace_id: "ab".repeat(16),
      span_id: (index + 1).toString(16).padStart(16, "0"),
      source: { system: "dc", component: "jace-commander", instance: "jc-test", release_sha: "unreleased" },
      class: "evidence",
      kind: kinds[index],
      actor: { id: "jace-commander", type: "system" },
      subject: { work_item_id: "wrk_trace_1" },
      seq: index + 1,
      prev_hash: prev,
      ts: "2026-09-28T12:00:" + String(index).padStart(2, "0") + ".000Z",
      payload,
      payload_hash: canonicalTracePayloadHash(payload)
    };
    events.push(event);
    prev = canonicalTraceEventHash(event);
  }
  return events;
}

function fullAnswerBody() {
  const probabilities = Object.fromEntries(JEV_TRACE_FAILURE_MODES.map((mode) => [mode, 0]));
  probabilities.verifier_fail = 0.82;
  probabilities.other = 0.18;
  return {
    model: "jev-typed",
    answers: {
      failure_mode: { type: "choice", choice: "verifier_fail", probabilities, confidence: 0.82 },
      should_escalate: { type: "noul", noul: 0.91 },
      needs_maker_checker: { type: "noul", noul: 0.84 },
      context_rot: { type: "noul", noul: 0.12 },
      recovery_urgency: {
        type: "score",
        score: 3.7,
        probabilities: { "0": 0.01, "1": 0.02, "2": 0.07, "3": 0.1, "4": 0.8 },
        confidence: 0.8
      },
      capability_issuance_latency: {
        type: "score",
        score: 1,
        probabilities: { "0": 0.01, "1": 0.02, "2": 0.97 },
        confidence: 0.8
      },
      execution_latency: {
        type: "score",
        score: 1,
        probabilities: { "0": 0.01, "1": 0.02, "2": 0.97 },
        confidence: 0.8
      }
    }
  };
}

describe("canonical trace projection for Jev", () => {
  it("is deterministic, ordered, bounded, and preserves failure-relevant evidence", () => {
    const kinds: CanonicalTraceEventKind[] = ["run.received", "run.started"];
    for (let index = 0; index < 50; index += 1) {
      kinds.push(index % 2 === 0 ? "tool.call.started" : "tool.call.finished");
    }
    kinds.push("verification.finished", "promotion.blocked", "run.failed");
    const events = trace(kinds);
    const first = projectCanonicalTraceForJev(events, { maxEvents: 12, maxSerializedChars: 4_000 });
    const second = projectCanonicalTraceForJev(events, { maxEvents: 12, maxSerializedChars: 4_000 });
    expect(second).toEqual(first);
    expect(first.events.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(4_000);
    expect(first.events.map((event) => event.seq)).toEqual(
      [...first.events.map((event) => event.seq)].sort((a, b) => a - b)
    );
    expect(first.events.some((event) => event.kind === "run.failed")).toBe(true);
    expect(first.events.some((event) => event.kind === "promotion.blocked")).toBe(true);
    expect(first.truncated).toBe(true);
  });

  it("keeps bounded execution correlation without exposing raw tool material", () => {
    const events = trace(["executor.started", "tool.call.started", "tool.call.finished"], {
      0: {
        executor: "desktop_commander",
        tool: "read_file",
        action_hash: "a".repeat(64),
        invocation_hash: "b".repeat(64),
        path: "/secret/path"
      },
      1: {
        tool: "read_file",
        invocation_hash: "b".repeat(64),
        arguments_digest: "c".repeat(64),
        argument_count: 1,
        arguments: { path: "/secret/path" }
      },
      2: {
        tool: "read_file",
        status: "failed",
        invocation_hash: "b".repeat(64),
        result_hash: "d".repeat(64),
        duration_ms: 17,
        truncated: false,
        is_error: true,
        outcome: "runtime_error",
        stdout: "must-not-project"
      }
    });
    const projection = projectCanonicalTraceForJev(events);
    expect(projection.events).toHaveLength(3);
    expect(projection.events[0]?.detail).toMatchObject({
      executor: "desktop_commander",
      tool: "read_file",
      action_hash: "a".repeat(64),
      invocation_hash: "b".repeat(64)
    });
    expect(projection.events[1]?.detail).toMatchObject({
      tool: "read_file",
      invocation_hash: "b".repeat(64),
      arguments_digest: "c".repeat(64),
      argument_count: 1
    });
    expect(projection.events[2]?.detail).toMatchObject({
      tool: "read_file",
      status: "failed",
      result_hash: "d".repeat(64),
      duration_ms: 17,
      truncated: false,
      is_error: true,
      outcome: "runtime_error"
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("/secret/path");
    expect(serialized).not.toContain("must-not-project");
    expect(serialized).not.toContain('"arguments":');
  });

  it("keeps bounded promotion evidence without exposing publication/provider details", () => {
    const events = trace(["promotion.blocked", "promotion.completed"], {
      0: {
        stage: "pull_request",
        reason_code: "pull_request_failed",
        external_state: "branch_pushed",
        provider_error: "must-not-project",
        pull_request_url: "https://example.invalid/private"
      },
      1: {
        publication_id: "publication-work-1",
        commit_sha: "a".repeat(40),
        transport: "pull_request",
        pull_request_url: "https://example.invalid/private"
      }
    });
    const projection = projectCanonicalTraceForJev(events);
    expect(projection.events[0]?.detail).toMatchObject({
      stage: "pull_request",
      reason_code: "pull_request_failed",
      external_state: "branch_pushed"
    });
    expect(projection.events[1]?.detail).toMatchObject({
      publication_id: "publication-work-1",
      commit_sha: "a".repeat(40),
      transport: "pull_request"
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("must-not-project");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("pull_request_url");
  });

  it("keeps bounded verification evidence without exposing requirement or finding content", () => {
    const events = trace(["verification.started", "verification.finished"], {
      0: {
        mode: "independent_review",
        policy_version: "acs.verification-policy.v1",
        reviewers_required: 1,
        requirement: { secret: "must-not-project" }
      },
      1: {
        outcome: "attempt_accepted",
        accepted: true,
        evidence_manifest_hash: "e".repeat(64),
        review_finding_count: 2,
        policy_version: "acs.verification-policy.v1",
        finding: { prose: "must-not-project" }
      }
    });
    const projection = projectCanonicalTraceForJev(events);
    expect(projection.events).toHaveLength(2);
    expect(projection.events[0]?.detail).toMatchObject({
      mode: "independent_review",
      policy_version: "acs.verification-policy.v1",
      reviewers_required: 1
    });
    expect(projection.events[1]?.detail).toMatchObject({
      outcome: "attempt_accepted",
      accepted: true,
      evidence_manifest_hash: "e".repeat(64),
      review_finding_count: 2,
      policy_version: "acs.verification-policy.v1"
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("must-not-project");
    expect(serialized).not.toContain('"requirement":');
    expect(serialized).not.toContain('"finding":');
  });

  it("keeps bounded capability issuance evidence without exposing capability material", () => {
    const events = trace(["capability.issued"], {
      0: {
        contract: "acs.dc.v1",
        tool: "read_file",
        runtime_id: "dc-runtime",
        lease_epoch: 2,
        approval_bound: false,
        capability_secret: "must-not-project"
      }
    });
    const projection = projectCanonicalTraceForJev(events);
    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]).toMatchObject({
      kind: "capability.issued",
      detail: {
        contract: "acs.dc.v1",
        tool: "read_file",
        runtime_id: "dc-runtime",
        lease_epoch: 2,
        approval_bound: false
      }
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-project");
  });

  it("re-applies redaction and strips raw argument material", () => {
    const secret = "«redacted:token…»";
    const events = trace(["tool.call.started", "tool.call.finished"], {
      0: { tool: "privileged_exec", argv: ["/bin/tool", secret], note: "Bearer " + secret },
      1: { tool: "privileged_exec", status: "failed", message: "token=" + secret }
    });
    const projection = projectCanonicalTraceForJev(events);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("argv");
    expect(projection.trace_id).toBe("ab".repeat(16));
    expect(projection.work_item_id).toBe("wrk_trace_1");
  });

  it("rejects mixed traces rather than inventing correlation", () => {
    const events = trace(["run.started", "run.completed"]);
    events[1] = { ...events[1], trace_id: "cd".repeat(16) };
    expect(() => projectCanonicalTraceForJev(events)).toThrow(/one canonical trace_id/);
  });
});

describe("Jev canonical trace classifier", () => {
  it("declares the requested taxonomy and primitive types", () => {
    expect(JEV_TRACE_QUESTION_SET_VERSION).toBe("jev-trace@1");
    expect(JEV_TRACE_FAILURE_MODES).toEqual([
      "healthy",
      "tool_loop",
      "budget_burn",
      "instruction_drift",
      "verifier_fail",
      "stagnation",
      "hallucination",
      "policy_denied",
      "worktree_collision",
      "other"
    ]);
    expect(JEV_TRACE_QUESTIONS.failure_mode.type).toBe("choice");
    expect(JEV_TRACE_QUESTIONS.should_escalate.type).toBe("noul");
    expect(JEV_TRACE_QUESTIONS.needs_maker_checker.type).toBe("noul");
    expect(JEV_TRACE_QUESTIONS.context_rot.type).toBe("noul");
    expect(JEV_TRACE_QUESTIONS.recovery_urgency.type).toBe("score");
  });

  it("does not fake Choice or Score on the current Noul-only runtime", async () => {
    let fetches = 0;
    const result = await classifyJevTrace(trace(["run.started", "run.failed"]), {
      enabled: true,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(JSON.stringify(fullAnswerBody()), { status: 200 });
      }
    });
    expect(fetches).toBe(0);
    expect(result.result).toMatchObject({ degraded: true, failureReason: "INCOMPATIBLE_MODEL", answers: {} });
    expect(result.telemetry.correlation).toEqual({
      trace_id: "ab".repeat(16),
      work_item_id: "wrk_trace_1"
    });
    expect(result.telemetry.actual_outcome).toBe("run.failed");
  });

  it("executes one typed mixed request against a future full-capability runtime", async () => {
    const calls: unknown[] = [];
    const result = await classifyJevTrace(
      trace(["run.started", "tool.call.finished", "verification.finished", "run.failed"]),
      {
        enabled: true,
        capabilityProfile: FULL_CAPABILITY,
        fetchImpl: async (_url, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(fullAnswerBody()), { status: 200 });
        }
      }
    );
    expect(calls).toHaveLength(1);
    expect(Object.keys((calls[0] as { questions: object }).questions)).toHaveLength(7);
    expect(result.result.degraded).toBe(false);
    expect(result.result.answers.failure_mode).toMatchObject({
      type: "choice",
      choice: "verifier_fail",
      confidence: 0.82
    });
    expect(result.result.answers.recovery_urgency).toMatchObject({ type: "score", score: 3.7 });
    expect(result.telemetry.question_set_version).toBe("jev-trace@1");
    expect(result.telemetry.observations.failure_mode.primitive).toBe("choice");
  });

  it("swallows transport and sink failures in the shadow-only entrypoint", async () => {
    const events = trace(["run.started", "run.failed"]);
    await expect(
      runJevTraceShadow(events, {
        enabled: true,
        capabilityProfile: FULL_CAPABILITY,
        fetchImpl: async () => {
          throw new TypeError("offline");
        },
        sink: () => {
          throw new Error("sink failed");
        }
      })
    ).resolves.toMatchObject({ result: { degraded: true, failureReason: "UNAVAILABLE" } });
  });
});
