import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./store.js";
import { submitWorkResultSchema } from "./work-item.js";

const validResultEnvelope = {
  workItemId: "wrk_result",
  leaseId: "legacy_lease",
  workerId: "legacy_worker",
  actionHash: "a".repeat(64),
  idempotencyKey: "result_key",
  outcome: "succeeded" as const,
  startedAt: "2026-07-23T20:00:00.000Z",
  finishedAt: "2026-07-23T20:00:01.000Z",
  exitCode: 0,
  summary: "schema-only result validation",
  stdout: "dry-run output",
  stderr: "",
  structuredOutput: { result: "ok", values: [1, true, null] },
  artifacts: [
    {
      name: "report.json",
      kind: "report",
      mediaType: "application/json",
      sizeBytes: 12,
      sha256: "b".repeat(64)
    }
  ],
  resourceUsage: { durationMs: 1, cpuMs: 1, memoryBytes: 1 },
  simulationMetadata: {
    executionMode: "dry_run" as const,
    simulated: true as const,
    workerVersion: "worker.v1",
    reason: "schema coverage"
  }
};

describe("schema v6 legacy result boundary", () => {
  it("retains strict result-envelope validation without permitting persistence", () => {
    expect(submitWorkResultSchema.parse(validResultEnvelope)).toMatchObject({
      outcome: "succeeded",
      exitCode: 0
    });
    expect(
      submitWorkResultSchema.parse({
        ...validResultEnvelope,
        outcome: "failed",
        exitCode: 1,
        error: "simulated failure"
      })
    ).toMatchObject({ outcome: "failed", error: "simulated failure" });
    expect(
      submitWorkResultSchema.parse({
        ...validResultEnvelope,
        outcome: "cancelled",
        exitCode: undefined
      })
    ).toMatchObject({ outcome: "cancelled" });
  });

  it("rejects impossible timing, outcome, and oversized output combinations", () => {
    for (const invalid of [
      { ...validResultEnvelope, unknownField: true },
      { ...validResultEnvelope, finishedAt: "2026-07-23T19:59:59.000Z" },
      { ...validResultEnvelope, exitCode: 1 },
      { ...validResultEnvelope, error: "success cannot include an error" },
      { ...validResultEnvelope, outcome: "cancelled", exitCode: 1 },
      { ...validResultEnvelope, outcome: "cancelled", exitCode: undefined, error: "cancelled error" },
      { ...validResultEnvelope, stdout: "é".repeat(40_000) },
      { ...validResultEnvelope, error: "é".repeat(3_000) }
    ]) {
      expect(submitWorkResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects unsafe artifact and structured-output shapes", () => {
    const circular: Record<string, unknown> = {};
    circular.loop = circular;
    const tooManyEntries = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index]));
    const oversizedSerialized = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`key${index}`, "x".repeat(7_000)])
    );
    const deeplyNested = { one: { two: { three: { four: { five: { six: { seven: true } } } } } } };

    for (const invalid of [
      { ...validResultEnvelope, artifacts: [{ name: "../report.json" }] },
      { ...validResultEnvelope, artifacts: [{ name: "bad\\report.json" }] },
      { ...validResultEnvelope, artifacts: [{ name: "bad\u0001name" }] },
      { ...validResultEnvelope, artifacts: [{ name: "report", mediaType: "text/\u0001plain" }] },
      { ...validResultEnvelope, artifacts: [{ name: "report", sizeBytes: 17 * 1024 * 1024 }] },
      { ...validResultEnvelope, structuredOutput: { authorization: "redacted" } },
      { ...validResultEnvelope, structuredOutput: { value: "x".repeat(16_001) } },
      { ...validResultEnvelope, structuredOutput: { values: Array.from({ length: 65 }, () => 1) } },
      { ...validResultEnvelope, structuredOutput: tooManyEntries },
      { ...validResultEnvelope, structuredOutput: oversizedSerialized },
      { ...validResultEnvelope, structuredOutput: deeplyNested },
      { ...validResultEnvelope, structuredOutput: circular }
    ]) {
      expect(submitWorkResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects every legacy result mutation before it can alter state or audit history", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-legacy-result-boundary-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const item = store.create({
        title: "Legacy result rejection",
        requester: "agent",
        intent: "prove old result APIs are disabled after schema v6",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "simulate" }],
        risk: "low"
      });
      store.approveWorkItem(item.id, { via: "domain_service" });
      const eventsBefore = store.readEvents();

      for (const operation of [() => store.submitWorkResult({}), () => store.recordDerivedWorkResult({})]) {
        expect(operation).toThrowError(
          expect.objectContaining<Partial<ControlStackError>>({ code: "worker_protocol_unsupported" })
        );
      }

      expect(store.get(item.id)?.status).toBe("approved");
      expect(store.readEvents()).toEqual(eventsBefore);
      expect(store.getExecutionResult("res_missing")).toBeUndefined();
      expect(store.getExecutionResultForIdempotency("legacy-worker", "missing")).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
