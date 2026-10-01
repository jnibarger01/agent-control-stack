import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
  CANONICAL_TRACE_GENESIS_HASH,
  canonicalTracePayloadHash,
  type CanonicalTraceEvent,
  type CanonicalTraceEventKind
} from "@agent-control-stack/work-items";
import { classifyJevExecutionProgress, JEV_EXECUTION_PROGRESS_QUESTIONS } from "./execution-progress-shadow.js";
import type { JevCapability } from "./index.js";

const capability: JevCapability = {
  promptVersion: "warden-test",
  supportsNoul: true,
  supportsChoice: false,
  supportsScore: false,
  fingerprint: "noul-only"
};
function trace(kinds: CanonicalTraceEventKind[], payloads: Record<number, Record<string, unknown>> = {}) {
  let previous = CANONICAL_TRACE_GENESIS_HASH;
  return kinds.map((kind, index) => {
    const payload = payloads[index] ?? {};
    const event: CanonicalTraceEvent = {
      schema_version: CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
      event_id: String(index + 1).padStart(26, "0"),
      trace_id: "ab".repeat(16),
      span_id: String(index + 1).padStart(16, "0"),
      source: { system: "acs", component: "test", instance: "test", release_sha: "unreleased" },
      class: "evidence",
      kind,
      actor: { id: "agent", type: "agent" },
      subject: { work_item_id: "wrk_warden" },
      seq: index + 1,
      prev_hash: previous,
      ts: new Date(1_700_000_000_000 + index).toISOString(),
      payload,
      payload_hash: canonicalTracePayloadHash(payload)
    };
    previous = "1".repeat(64);
    return event;
  });
}
function answers(positive: string[]) {
  return Object.fromEntries(
    Object.keys(JEV_EXECUTION_PROGRESS_QUESTIONS).map((key) => [
      key,
      { type: "noul", noul: positive.includes(key) ? 0.99 : 0.01 }
    ])
  );
}
function response(positive: string[]) {
  return async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    expect(Object.keys(body.questions)).toHaveLength(10);
    return new Response(JSON.stringify({ model: "jev-noul", answers: answers(positive) }), { status: 200 });
  };
}
const mission = { objective: "Implement and verify execution-progress shadow" };

describe("JEV execution-progress shadow", () => {
  it("assesses implementation and verification as advancing and on-task", async () => {
    const events = trace(["tool.call.finished", "verification.finished"], {
      0: { tool: "write_file", status: "succeeded" },
      1: { status: "passed" }
    });
    const { assessment } = await classifyJevExecutionProgress(
      { executionId: "wrk_warden", mission, events, triggeringBoundary: "verification.finished" },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["advancing", "on_task", "completion_supported"])
      }
    );
    expect(assessment).toMatchObject({
      progress: "advancing",
      trajectory: "on_task",
      degraded: false,
      completionConfidence: 0.99
    });
    expect(assessment.evidence.map((item) => item.kind)).toEqual(["tool.call.finished", "verification.finished"]);
    expect(assessment.triggeringBoundary).toBe("verification.finished");
  });

  it("represents stalled, looping, recovery, and scope drift as separate advisory judgments", async () => {
    const events = trace(["tool.call.finished", "tool.call.finished", "run.failed", "tool.call.finished"], {
      0: { tool: "test", status: "failed" },
      1: { tool: "test", status: "failed" },
      2: { outcome: "failure" },
      3: { tool: "different_check", status: "succeeded" }
    });
    const stalled = await classifyJevExecutionProgress(
      { executionId: "e1", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["stalled", "looping"])
      }
    );
    expect(stalled.assessment).toMatchObject({ progress: "stalled", trajectory: "looping" });
    const recovery = await classifyJevExecutionProgress(
      { executionId: "e1", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["advancing", "recovery"])
      }
    );
    expect(recovery.assessment).toMatchObject({ progress: "advancing", trajectory: "recovery" });
    const drift = await classifyJevExecutionProgress(
      { executionId: "e1", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["scope_drift"])
      }
    );
    expect(drift.assessment.trajectory).toBe("scope_drift");
  });

  it("treats unsupported, conflicting, timeout, and malformed judgments as unknown/degraded", async () => {
    const events = trace(["run.completed"]);
    const conflict = await classifyJevExecutionProgress(
      { executionId: "e2", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["advancing", "stalled"])
      }
    );
    expect(conflict.assessment.progress).toBe("unknown");
    const unavailable = await classifyJevExecutionProgress(
      { executionId: "e2", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: async () => {
          throw new DOMException("timeout", "AbortError");
        }
      }
    );
    expect(unavailable.assessment).toMatchObject({ degraded: true, progress: "unknown", completionConfidence: null });
    const malformed = await classifyJevExecutionProgress(
      { executionId: "e2", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: async () => new Response('{"answers":{"advancing":{"type":"noul","noul":2}}}', { status: 200 })
      }
    );
    expect(malformed.assessment).toMatchObject({
      degraded: true,
      trajectory: "unknown",
      interventionRecommended: null
    });
  });

  it("reports risk escalation as observational data", async () => {
    const events = trace(["tool.call.finished"], { 0: { tool: "privileged_exec", status: "succeeded" } });
    const result = await classifyJevExecutionProgress(
      { executionId: "e-risk", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["risk_escalation"])
      }
    );
    expect(result.assessment.riskEscalation).toBe(true);
    expect(result.telemetry.risk_escalation).toBe(true);
  });

  it("marks invalid canonical traces degraded", async () => {
    const events = trace(["run.started", "run.failed"]);
    events[1] = { ...events[1]!, seq: 1 };
    const result = await classifyJevExecutionProgress(
      { executionId: "e-malformed", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["advancing"])
      }
    );
    expect(result.assessment).toMatchObject({ degraded: true, progress: "unknown", error: "NO_ADVICE" });
  });

  it("keeps exact repeated failed invocation detection deterministic and separate", async () => {
    const hash = "a".repeat(64);
    const events = trace(["tool.call.finished", "tool.call.finished", "tool.call.finished"], {
      0: { invocation_hash: hash, status: "failed" },
      1: { invocation_hash: hash, status: "failed" },
      2: { invocation_hash: hash, status: "failed" }
    });
    const result = await classifyJevExecutionProgress(
      { executionId: "e4", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response(["stalled"])
      }
    );
    expect(result.assessment.deterministicSignals.repeatedFailedInvocationCount).toBe(1);
    expect(result.assessment.reasons).toContain("Deterministic evidence found repeated failed invocation hashes.");
  });

  it("gives a verbal completion claim weak confidence without verification", async () => {
    const events = trace(["run.completed"], { 0: { status: "done" } });
    const result = await classifyJevExecutionProgress(
      { executionId: "e3", mission, events },
      {
        enabled: true,
        capabilityProfile: capability,
        fetchImpl: response([])
      }
    );
    expect(result.assessment.completionConfidence).toBe(0.01);
    expect(result.assessment.evidence[0]?.fact).toBe("execution reported completion");
    expect(result.telemetry.schema_version).toBe("jev-execution-progress-event/1");
  });
});
