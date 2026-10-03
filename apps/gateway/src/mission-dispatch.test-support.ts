import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  SqliteWorkItemStore,
  executionPlanSubjectInputHash,
  type ChangeSetDefinition
} from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";

export async function missionDispatchFixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "acs-governed-dispatch-"));
  const dbPath = join(root, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const mission = store.create({
    title: "dispatch test",
    requester: "agent",
    requesterSubject: "planner",
    intent: "inspect",
    risk: "low",
    target: { cwd: root },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: ChangeSetDefinition = {
    schemaVersion: "acs.change-set.v1",
    missionId: mission.id,
    subjectInputHash: executionPlanSubjectInputHash(mission),
    executingActorId: "planner",
    objective: "inspect a file",
    scope: [{ kind: "path", id: root }],
    maximumPrivileges: ["fs.read"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    constraints: { maxRuntimeMs: 10_000, maxParallelOperations: 1, failureBehavior: "stop" },
    verification: [],
    operations: [
      {
        operationId: "inspect",
        runtime: "desktop_commander",
        toolName: "read_file",
        action: { kind: "fs.read", description: "inspect", params: { path: root } },
        resources: [{ kind: "path", id: root }],
        requestedPrivileges: ["fs.read"],
        effect: "read_only",
        expectedSideEffects: [],
        dependsOn: [],
        retry: { maxAttempts: 1, idempotencyKey: "inspect" }
      }
    ]
  };
  const record = store.submitChangeSet({
    definition,
    submissionId: "proposal",
    expectedHeadHash: null,
    createdByActorId: "planner"
  });
  const app = buildGateway({
    dbPath,
    logger: false,
    missionDispatchEnabled: enabled,
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    desktopCommanderCapability: {
      runtimeId: "fixture-dc",
      keyId: "fixture-key",
      privateKey: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
      ttlMs: 29_000,
      identityConfigFingerprint: "a".repeat(64),
      runtimeScopes: ["fs.read"]
    },
    auth: {
      token: "",
      actor: "user",
      credentials: [
        {
          id: "operator",
          token: "operator-fixture",
          actor: "user",
          actorId: "operator",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve"]
        },
        {
          id: "planner",
          token: "planner-fixture",
          actor: "agent",
          actorId: "planner",
          roles: ["service"],
          scopes: ["acs:read", "acs:write", "acs:approve"]
        },
        {
          id: "reader",
          token: "reader-fixture",
          actor: "user",
          actorId: "reader",
          roles: ["operator"],
          scopes: ["acs:read"]
        }
      ]
    }
  });
  const post = (url: string, payload: Record<string, unknown>, token = "operator-fixture") =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
  const approved = await post(`/work-items/${mission.id}/change-sets/approve`, {
    expectedManifestHash: record.manifestHash,
    requestId: "approval",
    reason: "Approve the bounded fixture"
  });
  expect(approved.statusCode, approved.body).toBe(201);
  const input = {
    missionId: mission.id,
    expectedManifestHash: record.manifestHash,
    approvalId: approved.json().approvalId as string
  };
  return {
    root,
    dbPath,
    store,
    app,
    input,
    definition,
    post,
    async close() {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
