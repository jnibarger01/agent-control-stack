import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoaAuditEvent } from "@agent-control-stack/moa-orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import { HashChainedJsonlAuditSink } from "./audit-sink.js";
import type { InferenceAuditEvent } from "./openai-compatible.js";
import { HashChainedInferenceAuditSink } from "./openai-compatible.js";

const dirs: string[] = [];

function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-audit-sink-"));
  dirs.push(dir);
  return join(dir, name);
}

function moaEvent(type: MoaAuditEvent["type"], taskId: string): MoaAuditEvent {
  return {
    ts: "2026-09-29T00:00:00.000Z",
    type,
    task_id: taskId,
    session_id: "ses_1",
    origin: "test",
    preset: "cheap",
    actor: "tester",
    data: {}
  };
}

function inferenceEvent(requestId: string): InferenceAuditEvent {
  return {
    type: "request_allowed",
    requestId,
    actor: "tester",
    method: "POST",
    path: "/v1/responses",
    decision: "allow"
  };
}

function chainRecords(path: string): Array<{ sequence: number; previousHash: string; eventHash: string }> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sequence: number; previousHash: string; eventHash: string });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("HashChainedJsonlAuditSink rehydration", () => {
  it("continues the chain across instances with a log larger than one tail window", () => {
    const path = scratch("moa-audit.jsonl");
    new HashChainedJsonlAuditSink(path).record(moaEvent("moa_run_started", "wrk_1"));
    new HashChainedJsonlAuditSink(path).record(moaEvent("moa_run_completed", "wrk_1"));

    // Push the log well past the bounded tail window with chain-shaped records,
    // then rehydrate a fresh sink as a restarted gateway would: it must pick up
    // the true head of a >window file, not just the first window.
    const filler = Array.from({ length: 4000 }, (_unused, index) =>
      JSON.stringify({ sequence: 100 + index, eventHash: `h${index}` })
    );
    writeFileSync(path, `${readFileSync(path, "utf8")}${filler.join("\n")}\n`);

    const revived = new HashChainedJsonlAuditSink(path);
    revived.record(moaEvent("moa_acs_action", "wrk_1"));

    const records = chainRecords(path);
    expect(records.length).toBe(4003);
    expect(records.at(-1)?.sequence).toBe(4100);
    expect(records.at(-1)?.previousHash).toBe("h3999");
  });

  it("throws when the last record is not a chained audit entry", () => {
    const path = scratch("moa-audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ not: "a chain" })}\n`);
    expect(() => new HashChainedJsonlAuditSink(path)).toThrow(`MoA audit log is malformed at ${path}`);
  });

  it("starts a fresh chain for an absent log", () => {
    const path = join(scratch("absent-dir"), "missing.jsonl");
    const sink = new HashChainedJsonlAuditSink(path);
    sink.record(moaEvent("moa_run_started", "wrk_1"));
    expect(chainRecords(path)[0]?.sequence).toBe(1);
  });
});

describe("HashChainedInferenceAuditSink rehydration", () => {
  it("continues the chain across instances", () => {
    const path = scratch("inference-audit.jsonl");
    new HashChainedInferenceAuditSink(path).record(inferenceEvent("req_1"));
    const revived = new HashChainedInferenceAuditSink(path);
    revived.record(inferenceEvent("req_2"));

    const records = chainRecords(path);
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records[1]?.previousHash).toBe(records[0]?.eventHash);
  });

  it("throws when the last record is not a chained audit entry", () => {
    const path = scratch("inference-audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ sequence: 2, eventHash: 5 })}\n`);
    expect(() => new HashChainedInferenceAuditSink(path)).toThrow(`inference audit log is malformed at ${path}`);
  });
});
