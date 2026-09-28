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

  it("re-applies redaction and strips raw argument material", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234";
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
    expect(Object.keys((calls[0] as { questions: object }).questions)).toHaveLength(5);
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
