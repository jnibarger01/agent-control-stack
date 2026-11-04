import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import {
  executionActionHash,
  defaultExecutionPlanForWorkItem,
  SqliteWorkItemStore,
  type WorkItem
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway, deviceClientIdsFromEnv } from "./server.js";

// ARES Studio as an ACS worker: a human requests an ares.* action with their own credential, an
// independent human approves, the "ares" worker claims that exact item, and reports a lease-bound result.
const ALICE = "Bearer alice-requester-token-0123456789abcdef";
const ALICE_OP = "Bearer alice-operator-token-0123456789abcdef";
const BOB = "Bearer bob-operator-token-0123456789abcdef012";
const ARES = "Bearer ares-worker-token-0123456789abcdef0123";
const OTHER = "Bearer other-worker-token-0123456789abcdef012";

const SERVICE = "Bearer service-approver-token-0123456789abcdef";
const EXECUTOR_OP = "Bearer executor-operator-token-0123456789abcdef";

function buildFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-ares-worker-"));
  const app = buildGateway({
    dbPath: join(directory, "control.db"),
    logger: false,
    auth: {
      token: "",
      actor: "user",
      credentials: [
        {
          id: "service-approver",
          token: SERVICE.slice(7),
          actor: "user",
          actorId: "svc",
          roles: ["service"],
          scopes: ["acs:read", "acs:approve"]
        },
        {
          id: "executor-op",
          token: EXECUTOR_OP.slice(7),
          actor: "user",
          actorId: "ares",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve"]
        },
        // Shape of an ACS device-flow credential: actor user, role service, read/write.
        {
          id: "alice",
          token: ALICE.slice(7),
          actor: "user",
          actorId: "alice",
          roles: ["service"],
          scopes: ["acs:read", "acs:write"]
        },
        {
          id: "alice-op",
          token: ALICE_OP.slice(7),
          actor: "user",
          actorId: "alice",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve"]
        },
        {
          id: "bob",
          token: BOB.slice(7),
          actor: "user",
          actorId: "bob",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve"]
        },
        {
          id: "ares",
          token: ARES.slice(7),
          actor: "agent",
          actorId: "ares",
          roles: ["worker"],
          scopes: ["acs:read", "acs:worker"]
        },
        {
          id: "other",
          token: OTHER.slice(7),
          actor: "agent",
          actorId: "other-worker",
          roles: ["worker"],
          scopes: ["acs:read", "acs:worker"]
        }
      ]
    }
  });
  return { directory, app };
}

function aresRequest(kind = "ares.analyze.local") {
  return {
    title: "ARES local analysis",
    intent: "identify an uploaded artifact inside the ARES sandbox",
    target: { services: ["ares"] },
    requestedActions: [
      {
        kind,
        description: "identify artifact",
        params: { artifactId: "a1", aresPrincipal: "local-alice", aresArgsHash: "c".repeat(64), nonce: "n1" }
      }
    ],
    risk: "medium",
    metadata: { correlationId: "ares:n1" }
  };
}

describe("ARES worker integration", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("parses ACS_DEVICE_CLIENT_IDS fail-closed", () => {
    expect(deviceClientIdsFromEnv(undefined)).toBeUndefined();
    expect(deviceClientIdsFromEnv("")).toBeUndefined();
    expect(deviceClientIdsFromEnv("acs-cli,ares-studio")).toEqual(["acs-cli", "ares-studio"]);
    expect(() => deviceClientIdsFromEnv("acs-cli,Bad Id")).toThrow();
  });

  it("requires independent human approval, exact-item claim by the ares worker, and a lease-bound ares result", async () => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: { ...aresRequest(), requesterSubject: "bob", requester: "system" }
      });
      expect(created.statusCode, created.body).toBe(201);
      const item = created.json() as WorkItem;
      expect(item.requester).toBe("user");
      expect(item.requesterSubject).toBe("alice");
      expect(item.status).toBe("needs_approval");
      // Approvals bind the policy action fingerprint; claims and results bind executionActionHash.
      const approvalHash = (actor: string) =>
        createPolicyEngine().evaluateWorkItem(item, actor, "approve")[0]!.actionHash;
      const actionHash = executionActionHash(item);

      // A claim before approval yields nothing.
      const early = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: item.id }
      });
      expect(early.json().claimed ?? false).toBe(false);

      // Self-approval is forbidden even with an operator credential for the same actor.
      const self = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/approve`,
        headers: { authorization: ALICE_OP },
        payload: { reason: "self", actionHash: approvalHash("alice") }
      });
      expect(self.statusCode, self.body).toBe(403);
      expect(JSON.stringify(self.json())).toContain("self-approval");

      for (const [authorization, actor] of [
        [SERVICE, "svc"],
        [EXECUTOR_OP, "ares"]
      ]) {
        const refused = await app.inject({
          method: "POST",
          url: `/work-items/${item.id}/approve`,
          headers: { authorization },
          payload: { reason: "not independent human authority", actionHash: approvalHash(actor!) }
        });
        expect(refused.statusCode, refused.body).toBe(403);
      }

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/approve`,
        headers: { authorization: BOB },
        payload: { reason: "independent review", actionHash: approvalHash("bob") }
      });
      expect(approved.statusCode, approved.body).toBeLessThan(300);

      const racers = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "POST",
            url: "/worker/claim",
            headers: { authorization: ARES },
            payload: { workItemId: item.id }
          })
        )
      );
      expect(racers.filter((response) => response.json().claimed)).toHaveLength(1);
      const claim = racers.find((response) => response.json().claimed)!;
      expect(claim.statusCode, claim.body).toBe(200);
      const claimed = claim.json().workItem;
      expect(claim.json().claimed).toBe(true);
      expect(claimed).toMatchObject({ id: item.id, workerId: "ares", status: "running", actionHash });

      // Approval and lease are single-use: a second claim of the same item gets nothing.
      const again = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: item.id }
      });
      expect(again.json().claimed ?? false).toBe(false);

      const now = new Date().toISOString();
      const result = {
        workItemId: item.id,
        attemptId: claimed.attemptId,
        leaseId: claimed.leaseId,
        workerId: "ares",
        actionHash: claimed.actionHash,
        planHash: claimed.planHash,
        inputHash: claimed.inputHash,
        fencingEpoch: claimed.fencingEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId }),
        outcome: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "identified",
        structuredOutput: { aresArgsHash: "c".repeat(64), resultDigest: "d".repeat(64) },
        artifacts: [],
        simulationMetadata: {
          executionMode: "ares",
          simulated: false,
          backend: "ares-studio",
          toolName: "ares.analyze.local",
          invocationFingerprint: stableHash({
            domain: "ares.invocation.v1",
            attemptId: claimed.attemptId,
            argsHash: "c".repeat(64),
            resultDigest: "d".repeat(64)
          }),
          requestId: claimed.attemptId
        }
      };

      const asDryRun = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: ARES },
        payload: { ...result, simulationMetadata: { executionMode: "dry_run", simulated: true } }
      });
      expect(asDryRun.statusCode, asDryRun.body).toBe(403);
      expect(asDryRun.json().code).toBe("result_mode_mismatch");

      const wrongWorker = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: OTHER },
        payload: result
      });
      expect(wrongWorker.statusCode).toBe(403);

      for (const changed of [
        { structuredOutput: { aresArgsHash: "e".repeat(64), resultDigest: "d".repeat(64) } },
        { simulationMetadata: { ...result.simulationMetadata, invocationFingerprint: "e".repeat(64) } },
        { simulationMetadata: { ...result.simulationMetadata, approvalId: "approval_forged" } },
        { actionHash: "a".repeat(64) },
        { planHash: "a".repeat(64) },
        { inputHash: "a".repeat(64) },
        { fencingEpoch: claimed.fencingEpoch + 1 },
        { leaseId: "lease_wrong" },
        { simulationMetadata: { ...result.simulationMetadata, toolName: "ares.spec.seal" } },
        { simulationMetadata: { ...result.simulationMetadata, requestId: "attempt_wrong" } }
      ]) {
        const refused = await app.inject({
          method: "POST",
          url: `/work-items/${item.id}/results`,
          headers: { authorization: ARES },
          payload: { ...result, ...changed }
        });
        expect(refused.statusCode, JSON.stringify(changed) + refused.body).toBeGreaterThanOrEqual(400);
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(claimed.leaseExpiresAt) + 1);
      const expired = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: ARES },
        payload: result
      });
      expect(expired.statusCode, expired.body).toBe(410);
      vi.useRealTimers();

      const tamperDb = new DatabaseSync(join(directory, "control.db"));
      try {
        tamperDb.prepare("UPDATE work_items SET requester_subject = ? WHERE id = ?").run("acs-mallory", item.id);
        const tampered = await app.inject({
          method: "POST",
          url: `/work-items/${item.id}/results`,
          headers: { authorization: ARES },
          payload: result
        });
        expect(tampered.statusCode, tampered.body).toBeGreaterThanOrEqual(400);
      } finally {
        tamperDb.prepare("UPDATE work_items SET requester_subject = ? WHERE id = ?").run("alice", item.id);
        tamperDb.close();
      }

      const accepted = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: ARES },
        payload: result
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(accepted.json().workItem.status).toBe("succeeded");

      // Idempotent replay of the same result is not a second execution record.
      const replay = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: ARES },
        payload: result
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().result.resultId).toBe(accepted.json().result.resultId);
      const recorded = await app.inject({
        method: "GET",
        url: `/work-items/${item.id}`,
        headers: { authorization: ALICE }
      });
      const events = recorded.json().events as { name: string }[];
      expect(events.filter((event) => event.name === "execution_result.accepted")).toHaveLength(1);
      expect(events.filter((event) => event.name === "approval.consumed")).toHaveLength(1);

      // A different outcome under the consumed lease is refused.
      const forged = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/results`,
        headers: { authorization: ARES },
        payload: { ...result, outcome: "failed", summary: "rewritten" }
      });
      expect(forged.statusCode, forged.body).toBeGreaterThanOrEqual(400);

      // A finished item cannot be claimed again.
      const reclaim = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: item.id }
      });
      expect(reclaim.json().claimed ?? false).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("limits exact-item claims to ARES kinds and the ares mode to ARES items", async () => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: {
          title: "plain read",
          intent: "read a file",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
          risk: "low"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as WorkItem).id;
      const byId = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: id }
      });
      expect(byId.statusCode).toBe(403);
      expect(byId.json().code).toBe("worker_claim_kind_forbidden");

      const missing = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: "wi_missing" }
      });
      expect(missing.statusCode).toBe(404);

      const extra = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: id, workerId: "x" }
      });
      expect(extra.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("an approved ARES item can be leased only by the worker it names, by id or by claim-next", async () => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: { ...aresRequest(), target: { services: ["ares"] } }
      });
      expect(created.statusCode, created.body).toBe(201);
      const item = created.json() as WorkItem;
      const approvalHash = createPolicyEngine().evaluateWorkItem(item, "bob", "approve")[0]!.actionHash;
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/approve`,
        headers: { authorization: BOB },
        payload: { reason: "independent review", actionHash: approvalHash }
      });
      expect(approved.statusCode, approved.body).toBeLessThan(300);

      const otherById = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: OTHER },
        payload: { workItemId: item.id }
      });
      expect(otherById.statusCode, otherById.body).toBe(403);
      expect(otherById.json().code).toBe("worker_target_mismatch");
      const otherNext = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: OTHER },
        payload: {}
      });
      expect(otherNext.statusCode, otherNext.body).toBe(200);
      expect(otherNext.json().claimed).toBe(false);

      // The item is still approved and unconsumed; the named worker gets it.
      const mine = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: item.id }
      });
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json()).toMatchObject({ claimed: true, workItem: { id: item.id, workerId: "ares" } });
    } finally {
      await app.close();
    }
  });

  it.each(["arguments", "principal", "worker"])("refuses a claim when %s change after approval", async (field) => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: aresRequest()
      });
      const item = created.json() as WorkItem;
      const actionHash = createPolicyEngine().evaluateWorkItem(item, "bob", "approve")[0]!.actionHash;
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${item.id}/approve`,
        headers: { authorization: BOB },
        payload: { reason: "independent review", actionHash }
      });
      expect(approved.statusCode).toBe(200);
      // Simulate persisted input tampering in this test's database only, without disabling any guard.
      const db = new DatabaseSync(join(directory, "control.db"));
      try {
        if (field === "principal") {
          db.prepare("UPDATE work_items SET requester_subject = ? WHERE id = ?").run("acs-mallory", item.id);
        } else if (field === "worker") {
          db.prepare("UPDATE work_items SET target_json = ? WHERE id = ?").run(
            JSON.stringify({ services: ["other-worker"] }),
            item.id
          );
        } else {
          const changed = structuredClone(item.requestedActions);
          changed[0]!.params.artifactId = "different-artifact";
          db.prepare("UPDATE work_items SET requested_actions_json = ? WHERE id = ?").run(
            JSON.stringify(changed),
            item.id
          );
        }
      } finally {
        db.close();
      }
      const claimed = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: ARES },
        payload: { workItemId: item.id }
      });
      expect(claimed.json().claimed ?? false, claimed.body).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("refuses a legacy dry-run plan until a new ARES plan receives fresh approval", async () => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const response = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: aresRequest()
      });
      const item = response.json() as WorkItem;
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      try {
        const definition = defaultExecutionPlanForWorkItem(item);
        const legacy = store.createExecutionPlan({
          workItemId: item.id,
          definition: { ...definition, constraints: { ...definition.constraints, executionMode: "dry_run" } },
          createdByActorId: "synthetic-legacy"
        });
        const actionHash = createPolicyEngine().evaluateWorkItem(item, "bob", "approve")[0]!.actionHash;
        const approve = () =>
          app.inject({
            method: "POST",
            url: `/work-items/${item.id}/approve`,
            headers: { authorization: BOB },
            payload: { reason: "independent review", actionHash }
          });
        expect((await approve()).statusCode).toBeGreaterThanOrEqual(400);
        store.createExecutionPlan({
          workItemId: item.id,
          definition,
          createdByActorId: "synthetic-reviewer",
          expectedCurrentPlanHash: legacy.planHash
        });
        expect((await approve()).statusCode).toBe(200);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
    }
  });

  it("rejects unknown ares-prefixed kinds", async () => {
    const { directory, app } = buildFixture();
    directories.push(directory);
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: ALICE },
        payload: aresRequest("ares.shell.exec")
      });
      if (created.statusCode === 201) expect((created.json() as WorkItem).status).toBe("blocked");
      else expect(created.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await app.close();
    }
  });
});
