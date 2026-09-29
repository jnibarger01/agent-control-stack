import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRACE_EVENT_KINDS,
  CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
  CANONICAL_TRACE_GENESIS_HASH,
  canonicalTraceEventHash,
  canonicalTraceJson,
  canonicalTracePayloadHash,
  type CanonicalTraceEvent
} from "./trace-event.js";

const SCHEMA_PIN = "5c0684ddbf26d3e62148d7d37d1523c9f1adcb9c580835d5f11663241ffb8434";

function event(kind = "run.started" as const): CanonicalTraceEvent {
  const payload = { status: "started" };
  return {
    schema_version: CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
    event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    trace_id: "ab".repeat(16),
    span_id: "cd".repeat(8),
    source: { system: "dc", component: "jace-commander", instance: "jc-test", release_sha: "unreleased" },
    class: "evidence",
    kind,
    actor: { id: "jace-commander", type: "system" },
    seq: 1,
    prev_hash: CANONICAL_TRACE_GENESIS_HASH,
    ts: "2026-09-28T12:00:00.000Z",
    payload,
    payload_hash: canonicalTracePayloadHash(payload)
  };
}

describe("canonical trace-event/1 helpers", () => {
  it("matches the exact LoopTrace lifecycle publication", () => {
    const text = readFileSync(new URL("../contracts/trace-event.v1.schema.json", import.meta.url));
    const schema = JSON.parse(text.toString()) as { properties: { kind: { enum: string[] } } };
    expect(createHash("sha256").update(text).digest("hex")).toBe(SCHEMA_PIN);
    expect(schema.properties.kind.enum).toEqual(CANONICAL_TRACE_EVENT_KINDS);
  });

  it("keeps canonical JSON and chain hashing deterministic", () => {
    const first = event();
    const reordered = JSON.parse(JSON.stringify(first)) as CanonicalTraceEvent;
    reordered.payload = { status: "started" };
    expect(canonicalTraceJson(reordered)).toBe(canonicalTraceJson(first));
    expect(canonicalTraceEventHash(reordered)).toBe(canonicalTraceEventHash(first));
    expect(first.payload_hash).toBe(canonicalTracePayloadHash(first.payload));
  });
});
