import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { stableHash } from "@agent-control-stack/shared";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { harnessExecutionResult } from "./harness-result.js";
import { buildGateway } from "./server.js";

function fixture(output = "agent-control-stack", mode: "desktop_commander" | "dry_run" = "desktop_commander") {
  const directory = mkdtempSync(join(tmpdir(), "strands-result-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const item = store.create({
    title: "test result projection",
    requester: "agent",
    intent: "test",
    target: { cwd: "/repo" },
    requestedActions: [
      {
        kind: "fs.read",
        description: "list",
        params: { tool: "list_directory", arguments: { path: "/repo" }, paths: ["/repo"], write: false }
      }
    ]
  });
  store.approveWorkItem(item.id, { via: "domain_service" });
  const claim = createWorkItemTools(store, createPolicyEngine()).claim_next_approved_work_item({
    workerId: "test-worker"
  })!;
  store.submitWorkResult({
    workItemId: item.id,
    leaseId: claim.leaseId,
    workerId: claim.workerId,
    actionHash: claim.actionHash,
    attemptId: claim.attemptId,
    planHash: claim.planHash,
    inputHash: claim.inputHash,
    fencingEpoch: claim.fencingEpoch,
    idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claim.attemptId }),
    outcome: "succeeded",
    startedAt: claim.startedAt,
    finishedAt: new Date().toISOString(),
    summary: "test fixture, no real execution",
    stdout: output,
    structuredOutput: {},
    artifacts: [],
    simulationMetadata:
      mode === "dry_run"
        ? { executionMode: "dry_run", simulated: true }
        : {
            executionMode: "desktop_commander",
            simulated: false,
            backend: "desktop-commander-mcp",
            toolName: "list_directory",
            requestId: "req_test",
            invocationFingerprint: "a".repeat(64)
          }
  });
  // Synthetic authority evidence for projection tests only; no device is invoked.
  for (const [name, body] of [
    ["execution.authorization_granted", { actionHash: claim.actionHash, policyDecisionHash: "policy-hash" }],
    [
      "desktop_commander.capability_issued",
      { attemptId: claim.attemptId, runtimeId: "runtime-test", keyId: "key-test", requestHash: "request-hash" }
    ],
    ["execution.completed", { ok: true }]
  ] as const) {
    store.recordExecutionEvent({
      name,
      workItemId: item.id,
      body,
      attributes: {
        "lease.id": claim.leaseId,
        "worker.id": claim.workerId,
        "action.hash": claim.actionHash,
        "attempt.id": claim.attemptId!
      }
    });
  }
  return {
    store,
    id: item.id,
    dbPath,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
describe("authenticated harness result projection", () => {
  it("requires capability and completion audit evidence", () => {
    const f = fixture();
    try {
      vi.spyOn(f.store, "readEvents").mockReturnValue([]);
      expect(() => harnessExecutionResult(f.store, f.id)).toThrow("audit evidence is required");
    } finally {
      f.close();
    }
  });
  it("returns output and non-secret execution binding", () => {
    const f = fixture();
    try {
      expect(harnessExecutionResult(f.store, f.id)).toMatchObject({
        output: "agent-control-stack",
        workItemId: f.id,
        workerId: "test-worker"
      });
    } finally {
      f.close();
    }
  });
  it("rejects stored output tampering", () => {
    const f = fixture();
    try {
      const original = f.store.getExecutionResult.bind(f.store);
      vi.spyOn(f.store, "getExecutionResult").mockImplementation((id) => {
        const result = original(id);
        return result ? { ...result, stdout: "tampered" } : undefined;
      });
      expect(() => harnessExecutionResult(f.store, f.id)).toThrow("integrity mismatch");
    } finally {
      f.close();
    }
  });
  it("redacts secrets before returning output", () => {
    const f = fixture("Authorization: Bearer sk-abcDEF1234567890abcdefghijklmnop");
    try {
      expect(harnessExecutionResult(f.store, f.id).output).toBe("[redacted]");
    } finally {
      f.close();
    }
  });
  it("never presents dry-run output as real execution", () => {
    const f = fixture("simulated", "dry_run");
    try {
      expect(() => harnessExecutionResult(f.store, f.id)).toThrow("real Desktop Commander result");
    } finally {
      f.close();
    }
  });
  it("protects the HTTP result route with the existing authentication boundary", async () => {
    const f = fixture();
    const app = buildGateway({
      dbPath: f.dbPath,
      logger: false,
      auth: { token: "test-token", actor: "user", actorId: "user" }
    });
    try {
      expect((await app.inject({ method: "GET", url: `/work-items/${f.id}/execution-result` })).statusCode).toBe(401);
      const response = await app.inject({
        method: "GET",
        url: `/work-items/${f.id}/execution-result`,
        headers: { authorization: "Bearer test-token" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().output).toBe("agent-control-stack");
    } finally {
      await app.close();
      f.close();
    }
  });
});
