import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalTraceEventHash, canonicalTraceJson } from "@agent-control-stack/work-items";
import {
  JC_LOCAL_TRACE_EVENT_TYPES,
  canonicalKindsForJcEvent,
  normalizeJcLoopTrace,
  verifyJcLocalTrace,
  type JcLocalTraceEvent,
  type JcLocalTraceEventType
} from "./jc-looptrace-normalizer.js";

const GENESIS = "0".repeat(64);
const TS = "2026-09-28T12:00:00.000Z";

function localChain(types: readonly JcLocalTraceEventType[], payloads: Record<number, Record<string, unknown>> = {}) {
  const events: JcLocalTraceEvent[] = [];
  let prev = GENESIS;
  for (let seq = 0; seq < types.length; seq += 1) {
    const body = {
      run_id: "jc-test-run",
      seq,
      ts: TS,
      type: types[seq],
      payload: payloads[seq] ?? {},
      redacted: false,
      prev_hash: prev
    };
    const hash = createHash("sha256")
      .update(prev + "\n" + canonicalTraceJson(body))
      .digest("hex");
    events.push({ ...body, hash });
    prev = hash;
  }
  return events;
}

const EXPECTED: Record<JcLocalTraceEventType, readonly string[]> = {
  task_received: ["run.received"],
  task_validated: [],
  risk_classified: ["classification.recorded"],
  route_selected: ["route.recorded"],
  approval_requested: ["approval.requested"],
  approval_decision: ["approval.decided"],
  rollback_checkpoint_created: [],
  agent_started: ["run.started", "executor.started"],
  tool_call_started: ["tool.call.started"],
  tool_call_finished: ["tool.call.finished"],
  file_diff_detected: [],
  verification_started: ["verification.started"],
  verification_finished: ["verification.finished"],
  promotion_blocked: ["promotion.blocked"],
  promotion_completed: ["promotion.completed"],
  run_failed: ["run.failed"],
  run_completed: ["run.completed"],
  run_replay_started: ["run.started"],
  replay_divergence_detected: ["replay.diverged"],
  trace_sealed: []
};

describe("JC -> canonical LoopTrace normalization", () => {
  it("has an explicit mapping decision for every JC private event type", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...JC_LOCAL_TRACE_EVENT_TYPES].sort());
    for (const type of JC_LOCAL_TRACE_EVENT_TYPES) expect(canonicalKindsForJcEvent(type)).toEqual(EXPECTED[type]);
  });

  it("normalizes lifecycle evidence in order and preserves the canonical hash chain", () => {
    const input = localChain(
      [
        "task_received",
        "risk_classified",
        "route_selected",
        "agent_started",
        "tool_call_started",
        "tool_call_finished",
        "verification_started",
        "verification_finished",
        "promotion_completed",
        "run_completed"
      ],
      {
        4: { tool: "read_file", workItemId: "wrk_123" },
        5: { tool: "read_file", ok: true }
      }
    );
    expect(verifyJcLocalTrace(input)).toBe(true);
    const options = {
      traceId: "ab".repeat(16),
      workItemId: "wrk_123",
      instance: "jc-test",
      releaseSha: "unreleased"
    };
    const first = normalizeJcLoopTrace(input, options);
    const second = normalizeJcLoopTrace(input, options);
    expect(second).toEqual(first);
    expect(first.events.map((event) => event.kind)).toEqual([
      "run.received",
      "classification.recorded",
      "route.recorded",
      "run.started",
      "executor.started",
      "tool.call.started",
      "tool.call.finished",
      "verification.started",
      "verification.finished",
      "promotion.completed",
      "run.completed"
    ]);
    expect(first.events.map((event) => event.seq)).toEqual(first.events.map((_, index) => index + 1));
    expect(first.events[0].prev_hash).toBe(GENESIS);
    for (let index = 1; index < first.events.length; index += 1) {
      expect(first.events[index].prev_hash).toBe(canonicalTraceEventHash(first.events[index - 1]));
    }
    expect(first.events.every((event) => event.trace_id === "ab".repeat(16))).toBe(true);
    expect(first.events.every((event) => event.subject?.work_item_id === "wrk_123")).toBe(true);
  });

  it("rejects a broken JC private chain instead of normalizing unverified evidence", () => {
    const input = localChain(["task_received", "run_completed"]);
    input[1] = { ...input[1], prev_hash: "f".repeat(64) };
    expect(verifyJcLocalTrace(input)).toBe(false);
    expect(() => normalizeJcLoopTrace(input)).toThrow(/chain is invalid/);
  });

  it("removes argv and secret-bearing fields before canonical hashing", () => {
    const marker = "supersecretvalue-should-never-survive";
    const input = localChain(["tool_call_started"], {
      0: {
        tool: "privileged_exec",
        argv: ["/usr/bin/tool", "--token=" + marker],
        token: marker,
        note: "Authorization: Bearer " + marker,
        workItemId: "wrk_secret_test"
      }
    });
    const normalized = normalizeJcLoopTrace(input, { instance: "jc-test" });
    const serialized = JSON.stringify(normalized.events);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("argv");
    expect(serialized).not.toContain('"token"');
    expect(normalized.events[0].subject?.work_item_id).toBe("wrk_secret_test");
  });
});
