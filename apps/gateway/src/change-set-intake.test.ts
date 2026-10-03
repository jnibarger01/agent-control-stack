import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { stableHash } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanSubjectInputHash,
  submitWorkResultSchema,
  issueAutonomousAuthorityBodySchema,
  changeSetOperationPermitSchema,
  type ChangeSetOperationPermit,
  type ChangeSetDefinition
} from "@agent-control-stack/work-items";
import { SqliteWorkItemStore } from "../../../packages/work-items/src/store.js";
import { buildGateway } from "./server.js";
import { evaluateChangeSetPolicy } from "@agent-control-stack/policy-gate";
import { resolveChangeSetRuntimePolicy } from "./change-set-runtime-policy.js";
import { verifyChangeSetResult } from "./change-set-verification.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-change-set-intake-"));
  const dbPath = join(root, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const mission = store.create({
    title: "Bundle intake",
    intent: "inspect two files",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const scope = [root, join(root, "a"), join(root, "b")].map((id) => ({ kind: "path" as const, id }));
  const definition: ChangeSetDefinition = {
    schemaVersion: "acs.change-set.v1",
    missionId: mission.id,
    subjectInputHash: executionPlanSubjectInputHash(mission),
    executingActorId: "planner",
    objective: "inspect two files",
    scope,
    maximumPrivileges: ["fs.read"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    constraints: { maxRuntimeMs: 10_000, maxParallelOperations: 1, failureBehavior: "stop" },
    operations: ["a", "b"].map((operationId) => ({
      operationId,
      runtime: "desktop_commander",
      toolName: "read_file",
      action: { kind: "fs.read", description: "inspect", params: { path: join(root, operationId) } },
      resources: scope,
      requestedPrivileges: ["fs.read"],
      effect: "read_only",
      expectedSideEffects: [],
      dependsOn: operationId === "b" ? ["a"] : [],
      retry: { maxAttempts: 1, idempotencyKey: operationId }
    })),
    verification: []
  };
  store.close();
  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const app = buildGateway({
    dbPath,
    logger: false,
    desktopCommanderCapability: {
      runtimeId: "bundle-dc",
      keyId: "bundle-key",
      privateKey,
      ttlMs: 29_000,
      identityConfigFingerprint: "a".repeat(64),
      runtimeScopes: ["fs.read", "fs.write"]
    },
    jaceCommanderCapability: { runtimeId: "bundle-jc", keyId: "bundle-jc-key", privateKey, ttlMs: 29_000 },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    jaceCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    auth: {
      token: "",
      actor: "user",
      credentials: [
        {
          id: "dc-bridge",
          token: "dc-bridge-token",
          actor: "agent",
          actorId: "acs-dc-bridge",
          roles: ["service", "worker"],
          scopes: ["acs:read", "acs:write", "acs:worker"]
        },
        {
          id: "jc-bridge",
          token: "jc-bridge-token",
          actor: "agent",
          actorId: "acs-jc-bridge",
          roles: ["service", "worker"],
          scopes: ["acs:read", "acs:write", "acs:worker"]
        },
        {
          id: "reviewer",
          token: "reviewer-token",
          actor: "user",
          actorId: "reviewer",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve", "acs:review"]
        },
        {
          id: "self",
          token: "self-token",
          actor: "user",
          actorId: "planner",
          roles: ["operator"],
          scopes: ["acs:read", "acs:approve", "acs:review"]
        },
        {
          id: "service-reviewer",
          token: "service-reviewer-token",
          actor: "agent",
          actorId: "service-reviewer",
          roles: ["service"],
          scopes: ["acs:read", "acs:approve", "acs:review"]
        },
        {
          id: "mixed-reviewer",
          token: "mixed-reviewer-token",
          actor: "user",
          actorId: "mixed-reviewer",
          roles: ["operator", "service"],
          scopes: ["acs:read", "acs:approve", "acs:review"]
        },
        {
          id: "planner",
          token: "planner-token",
          actor: "agent",
          actorId: "planner",
          roles: ["service"],
          scopes: ["acs:read", "acs:write"]
        },
        {
          id: "reader",
          token: "reader-token",
          actor: "user",
          actorId: "reader",
          roles: ["operator"],
          scopes: ["acs:read"]
        }
      ]
    }
  });
  const url = `/work-items/${mission.id}/change-sets`;
  const headers = { authorization: "Bearer planner-token" };
  const payload = { definition, submissionId: "submission-one", expectedHeadHash: null };
  return { root, dbPath, mission, app, url, headers, payload };
}

describe("authenticated Change Set intake", () => {
  it("excludes aggregate parents from worker selection and direct claims", async () => {
    const ctx = fixture();
    const store = new SqliteWorkItemStore(ctx.dbPath);
    try {
      store.submitChangeSet({ ...ctx.payload, createdByActorId: "planner" });
      store.approveWorkItem(ctx.mission.id, { via: "policy_gate", actorId: "planner" });
      expect(store.findNextApprovedWorkItemForWorker("worker")).toBeUndefined();
      expect(store.claimNextApprovedWorkItem("worker", { allowLegacyClaimForTests: true })).toBeUndefined();
      expect(() =>
        store.claimApprovedWorkItemById(ctx.mission.id, executionActionHash(ctx.mission), "worker", {
          allowLegacyClaimForTests: true
        })
      ).toThrow(/aggregate mission/u);
      expect(() => store.startWorkItem(ctx.mission.id, "worker", { allowDirectStartForTests: true })).toThrow(
        /aggregate mission/u
      );
      expect(store.get(ctx.mission.id)?.status).toBe("approved");
      expect(store.getChangeSetProgress(ctx.mission.id).operations.every((op) => op.status === "not_permitted")).toBe(
        true
      );
    } finally {
      store.close();
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rejects converting directly claimed work into an aggregate mission", async () => {
    const ctx = fixture();
    const store = new SqliteWorkItemStore(ctx.dbPath);
    try {
      store.approveWorkItem(ctx.mission.id, { via: "policy_gate", actorId: "planner" });
      store.startWorkItem(ctx.mission.id, "worker", { allowDirectStartForTests: true });
      expect(() => store.submitChangeSet({ ...ctx.payload, createdByActorId: "planner" })).toThrow(
        /direct execution state/u
      );
      expect(store.getChangeSet(ctx.mission.id)).toBeUndefined();
      expect(store.get(ctx.mission.id)?.status).toBe("running");
      expect(store.readEvents({ name: "change_set.submitted" })).toHaveLength(0);
    } finally {
      store.close();
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each<{ toolName: string; args: ChangeSetDefinition["operations"][number]["action"]["params"] }>([
    { toolName: "start_process", args: { command: "git status", timeout_ms: 1000 } },
    { toolName: "run_command", args: { argv: ["git", "status"], timeoutMs: 1000 } }
  ])(
    "derives named command policy facts for $toolName without revalidating a resolved executable",
    async ({ toolName, args }) => {
      const ctx = fixture();
      try {
        const operation = structuredClone(ctx.payload.definition.operations[0]!);
        operation.toolName = toolName;
        operation.action.params = { ...args, cwd: ctx.root };
        const facts = resolveChangeSetRuntimePolicy({
          operation,
          mission: ctx.mission,
          actorId: "planner",
          dcContainment: { allowedRoots: [ctx.root], deniedRoots: [] }
        });
        expect(facts.context.action.kind).toBe("cmd.run");
        expect(facts.context.command).toEqual(["git", "status"]);
        expect(facts.privileges).toEqual(["process.spawn"]);
        expect(facts.effect).toBe("mutation");
        expect(facts.resources).toContainEqual({ kind: "path", id: ctx.root });
        expect(facts.invocationHash).toMatch(/^[a-f0-9]{64}$/u);
        operation.action.params =
          toolName === "start_process"
            ? { command: "/usr/bin/git status", cwd: ctx.root, timeout_ms: 1000 }
            : { argv: ["/usr/bin/git", "status"], cwd: ctx.root, timeoutMs: 1000 };
        expect(() =>
          resolveChangeSetRuntimePolicy({
            operation,
            mission: ctx.mission,
            actorId: "planner",
            dcContainment: { allowedRoots: [ctx.root], deniedRoots: [] }
          })
        ).toThrow("executable paths are forbidden");
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

  it("treats privileged JC execution as a distinct privilege and contains its default cwd", async () => {
    const ctx = fixture();
    try {
      const definition = structuredClone(ctx.payload.definition);
      const op = definition.operations[0]!;
      op.runtime = "jace_commander";
      op.toolName = "privileged_exec";
      op.action = {
        kind: "fs.read",
        description: "misleading label",
        params: { argv: ["/usr/bin/true"], cwd: ctx.root }
      };
      const submitted = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, definition }
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload: { expectedManifestHash: submitted.json().manifestHash }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision.decision).toBe("deny");
      op.action.params = { argv: ["/usr/bin/true"] };
      const amended = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { definition, submissionId: "implicit-root-cwd", expectedHeadHash: submitted.json().manifestHash }
      });
      expect(amended.statusCode).toBe(201);
      const outside = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload: { expectedManifestHash: amended.json().manifestHash }
      });
      expect(outside.statusCode, outside.body).toBe(409);
      expect(outside.json().code).toMatch(/path/u);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rejects expired, tampered and changed-input snapshots before runtime resolution", async () => {
    const ctx = fixture();
    try {
      const submitted = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: ctx.payload
      });
      const record = submitted.json();
      const input = {
        record,
        mission: ctx.mission,
        actorId: "planner",
        expectedManifestHash: record.manifestHash,
        resolveOperation: (operation: ChangeSetDefinition["operations"][number]) =>
          resolveChangeSetRuntimePolicy({
            operation,
            mission: ctx.mission,
            actorId: "planner",
            dcContainment: { allowedRoots: [ctx.root], deniedRoots: [] }
          })
      };
      expect(() =>
        evaluateChangeSetPolicy({ ...input, now: new Date(Date.parse(record.snapshot.definition.expiresAt) + 1) })
      ).toThrow("expired");
      expect(() => evaluateChangeSetPolicy({ ...input, record: { ...record, manifestHash: "0".repeat(64) } })).toThrow(
        "hash mismatch"
      );
      expect(() =>
        evaluateChangeSetPolicy({ ...input, mission: { ...ctx.mission, intent: "changed mission inputs" } })
      ).toThrow("mission inputs changed");
      expect(() => evaluateChangeSetPolicy({ ...input, actorId: "spoofed" })).toThrow(
        "canonical policy binding mismatch"
      );
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rejects understated path scope and caller-supplied policy decisions", async () => {
    const ctx = fixture();
    try {
      const definition = structuredClone(ctx.payload.definition);
      definition.operations[0]!.resources = [{ kind: "path", id: ctx.root }];
      const submitted = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, definition }
      });
      const payload = { expectedManifestHash: submitted.json().manifestHash };
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision.decision).toBe("deny");
      expect(
        (
          await ctx.app.inject({
            method: "POST",
            url: `${ctx.url}/policy`,
            headers: ctx.headers,
            payload: { ...payload, decision: "allow" }
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("evaluates a persisted multi-operation snapshot through deterministic runtime policy and records its binding", async () => {
    const ctx = fixture();
    try {
      const submitted = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: ctx.payload
      });
      const manifestHash = submitted.json().manifestHash;
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload: { expectedManifestHash: manifestHash }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ manifestHash, actorId: "planner", decision: { decision: "allow" } });
      expect(response.json().operations).toHaveLength(2);
      expect(response.json().operations[0].factsHash).toMatch(/^[a-f0-9]{64}$/u);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.readEvents().find((event) => event.id === response.json().auditEventId)?.name).toBe(
          "change_set.policy_evaluated"
        );
        expect(store.get(ctx.mission.id)?.status).toBe(ctx.mission.status);
      } finally {
        store.close();
      }
      const amended = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: {
          ...ctx.payload,
          submissionId: "amend",
          expectedHeadHash: manifestHash,
          definition: { ...ctx.payload.definition, objective: "new plan" }
        }
      });
      expect(amended.statusCode).toBe(201);
      const stale = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload: { expectedManifestHash: manifestHash }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("change_set_revision_conflict");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each(["desktop_commander", "jace_commander"] as const)(
    "rejects a %s write disguised as read-only",
    async (runtime) => {
      const ctx = fixture();
      try {
        const definition = structuredClone(ctx.payload.definition);
        const op = definition.operations[0]!;
        op.runtime = runtime;
        op.toolName = "write_file";
        op.action = {
          kind: "fs.read",
          description: "false read",
          params: { path: join(ctx.root, "a"), content: "changed" }
        };
        const submitted = await ctx.app.inject({
          method: "POST",
          url: ctx.url,
          headers: ctx.headers,
          payload: { ...ctx.payload, definition }
        });
        expect(submitted.statusCode, submitted.body).toBe(201);
        const response = await ctx.app.inject({
          method: "POST",
          url: `${ctx.url}/policy`,
          headers: ctx.headers,
          payload: { expectedManifestHash: submitted.json().manifestHash }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().decision).toMatchObject({
          decision: "deny",
          matchedRules: ["deny:change-set-declaration-mismatch"]
        });
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

  it("requires approval for an accurately declared mutation with predeclared verification", async () => {
    const ctx = fixture();
    try {
      const definition = structuredClone(ctx.payload.definition);
      definition.maximumPrivileges.push("fs.write");
      const op = definition.operations[0]!;
      op.toolName = "write_file";
      op.effect = "mutation";
      op.requestedPrivileges = ["fs.write"];
      op.action = {
        kind: "fs.read",
        description: "caller kind is ignored",
        params: { path: join(ctx.root, "a"), content: "changed" }
      };
      definition.verification = [
        {
          requirementId: "verify-a",
          operationIds: ["a"],
          kind: "fs_inspect",
          expectation: { content: "changed" },
          independent: false
        }
      ];
      const submitted = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, definition }
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/policy`,
        headers: ctx.headers,
        payload: { expectedManifestHash: submitted.json().manifestHash }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision.decision).toBe("require_approval");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
  it("persists a multi-operation snapshot with authenticated provenance, replay and exact-head amendments", async () => {
    const ctx = fixture();
    try {
      const first = await ctx.app.inject({ method: "POST", url: ctx.url, headers: ctx.headers, payload: ctx.payload });
      expect(first.statusCode, first.body).toBe(201);
      const record = first.json();
      expect(record.createdByActorId).toBe("planner");
      expect(record.snapshot.definition.operations).toHaveLength(2);
      const replay = await ctx.app.inject({ method: "POST", url: ctx.url, headers: ctx.headers, payload: ctx.payload });
      expect(replay.json()).toEqual(record);
      const amendment = {
        ...ctx.payload,
        submissionId: "submission-two",
        expectedHeadHash: record.manifestHash,
        definition: { ...ctx.payload.definition, objective: "revised inspection" }
      };
      const second = await ctx.app.inject({ method: "POST", url: ctx.url, headers: ctx.headers, payload: amendment });
      expect(second.statusCode).toBe(201);
      expect(second.json().snapshot.revision).toBe(2);
      const stale = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...amendment, submissionId: "submission-three" }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("change_set_revision_conflict");
      const history = await ctx.app.inject({ method: "GET", url: `${ctx.url}?revision=1`, headers: ctx.headers });
      expect(history.json()).toEqual(record);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.get(ctx.mission.id)?.status).toBe(ctx.mission.status);
        expect(store.readEvents().filter((event) => event.name === "change_set.submitted")).toHaveLength(2);
        expect(store.verifyAuditChain().ok).toBe(true);
        const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
        try {
          for (const table of [
            "approval_records",
            "execution_plan_approvals",
            "execution_attempts",
            "attempt_leases",
            "admission_permits"
          ]) {
            expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
          }
        } finally {
          db.close();
        }
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each(["createdByActorId", "now", "approved"])("rejects caller-supplied %s", async (field) => {
    const ctx = fixture();
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, [field]: "forged" }
      });
      expect(response.statusCode).toBe(400);
      expect((await ctx.app.inject({ method: "GET", url: ctx.url, headers: ctx.headers })).statusCode).toBe(404);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated reads, read-only writes and cross-mission submissions", async () => {
    const ctx = fixture();
    try {
      expect((await ctx.app.inject({ method: "GET", url: ctx.url })).statusCode).toBe(401);
      expect(
        (
          await ctx.app.inject({
            method: "POST",
            url: ctx.url,
            headers: { authorization: "Bearer reader-token" },
            payload: ctx.payload
          })
        ).statusCode
      ).toBe(403);
      const mismatch = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, definition: { ...ctx.payload.definition, missionId: "another-mission" } }
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().code).toBe("change_set_input_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

const reviewerHeaders = { authorization: "Bearer reviewer-token" };
async function proposeForApproval(
  ctx: ReturnType<typeof fixture>,
  mutation = false,
  configure?: (definition: ChangeSetDefinition) => void
) {
  if (mutation) {
    ctx.payload.definition.maximumPrivileges = ["fs.read", "fs.write"];
    for (const op of ctx.payload.definition.operations) {
      op.toolName = "write_file";
      op.action = {
        kind: "fs.write",
        description: "write",
        params: { path: join(ctx.root, op.operationId), content: "expected" }
      };
      op.requestedPrivileges = ["fs.write"];
      op.effect = "mutation";
      op.expectedSideEffects = ["write approved file"];
    }
    ctx.payload.definition.verification = [
      {
        requirementId: "read-back",
        kind: "fs_inspect",
        operationIds: ["a", "b"],
        expectation: { content: "expected" },
        independent: false
      }
    ];
  }
  configure?.(ctx.payload.definition);
  const submitted = await ctx.app.inject({ method: "POST", url: ctx.url, headers: ctx.headers, payload: ctx.payload });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return {
    expectedManifestHash: submitted.json().manifestHash as string,
    requestId: "review-one",
    reason: "Approve exact two-operation snapshot"
  };
}

describe("human Change Set approvals", () => {
  it("rejects forged authority, out-of-scope expiry and denied declarations without recording approval", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx);
      for (const extra of [
        { approvedByActorId: "reviewer" },
        { policyHash: "a".repeat(64) },
        { executingActorId: "another" }
      ]) {
        const response = await ctx.app.inject({
          method: "POST",
          url: `${ctx.url}/approve`,
          headers: reviewerHeaders,
          payload: { ...payload, ...extra }
        });
        expect(response.statusCode, response.body).toBe(400);
      }
      const expiresAt = new Date(Date.parse(ctx.payload.definition.expiresAt) + 1).toISOString();
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload: { ...payload, expiresAt }
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("change_set_approval_expired");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.readEvents().filter((event) => event.name === "change_set.policy_evaluated")).toHaveLength(0);
      } finally {
        store.close();
      }
      const op = ctx.payload.definition.operations[0]!;
      op.toolName = "write_file";
      op.action.params = { path: join(ctx.root, "a"), content: "undeclared mutation" };
      const amended = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...ctx.payload, submissionId: "denied-plan", expectedHeadHash: payload.expectedManifestHash }
      });
      expect(amended.statusCode, amended.body).toBe(201);
      const denied = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload: { ...payload, expectedManifestHash: amended.json().manifestHash }
      });
      expect(denied.statusCode, denied.body).toBe(409);
      expect(denied.json().code).toBe("change_set_approval_denied");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rolls back policy and approval audit if persistence fails, then rejects persisted approval tampering", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec(
          "CREATE TRIGGER reject_test_approval BEFORE INSERT ON change_set_approvals BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
        );
      } finally {
        db.close();
      }
      const failed = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      const reopened = new DatabaseSync(ctx.dbPath);
      try {
        expect(reopened.prepare("SELECT count(*) AS n FROM change_set_approvals").get()).toEqual({ n: 0 });
        expect(
          reopened
            .prepare(
              "SELECT count(*) AS n FROM audit_events WHERE name IN ('change_set.approved', 'change_set.policy_evaluated')"
            )
            .get()
        ).toEqual({ n: 0 });
        reopened.exec("DROP TRIGGER reject_test_approval");
      } finally {
        reopened.close();
      }
      const approved = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(approved.statusCode, approved.body).toBe(201);
      const corrupted = new DatabaseSync(ctx.dbPath);
      try {
        expect(() =>
          corrupted
            .prepare(
              "UPDATE change_set_approvals SET record_json = json_set(record_json, '$.executingActorId', 'attacker')"
            )
            .run()
        ).toThrow(/immutable/u);
        corrupted.exec("DROP TRIGGER change_set_approvals_no_update");
        corrupted
          .prepare(
            "UPDATE change_set_approvals SET record_json = json_set(record_json, '$.executingActorId', 'attacker')"
          )
          .run();
      } finally {
        corrupted.close();
      }
      const response = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${ctx.mission.id}/change-set-approvals/${approved.json().approvalId}`,
        headers: reviewerHeaders
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("change_set_approval_integrity_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("approves two mutating operations once, replays exactly, and verifies persisted authority after reopening", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx, true);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(response.statusCode, response.body).toBe(201);
      const approval = response.json();
      expect(approval).toMatchObject({
        missionId: ctx.mission.id,
        manifestHash: payload.expectedManifestHash,
        approvedByActorId: "reviewer",
        executingActorId: "planner",
        revision: 1
      });
      const replay = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(approval);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.requireActiveChangeSetApproval(approval.approvalId, approval.manifestHash, "planner")).toEqual(
          approval
        );
        expect(() =>
          store.requireActiveChangeSetApproval(approval.approvalId, approval.manifestHash, "other-worker")
        ).toThrow(/binding mismatch/u);
        expect(() =>
          store.requireActiveChangeSetApproval(
            approval.approvalId,
            approval.manifestHash,
            "planner",
            new Date(approval.expiresAt)
          )
        ).toThrow(/expired/u);
        expect(store.readEvents().filter((event) => event.name === "change_set.approved")).toHaveLength(1);
        expect(store.readEvents().filter((event) => event.name === "change_set.policy_evaluated")).toHaveLength(1);
        expect(store.get(ctx.mission.id)?.status).toBe(ctx.mission.status);
        const db = new DatabaseSync(ctx.dbPath);
        try {
          expect(db.prepare("SELECT count(*) AS n FROM attempt_leases").get()).toEqual({ n: 0 });
        } finally {
          db.close();
        }
      } finally {
        store.close();
      }
      const conflict = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload: { ...payload, reason: "different approval" }
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(conflict.json().code).toBe("change_set_approval_conflict");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each(["planner", "reader", "service-reviewer", "mixed-reviewer"])(
    "rejects non-human or unprivileged approval by %s",
    async (credential) => {
      const ctx = fixture();
      try {
        const payload = await proposeForApproval(ctx, true);
        const response = await ctx.app.inject({
          method: "POST",
          url: `${ctx.url}/approve`,
          headers: { authorization: `Bearer ${credential}-token` },
          payload
        });
        expect(response.statusCode, response.body).toBe(403);
        const store = new SqliteWorkItemStore(ctx.dbPath);
        try {
          expect(store.getChangeSetApprovalByRequest(ctx.mission.id, payload.requestId)).toBeUndefined();
        } finally {
          store.close();
        }
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

  it("rejects restricted self-approval and rolls back the policy audit", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx, true);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: { authorization: "Bearer self-token" },
        payload
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("change_set_self_approval");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.readEvents().filter((event) => event.name === "change_set.policy_evaluated")).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("invalidates approval after amendment and cannot approve a stale hash", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx);
      const approved = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(approved.statusCode, approved.body).toBe(201);
      const amendment = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: {
          ...ctx.payload,
          submissionId: "amendment",
          expectedHeadHash: payload.expectedManifestHash,
          definition: { ...ctx.payload.definition, objective: "materially changed plan" }
        }
      });
      expect(amendment.statusCode, amendment.body).toBe(201);
      const read = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${ctx.mission.id}/change-set-approvals/${approved.json().approvalId}`,
        headers: reviewerHeaders
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ active: false, code: "change_set_approval_superseded" });
      const replay = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(replay.statusCode, replay.body).toBe(409);
      expect(replay.json().code).toBe("change_set_revision_conflict");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("revokes durably and fails closed when the revocation projection is removed", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx);
      const approved = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(approved.statusCode, approved.body).toBe(201);
      const url = `/work-items/${ctx.mission.id}/change-set-approvals/${approved.json().approvalId}`;
      for (let i = 0; i < 2; i++) {
        const revoked = await ctx.app.inject({
          method: "POST",
          url: `${url}/revoke`,
          headers: reviewerHeaders,
          payload: { reason: "Operator cancellation" }
        });
        expect(revoked.statusCode, revoked.body).toBe(200);
      }
      const read = await ctx.app.inject({ method: "GET", url, headers: reviewerHeaders });
      expect(read.json()).toMatchObject({ active: false, code: "change_set_approval_revoked" });
      const db = new DatabaseSync(ctx.dbPath);
      try {
        expect(
          db.prepare("SELECT count(*) AS n FROM audit_events WHERE name = 'change_set.approval_revoked'").get()
        ).toEqual({ n: 1 });
        expect(() => db.prepare("DELETE FROM change_set_approval_revocations").run()).toThrow(/immutable/u);
        db.exec("DROP TRIGGER change_set_approval_revocations_no_delete");
        db.prepare("DELETE FROM change_set_approval_revocations").run();
      } finally {
        db.close();
      }
      const tampered = await ctx.app.inject({ method: "GET", url, headers: reviewerHeaders });
      expect(tampered.statusCode, tampered.body).toBe(409);
      expect(tampered.json().code).toBe("change_set_approval_integrity_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

async function approveAndPermit(
  ctx: ReturnType<typeof fixture>,
  operationId = "a",
  configure?: (definition: ChangeSetDefinition) => void
) {
  const payload = await proposeForApproval(ctx, true, configure);
  const approved = await ctx.app.inject({
    method: "POST",
    url: `${ctx.url}/approve`,
    headers: reviewerHeaders,
    payload
  });
  expect(approved.statusCode, approved.body).toBe(201);
  const permitBody = { expectedManifestHash: payload.expectedManifestHash, approvalId: approved.json().approvalId };
  const permitUrl = `${ctx.url}/operations/${operationId}/permit`;
  const response = await ctx.app.inject({ method: "POST", url: permitUrl, headers: ctx.headers, payload: permitBody });
  expect(response.statusCode, response.body).toBe(201);
  return { permit: response.json(), permitBody, permitUrl };
}

function grantBody(ctx: ReturnType<typeof fixture>) {
  return {
    requestId: "human-delegation",
    expectedSubjectInputHash: executionPlanSubjectInputHash(ctx.mission),
    reason: "Delegate bounded file mission",
    definition: {
      executingActorId: "planner",
      scope: [{ kind: "path", id: ctx.root, coverage: "descendants" }],
      toolClasses: [{ runtime: "desktop_commander", toolName: "write_file" }],
      maximumPrivileges: ["fs.read", "fs.write"],
      expiresAt: new Date(Date.parse(ctx.payload.definition.expiresAt) + 60_000).toISOString(),
      limits: { maxOperations: 2, maxRuntimeMs: 10_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
    }
  };
}

async function issueGrant(ctx: ReturnType<typeof fixture>, payload = grantBody(ctx)) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/work-items/${ctx.mission.id}/authority-grants`,
    headers: reviewerHeaders,
    payload
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

describe("human-issued Autonomous Authority Grants", () => {
  it("refuses an unscoped read-only tool even when its name appears in the human grant", async () => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      body.definition.toolClasses[0]!.toolName = "get_config";
      const grant = await issueGrant(ctx, body);
      const proposal = await proposeForApproval(ctx, true, (definition) => {
        for (const operation of definition.operations) {
          operation.toolName = "get_config";
          operation.action.params = {};
          operation.requestedPrivileges = ["fs.read"];
          operation.effect = "read_only";
          operation.expectedSideEffects = [];
        }
      });
      const authorized = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(authorized.statusCode, authorized.body).toBe(409);
      expect(authorized.json().code).toBe("grant_authorization_policy_mismatch");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.list()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("refuses an otherwise authorized command before creating an unconfined execution", async () => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      body.definition.toolClasses[0]!.toolName = "start_process";
      body.definition.maximumPrivileges.push("process.spawn");
      const grant = await issueGrant(ctx, body);
      const proposal = await proposeForApproval(ctx, true, (definition) => {
        definition.maximumPrivileges.push("process.spawn");
        for (const operation of definition.operations) {
          operation.toolName = "start_process";
          operation.action = {
            kind: "cmd.run",
            description: "request a bounded command",
            params: { command: "git status", cwd: ctx.root, timeout_ms: 1000 }
          };
          operation.requestedPrivileges = ["process.spawn"];
          operation.expectedSideEffects = ["create a process"];
        }
      });
      const authorized = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(authorized.statusCode, authorized.body).toBe(201);
      const permit = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/operations/a/permit`,
        headers: ctx.headers,
        payload: {
          authorizationId: authorized.json().authorizationId,
          expectedManifestHash: proposal.expectedManifestHash
        }
      });
      expect(permit.statusCode, permit.body).toBe(409);
      expect(permit.json().code).toBe("autonomous_authority_runtime_unconfined");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.list()).toHaveLength(1);
        expect(
          store.getChangeSetOperationPermitForOperation(ctx.mission.id, proposal.expectedManifestHash, "a")
        ).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("enforces cumulative grant budgets across revisions and revokes unclaimed execution", async () => {
    const ctx = fixture();
    try {
      const grant = await issueGrant(ctx);
      let proposal = await proposeForApproval(ctx, true);
      const post = (url: string, payload: Record<string, unknown>) =>
        ctx.app.inject({ method: "POST", url, headers: ctx.headers, payload });
      const permits: ChangeSetOperationPermit[] = [];
      for (let revision = 1; revision <= 3; revision++) {
        if (revision > 1) {
          const amended = await post(ctx.url, {
            ...ctx.payload,
            submissionId: `budget-revision-${revision}`,
            expectedHeadHash: proposal.expectedManifestHash,
            definition: { ...ctx.payload.definition, objective: `revision ${revision}` }
          });
          expect(amended.statusCode, amended.body).toBe(201);
          proposal = { ...proposal, expectedManifestHash: amended.json().manifestHash };
        }
        const authorized = await post(`${ctx.url}/authorize`, {
          grantId: grant.grantId,
          expectedManifestHash: proposal.expectedManifestHash
        });
        expect(authorized.statusCode, authorized.body).toBe(201);
        const issued = await post(`${ctx.url}/operations/a/permit`, {
          authorizationId: authorized.json().authorizationId,
          expectedManifestHash: proposal.expectedManifestHash
        });
        if (revision === 3) {
          expect(issued.statusCode, issued.body).toBe(409);
          expect(issued.json().code).toBe("autonomous_authority_budget_exhausted");
        } else {
          expect(issued.statusCode, issued.body).toBe(201);
          permits.push(changeSetOperationPermitSchema.parse(issued.json()));
          expect(issued.json().schemaVersion).toBe("acs.change-set.operation-permit.v2");
          expect(issued.json().approvalId).toBeUndefined();
          const replay = await post(`${ctx.url}/operations/a/permit`, {
            authorizationId: authorized.json().authorizationId,
            expectedManifestHash: proposal.expectedManifestHash
          });
          expect(replay.json()).toEqual(issued.json());
        }
      }
      expect(Date.parse(permits[1].expiresAt)).toBeLessThanOrEqual(
        Date.parse(permits[0].createdAt) + grant.definition.limits.maxRuntimeMs
      );
      const revoked = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${ctx.mission.id}/authority-grants/${grant.grantId}/revoke`,
        headers: reviewerHeaders,
        payload: { reason: "stop before claim" }
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.list()).toHaveLength(3);
        expect(store.readEvents({ name: "change_set.operation_permitted" })).toHaveLength(2);
        expect(() =>
          store.requireActiveChangeSetOperationPermit(permits[1].executionWorkItemId, "acs-dc-bridge")
        ).toThrow(/revoked/u);
        expect(store.listAdmissionPermits()).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("refuses unsupported verification before creating a grant execution", async () => {
    const ctx = fixture();
    try {
      const grant = await issueGrant(ctx);
      const proposal = await proposeForApproval(ctx, true, (definition) => {
        definition.verification[0]!.kind = "http_probe";
      });
      const authorized = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(authorized.statusCode, authorized.body).toBe(201);
      const permit = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/operations/a/permit`,
        headers: ctx.headers,
        payload: {
          authorizationId: authorized.json().authorizationId,
          expectedManifestHash: proposal.expectedManifestHash
        }
      });
      expect(permit.statusCode, permit.body).toBe(409);
      expect(permit.json().code).toBe("verification_adapter_unavailable");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.list()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("delegates once before planning, binds two operations and replays without a second human approval", async () => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      const grant = await issueGrant(ctx, body);
      expect(await issueGrant(ctx, body)).toEqual(grant);
      const proposal = await proposeForApproval(ctx, true);
      const payload = { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash };
      const authorized = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload
      });
      expect(authorized.statusCode, authorized.body).toBe(201);
      expect(authorized.json()).toMatchObject({
        grantId: grant.grantId,
        grantHash: grant.grantHash,
        executingActorId: "planner"
      });
      const replay = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(authorized.json());
      const read = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${ctx.mission.id}/authority-grants/${grant.grantId}`,
        headers: ctx.headers
      });
      expect(read.json().active).toBe(true);
      const authorizationRead = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${ctx.mission.id}/change-set-authorizations/${authorized.json().authorizationId}`,
        headers: ctx.headers
      });
      expect(authorizationRead.json().active).toBe(true);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(
          store.requireActiveGrantAuthorization(
            authorized.json().authorizationId,
            payload.expectedManifestHash,
            "planner"
          )
        ).toEqual(authorized.json());
        expect(store.getAutonomousAuthority(grant.grantId)).toEqual(grant);
        expect(
          store.issueAutonomousAuthority(
            {
              ...issueAutonomousAuthorityBodySchema.parse(body),
              missionId: ctx.mission.id,
              issuedByActorId: "reviewer"
            },
            { via: "policy_gate", actorId: "reviewer" }
          )
        ).toEqual(grant);
        expect(store.getGrantAuthorizationForGrant(grant.grantId, payload.expectedManifestHash)).toEqual(
          authorized.json()
        );
        expect(
          store.authorizeChangeSetWithGrant(
            {
              grantId: grant.grantId,
              missionId: ctx.mission.id,
              expectedManifestHash: payload.expectedManifestHash,
              executingActorId: "planner",
              policyHash: authorized.json().policyHash,
              policyAuditEventId: authorized.json().policyAuditEventId
            },
            { via: "policy_gate", actorId: "planner" }
          )
        ).toEqual(authorized.json());
        expect(store.readEvents({ name: "autonomous_authority.issued" })).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.grant_authorized" })).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.policy_evaluated" })).toHaveLength(1);
        expect(store.readEvents({ name: "change_set.approved" })).toHaveLength(0);
        expect(store.list()).toHaveLength(1);
        expect(store.verifyAuditChain().ok).toBe(true);
      } finally {
        store.close();
      }
      const db = new DatabaseSync(ctx.dbPath);
      try {
        expect(db.prepare("SELECT count(*) AS n FROM execution_attempts").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM change_set_operation_permits").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each(["planner-token", "dc-bridge-token", "service-reviewer-token", "mixed-reviewer-token", "reader-token"])(
    "rejects grant issuance and revocation using %s",
    async (token) => {
      const ctx = fixture();
      try {
        const payload = grantBody(ctx);
        const response = await ctx.app.inject({
          method: "POST",
          url: `/work-items/${ctx.mission.id}/authority-grants`,
          headers: { authorization: `Bearer ${token}` },
          payload
        });
        expect(response.statusCode, response.body).toBe(403);
        const grant = await issueGrant(ctx, payload);
        const revoke = await ctx.app.inject({
          method: "POST",
          url: `/work-items/${ctx.mission.id}/authority-grants/${grant.grantId}/revoke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { reason: "agent cannot revoke or replace human authority" }
        });
        expect(revoke.statusCode, revoke.body).toBe(403);
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "resource",
    "tool",
    "privilege",
    "runtime budget",
    "parallel budget",
    "attempt budget",
    "operation budget",
    "expiration"
  ])("cannot authorize a Change Set exceeding grant %s", async (dimension) => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      const grant = await issueGrant(ctx, body);
      const proposal = await proposeForApproval(ctx, true, (definition) => {
        if (dimension === "resource") {
          const path = join(ctx.root, "..", `${ctx.root.split("/").at(-1)}-sibling`);
          definition.scope.push({ kind: "path", id: path });
        }
        if (dimension === "tool") {
          definition.operations[0]!.toolName = "read_file";
          definition.operations[0]!.action.params = { path: join(ctx.root, "a") };
          definition.operations[0]!.requestedPrivileges = ["fs.read", "fs.write"];
        }
        if (dimension === "privilege") definition.maximumPrivileges.push("secret.read");
        if (dimension === "runtime budget") definition.constraints.maxRuntimeMs++;
        if (dimension === "parallel budget") definition.constraints.maxParallelOperations++;
        if (dimension === "attempt budget") definition.operations[0]!.retry.maxAttempts++;
        if (dimension === "operation budget") {
          const extra = {
            ...definition.operations[0]!,
            operationId: "c",
            retry: { maxAttempts: 1, idempotencyKey: "c" }
          };
          definition.operations.push(extra);
          definition.verification[0]!.operationIds.push("c");
        }
        if (dimension === "expiration")
          definition.expiresAt = new Date(Date.parse(body.definition.expiresAt) + 1).toISOString();
      });
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("autonomous_authority_scope_mismatch");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.readEvents({ name: "change_set.grant_authorized" })).toHaveLength(0);
        expect(store.readEvents({ name: "change_set.policy_evaluated" })).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("fences amendments and revocation, including a missing revocation projection", async () => {
    const ctx = fixture();
    try {
      const grant = await issueGrant(ctx);
      const proposal = await proposeForApproval(ctx, true);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(response.statusCode, response.body).toBe(201);
      const amended = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: {
          ...ctx.payload,
          submissionId: "revision-two",
          expectedHeadHash: proposal.expectedManifestHash,
          definition: { ...ctx.payload.definition, objective: "bounded revision two" }
        }
      });
      expect(amended.statusCode, amended.body).toBe(201);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() =>
          store.requireActiveGrantAuthorization(
            response.json().authorizationId,
            proposal.expectedManifestHash,
            "planner"
          )
        ).toThrow(/superseded/u);
        expect(() => store.requireActiveAutonomousAuthority(grant.grantId, ctx.mission.id, "other")).toThrow(
          /identity/u
        );
        expect(() => store.requireActiveAutonomousAuthority(grant.grantId, "other-mission", "planner")).toThrow(
          /identity/u
        );
        expect(() =>
          store.requireActiveAutonomousAuthority(
            grant.grantId,
            ctx.mission.id,
            "planner",
            new Date(grant.definition.expiresAt)
          )
        ).toThrow(/expired/u);
      } finally {
        store.close();
      }
      const payload = { grantId: grant.grantId, expectedManifestHash: amended.json().manifestHash };
      expect(
        (await ctx.app.inject({ method: "POST", url: `${ctx.url}/authorize`, headers: ctx.headers, payload }))
          .statusCode
      ).toBe(201);
      const revokeUrl = `/work-items/${ctx.mission.id}/authority-grants/${grant.grantId}/revoke`;
      for (let i = 0; i < 2; i++)
        expect(
          (
            await ctx.app.inject({
              method: "POST",
              url: revokeUrl,
              headers: reviewerHeaders,
              payload: { reason: "human cancellation" }
            })
          ).statusCode
        ).toBe(200);
      const blocked = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload
      });
      expect(blocked.json().code).toBe("autonomous_authority_revoked");
      const db = new DatabaseSync(ctx.dbPath);
      try {
        expect(() => db.prepare("DELETE FROM autonomous_authority_revocations").run()).toThrow(/immutable/u);
        db.exec("DROP TRIGGER autonomous_authority_revocations_no_delete");
        db.prepare("DELETE FROM autonomous_authority_revocations").run();
      } finally {
        db.close();
      }
      const invalid = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload
      });
      expect(invalid.statusCode, invalid.body).toBe(409);
      expect(invalid.json().code).toBe("autonomous_authority_integrity_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rejects self grant, identity injection, changed request and altered mission inputs", async () => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      const self = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${ctx.mission.id}/authority-grants`,
        headers: reviewerHeaders,
        payload: { ...body, definition: { ...body.definition, executingActorId: "reviewer" } }
      });
      expect(self.json().code).toBe("autonomous_authority_self_grant");
      for (const extra of [
        { issuedByActorId: "reviewer" },
        { grantHash: "a".repeat(64) },
        { now: new Date().toISOString() }
      ]) {
        const forged = await ctx.app.inject({
          method: "POST",
          url: `/work-items/${ctx.mission.id}/authority-grants`,
          headers: reviewerHeaders,
          payload: { ...body, ...extra }
        });
        expect(forged.statusCode, forged.body).toBe(400);
      }
      const grant = await issueGrant(ctx, body);
      const changed = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${ctx.mission.id}/authority-grants`,
        headers: reviewerHeaders,
        payload: {
          ...body,
          definition: { ...body.definition, maximumPrivileges: [...body.definition.maximumPrivileges, "secret.read"] }
        }
      });
      expect(changed.json().code).toBe("autonomous_authority_conflict");
      const proposal = await proposeForApproval(ctx, true);
      const spoofed = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: { authorization: "Bearer dc-bridge-token" },
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(spoofed.json().code).toBe("autonomous_authority_binding_mismatch");
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("UPDATE work_items SET intent = 'changed' WHERE id = ?").run(ctx.mission.id);
      } finally {
        db.close();
      }
      const stale = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(stale.json().code).toBe("change_set_input_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rolls back issuance on storage failure and detects modified grant and authorization records", async () => {
    const ctx = fixture();
    try {
      const body = grantBody(ctx);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec(
          "CREATE TRIGGER reject_grant BEFORE INSERT ON autonomous_authority_grants BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
        );
      } finally {
        db.close();
      }
      const failed = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${ctx.mission.id}/authority-grants`,
        headers: reviewerHeaders,
        payload: body
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      const source = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(source.readEvents({ name: "autonomous_authority.issued" })).toHaveLength(0);
      } finally {
        source.close();
      }
      const restore = new DatabaseSync(ctx.dbPath);
      try {
        restore.exec("DROP TRIGGER reject_grant");
      } finally {
        restore.close();
      }
      const grant = await issueGrant(ctx, body);
      const proposal = await proposeForApproval(ctx, true);
      const authorized = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/authorize`,
        headers: ctx.headers,
        payload: { grantId: grant.grantId, expectedManifestHash: proposal.expectedManifestHash }
      });
      expect(authorized.statusCode, authorized.body).toBe(201);
      const corrupt = new DatabaseSync(ctx.dbPath);
      try {
        expect(() =>
          corrupt
            .prepare(
              "UPDATE change_set_grant_authorizations SET record_json = json_set(record_json,'$.executingActorId','attacker')"
            )
            .run()
        ).toThrow(/immutable/u);
        corrupt.exec("DROP TRIGGER change_set_grant_authorizations_no_update");
        corrupt
          .prepare(
            "UPDATE change_set_grant_authorizations SET record_json = json_set(record_json,'$.executingActorId','attacker')"
          )
          .run();
      } finally {
        corrupt.close();
      }
      const reader = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() => reader.getGrantAuthorization(authorized.json().authorizationId)).toThrow(/integrity/u);
        expect(() =>
          reader.issueAutonomousAuthority(
            {
              ...issueAutonomousAuthorityBodySchema.parse(body),
              missionId: ctx.mission.id,
              issuedByActorId: "reviewer"
            },
            { via: "domain_service", actorId: "reviewer" }
          )
        ).toThrow(/provenance/u);
        expect(() =>
          reader.authorizeChangeSetWithGrant(
            {
              grantId: grant.grantId,
              missionId: ctx.mission.id,
              expectedManifestHash: proposal.expectedManifestHash,
              executingActorId: "planner",
              policyHash: authorized.json().policyHash,
              policyAuditEventId: authorized.json().policyAuditEventId
            },
            { via: "policy_gate", actorId: "other" }
          )
        ).toThrow(/actor mismatch/u);
        reader.revokeAutonomousAuthority(grant.grantId, "reviewer", "source revocation", {
          via: "policy_gate",
          actorId: "reviewer"
        });
        expect(() => reader.requireActiveAutonomousAuthority(grant.grantId, ctx.mission.id, "planner")).toThrow(
          /revoked/u
        );
      } finally {
        reader.close();
      }
      const grantDb = new DatabaseSync(ctx.dbPath);
      try {
        expect(() =>
          grantDb
            .prepare(
              "UPDATE autonomous_authority_grants SET record_json = json_set(record_json,'$.issuedByActorId','attacker')"
            )
            .run()
        ).toThrow(/immutable/u);
        grantDb.exec("DROP TRIGGER autonomous_authority_grants_no_update");
        grantDb
          .prepare(
            "UPDATE autonomous_authority_grants SET record_json = json_set(record_json,'$.issuedByActorId','attacker')"
          )
          .run();
      } finally {
        grantDb.close();
      }
      const invalid = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${ctx.mission.id}/authority-grants/${grant.grantId}`,
        headers: ctx.headers
      });
      expect(invalid.statusCode, invalid.body).toBe(409);
      expect(invalid.json().code).toBe("autonomous_authority_integrity_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("Change Set result verification", () => {
  it.each(["unsupported adapter", "invalid expectation", "unbound resource", "too many checks"])(
    "rejects human-approved %s before creating execution state",
    async (scenario) => {
      const ctx = fixture();
      try {
        const proposal = await proposeForApproval(ctx, true, (definition) => {
          const check = definition.verification[0]!;
          if (scenario === "unsupported adapter") check.kind = "http_probe";
          if (scenario === "invalid expectation") check.expectation = { passed: true };
          if (scenario === "unbound resource") check.expectation.path = join(ctx.root, "unapproved");
          if (scenario === "too many checks")
            for (let index = 0; index < 32; index++)
              definition.verification.push({ ...check, requirementId: `additional-${index}` });
        });
        const approval = await ctx.app.inject({
          method: "POST",
          url: `${ctx.url}/approve`,
          headers: reviewerHeaders,
          payload: proposal
        });
        expect(approval.statusCode, approval.body).toBe(201);
        const response = await ctx.app.inject({
          method: "POST",
          url: `${ctx.url}/operations/a/permit`,
          headers: ctx.headers,
          payload: { expectedManifestHash: proposal.expectedManifestHash, approvalId: approval.json().approvalId }
        });
        expect(response.statusCode, response.body).toBe(scenario === "invalid expectation" ? 400 : 409);
        const store = new SqliteWorkItemStore(ctx.dbPath);
        try {
          expect(store.list()).toHaveLength(1);
          expect(
            store.getChangeSetOperationPermitForOperation(ctx.mission.id, proposal.expectedManifestHash, "a")
          ).toBeUndefined();
          expect(store.readEvents({ name: "change_set.operation_permitted" })).toHaveLength(0);
        } finally {
          store.close();
        }
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "absent file",
    "wrong content",
    "simulated execution",
    "wrong invocation",
    "missing requirement",
    "independent review",
    "missing evidence",
    "executor self-approval",
    "stale evidence",
    "reviewer replay",
    "forged evidence",
    "evidence before result",
    "lease loss before result",
    "lease expiry after evidence",
    "completion before verification",
    "review rejection",
    "two reviewers",
    "concurrent reviewer replay",
    "forged decision",
    "forged review",
    "tampered result",
    "valid readback",
    "mission completion",
    "persisted result tampering"
  ])("enforces approved verification for %s", async (scenario) => {
    const ctx = fixture();
    try {
      const { permit } = await approveAndPermit(ctx, "a", (definition) => {
        if (["mission completion", "persisted result tampering", "completion before verification"].includes(scenario)) {
          definition.operations = [definition.operations[0]!];
          definition.verification[0]!.operationIds = ["a"];
        }
        if (scenario === "two reviewers")
          for (let reviewer = 0; reviewer < 2; reviewer++)
            definition.verification.push({
              requirementId: `review-${reviewer}`,
              kind: "independent_review",
              operationIds: ["a"],
              expectation: { verdict: "accept" },
              independent: true
            });
        if (scenario === "independent review")
          definition.verification.push({
            requirementId: "review",
            kind: "independent_review",
            operationIds: ["a"],
            expectation: { verdict: "accept" },
            independent: true
          });
      });
      const headers = { authorization: "Bearer dc-bridge-token", "x-dc-actor": "planner" };
      const bootstrap = {
        runtimeId: "bundle-dc",
        identityConfigFingerprint: "a".repeat(64),
        scopes: ["fs.read", "fs.write"]
      };
      const challenge = await ctx.app.inject({
        method: "POST",
        url: "/dc/runtime/bootstrap",
        headers,
        payload: bootstrap
      });
      expect(challenge.statusCode, challenge.body).toBe(201);
      const active = await ctx.app.inject({
        method: "POST",
        url: "/dc/runtime/bootstrap/complete",
        headers,
        payload: {
          ...bootstrap,
          challenge: challenge.json().challenge,
          runtimeIdentity: {
            schemaVersion: 1,
            runtimeId: bootstrap.runtimeId,
            challenge: challenge.json().challenge,
            scopes: bootstrap.scopes
          }
        }
      });
      expect(active.statusCode, active.body).toBe(204);
      const issued = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { authorization: "Bearer dc-bridge-token", "x-dc-actor": "planner" },
        payload: {
          client_id: "fixture-client",
          tool: "write_file",
          argsSummary: JSON.stringify(ctx.payload.definition.operations[0]!.action.params),
          changeSetPermitId: permit.permitId
        }
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const body = issued.json();
      if (scenario !== "absent file")
        writeFileSync(join(ctx.root, "a"), scenario === "wrong content" ? "wrong" : "expected");
      if (scenario === "missing requirement") {
        const db = new DatabaseSync(ctx.dbPath);
        try {
          expect(() =>
            db.prepare("DELETE FROM verification_requirements WHERE attempt_id = ?").run(body.attemptId)
          ).toThrow(/append-only/u);
          db.exec("DROP TRIGGER verification_requirements_no_delete");
          db.prepare("DELETE FROM verification_requirements WHERE attempt_id = ?").run(body.attemptId);
        } finally {
          db.close();
        }
      }
      const now = new Date().toISOString();
      const payload = {
        workItemId: body.workItemId,
        attemptId: body.attemptId,
        leaseId: body.leaseId,
        workerId: body.workerId,
        actionHash: body.claimActionHash,
        planHash: body.planHash,
        inputHash: body.inputHash,
        fencingEpoch: body.leaseEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: body.attemptId }),
        outcome: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "executor claims success",
        structuredOutput: { done: true },
        artifacts: [],
        simulationMetadata:
          scenario === "simulated execution"
            ? { executionMode: "dry_run", simulated: true }
            : {
                executionMode: "desktop_commander",
                simulated: false,
                backend: "desktop-commander-mcp",
                toolName: "write_file",
                invocationFingerprint: scenario === "wrong invocation" ? "a".repeat(64) : body.invocationHash,
                requestId: body.attemptId
              }
      };
      if (
        [
          "tampered result",
          "valid readback",
          "mission completion",
          "persisted result tampering",
          "independent review",
          "missing evidence",
          "executor self-approval",
          "stale evidence",
          "reviewer replay",
          "forged evidence",
          "evidence before result",
          "lease loss before result",
          "lease expiry after evidence",
          "completion before verification",
          "review rejection",
          "two reviewers",
          "concurrent reviewer replay",
          "forged decision",
          "forged review"
        ].includes(scenario)
      ) {
        const store = new SqliteWorkItemStore(ctx.dbPath);
        try {
          const input = submitWorkResultSchema.parse(payload);
          if (scenario === "valid readback") {
            for (let index = 0; index < 110; index++)
              store.recordSystemEvent({ name: "test.unrelated_traffic", attributes: { "test.index": index } });
            expect(store.readEvents().some((event) => event.name === "desktop_commander.capability_issued")).toBe(
              false
            );
          }
          if (scenario === "evidence before result") {
            expect(() => verifyChangeSetResult(store, input, { allowedRoots: [ctx.root], deniedRoots: [] })).toThrow(
              "durably accepted"
            );
            expect(store.getEvidenceManifestForAttempt(body.attemptId)).toBeUndefined();
            return;
          }
          if (scenario === "lease loss before result") {
            const lease = store.getActiveLeaseForAttempt(body.attemptId)!;
            store.failExpiredLeases(new Date(Date.parse(lease.expiresAt) + 1));
            expect(() => store.submitWorkResult(input)).toThrow();
            expect(() => verifyChangeSetResult(store, input, { allowedRoots: [ctx.root], deniedRoots: [] })).toThrow();
            expect(store.getEvidenceManifestForAttempt(body.attemptId)).toBeUndefined();
            expect(store.getChangeSetProgress(ctx.mission.id).operations[0]!.status).toBe("needs_reconciliation");
            return;
          }
          const accepted = store.submitWorkResult(input);
          expect(accepted.status).toBe("succeeded");
          expect(store.submitWorkResult(input).result).toEqual(accepted.result);
          expect(store.getChangeSetProgress(ctx.mission.id).operations[0]!.status).toBe("awaiting_verification");
          expect(store.getVerificationDecision(body.attemptId)).toBeUndefined();
          if (scenario === "tampered result")
            expect(() => store.submitWorkResult({ ...input, summary: "changed after acceptance" })).toThrow(
              /conflict/u
            );
          if (scenario !== "missing evidence")
            verifyChangeSetResult(store, input, { allowedRoots: [ctx.root], deniedRoots: [] });
          const evidence = store.getEvidenceManifestForAttempt(body.attemptId);
          const reviewPayload = {
            attemptId: body.attemptId,
            evidenceManifestHash: evidence?.manifestHash ?? "0".repeat(64),
            verdict: "PASS",
            reason: "independent reviewer inspected canonical evidence"
          };
          const review = (payload = reviewPayload, token = "service-reviewer-token") =>
            ctx.app.inject({
              method: "POST",
              url: `/work-items/${body.workItemId}/change-set-review`,
              headers: { authorization: `Bearer ${token}` },
              payload
            });
          const complete = () =>
            store.completeChangeSetMission(
              {
                missionId: ctx.mission.id,
                expectedManifestHash: permit.manifestHash,
                executingActorId: "planner",
                approvalId: permit.approvalId
              },
              { via: "policy_gate", actorId: "planner" }
            );
          expect(() => complete()).toThrow("every operation");
          if (scenario === "missing evidence") {
            const denied = await review();
            expect(denied.statusCode, denied.body).toBe(409);
            expect(store.getVerificationDecision(body.attemptId)).toBeUndefined();
            return;
          }
          if (scenario === "executor self-approval") {
            expect((await review(reviewPayload, "self-token")).statusCode).toBe(409);
            expect((await review(reviewPayload, "dc-bridge-token")).statusCode).toBe(403);
            expect((await review(reviewPayload, "reader-token")).statusCode).toBe(403);
            expect((await review(reviewPayload, "planner-token")).statusCode).toBe(403);
            expect((await review(reviewPayload, "invalid-token")).statusCode).toBe(401);
            const forged = await ctx.app.inject({
              method: "POST",
              url: `/work-items/${body.workItemId}/change-set-review`,
              headers: { authorization: "Bearer service-reviewer-token" },
              payload: { ...reviewPayload, reviewerPrincipalId: "other" }
            });
            expect(forged.statusCode).toBe(400);
            expect(store.listReviewFindings(body.attemptId)).toHaveLength(0);
          }
          if (scenario === "stale evidence") {
            expect((await review()).statusCode).toBe(200);
            const secondPermit = await ctx.app.inject({
              method: "POST",
              url: `${ctx.url}/operations/b/permit`,
              headers: ctx.headers,
              payload: { approvalId: permit.approvalId, expectedManifestHash: permit.manifestHash }
            });
            expect(secondPermit.statusCode, secondPermit.body).toBe(201);
            const secondIssued = await ctx.app.inject({
              method: "POST",
              url: "/dc/capability/issue",
              headers,
              payload: {
                client_id: "fixture-client",
                tool: "write_file",
                argsSummary: JSON.stringify(ctx.payload.definition.operations[1]!.action.params),
                changeSetPermitId: secondPermit.json().permitId
              }
            });
            expect(secondIssued.statusCode, secondIssued.body).toBe(200);
            const other = secondIssued.json();
            writeFileSync(join(ctx.root, "b"), "expected");
            const secondInput = submitWorkResultSchema.parse({
              ...input,
              workItemId: other.workItemId,
              attemptId: other.attemptId,
              leaseId: other.leaseId,
              actionHash: other.claimActionHash,
              planHash: other.planHash,
              inputHash: other.inputHash,
              fencingEpoch: other.leaseEpoch,
              idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: other.attemptId }),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              simulationMetadata: { ...input.simulationMetadata, invocationFingerprint: other.invocationHash }
            });
            store.submitWorkResult(secondInput);
            verifyChangeSetResult(store, secondInput, { allowedRoots: [ctx.root], deniedRoots: [] });
            const otherEvidence = store.getEvidenceManifestForAttempt(other.attemptId)!;
            expect(
              (await review({ ...reviewPayload, evidenceManifestHash: otherEvidence.manifestHash })).statusCode
            ).toBe(409);
            expect((await review({ ...reviewPayload, attemptId: other.attemptId })).statusCode).toBe(409);
            expect(store.listReviewFindings(body.attemptId)).toHaveLength(1);
          }
          if (scenario === "forged evidence") {
            const db = new DatabaseSync(ctx.dbPath);
            try {
              db.exec("DROP TRIGGER evidence_manifests_no_update");
              db.prepare("UPDATE evidence_manifests SET manifest_json = ? WHERE manifest_hash = ?").run(
                JSON.stringify({ ...evidence!.manifest, verifierId: "forged" }),
                evidence!.manifestHash
              );
            } finally {
              db.close();
            }
            expect((await review()).statusCode).toBe(409);
            expect(() => complete()).toThrow();
            return;
          }
          if (scenario === "lease expiry after evidence") {
            // Accepted execution consumed the lease. Expiry cleanup must not turn
            // persisted evidence into unknown work or demand a new execution.
            expect(store.failExpiredLeases(new Date(Date.now() + 3_600_000))).toHaveLength(0);
          }
          if (scenario === "review rejection") {
            const denied = await review({ ...reviewPayload, verdict: "BLOCK" });
            expect(denied.statusCode, denied.body).toBe(200);
            expect(store.getChangeSetProgress(ctx.mission.id).operations[0]!.status).toBe("blocked");
            expect((await review()).statusCode).toBe(409);
            expect(() => complete()).toThrow();
            return;
          }
          if (scenario === "forged decision") {
            expect(() =>
              store.recordVerificationDecision(
                {
                  attemptId: body.attemptId,
                  workItemId: body.workItemId,
                  outcome: "attempt_accepted",
                  evidenceManifestHash: evidence!.manifestHash,
                  reviewFindingHashes: [],
                  verificationPolicyVersion: "acs.change-set.verification.v2"
                },
                { via: "policy_gate" }
              )
            ).toThrow("authentic independent");
            expect(store.getVerificationDecision(body.attemptId)).toBeUndefined();
          }
          if (scenario === "concurrent reviewer replay") {
            const responses = await Promise.all([review(), review()]);
            expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
            expect(responses[0]!.json()).toEqual(responses[1]!.json());
          }
          const reviewed = await review();
          expect(reviewed.statusCode, reviewed.body).toBe(200);
          if (scenario === "two reviewers") {
            expect(store.getVerificationDecision(body.attemptId)).toBeUndefined();
            expect((await review()).statusCode).toBe(200);
            expect(store.listReviewFindings(body.attemptId)).toHaveLength(1);
            expect(store.getChangeSetProgress(ctx.mission.id).operations[0]!.status).toBe("awaiting_verification");
            expect((await review(reviewPayload, "mixed-reviewer-token")).statusCode).toBe(200);
            expect(store.getVerificationDecision(body.attemptId)!.reviewFindingHashes).toHaveLength(2);
          }
          if (scenario === "forged review") {
            const db = new DatabaseSync(ctx.dbPath);
            try {
              db.exec("DROP TRIGGER review_findings_no_update");
              db.prepare("UPDATE review_findings SET reviewer_principal_id = 'planner' WHERE attempt_id = ?").run(
                body.attemptId
              );
            } finally {
              db.close();
            }
            expect(() => complete()).toThrow();
            expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(0);
            return;
          }
          if (["reviewer replay", "concurrent reviewer replay"].includes(scenario)) {
            expect((await review()).json()).toEqual(reviewed.json());
            expect((await review({ ...reviewPayload, verdict: "BLOCK" })).statusCode).toBe(409);
            expect(store.listReviewFindings(body.attemptId)).toHaveLength(1);
            expect(store.readEvents({ name: "verification.decision" })).toHaveLength(1);
          }
          const ordered = store.readEvents({ workItemId: body.workItemId });
          const names = ordered.map((event) => event.name);
          expect(names.indexOf("execution_attempt.result_accepted")).toBeLessThan(
            names.indexOf("evidence.manifest_recorded")
          );
          expect(names.indexOf("evidence.manifest_recorded")).toBeLessThan(names.indexOf("review.finding_recorded"));
          expect(names.indexOf("review.finding_recorded")).toBeLessThan(names.indexOf("verification.decision"));
          const progress = store.getChangeSetProgress(ctx.mission.id, permit.manifestHash);
          expect(progress.operations[0]).toMatchObject({
            status: "succeeded",
            permitId: permit.permitId,
            executionWorkItemId: body.workItemId,
            attemptId: body.attemptId
          });
          expect(progress.operations[0]!.evidenceManifestHash).toBe(
            store.getVerificationDecision(body.attemptId)!.evidenceManifestHash
          );
          if (["mission completion", "completion before verification"].includes(scenario)) {
            const complete = {
              missionId: ctx.mission.id,
              expectedManifestHash: permit.manifestHash,
              executingActorId: "planner",
              approvalId: permit.approvalId
            };
            const options = { via: "policy_gate" as const, actorId: "planner" };
            expect(() =>
              store.completeChangeSetMission(complete, { via: "domain_service", actorId: "planner" })
            ).toThrow("bound executing actor");
            expect(() =>
              store.completeChangeSetMission(
                { ...complete, executingActorId: "spoofed" },
                { ...options, actorId: "spoofed" }
              )
            ).toThrow("approval binding");
            expect(() => store.completeChangeSetMission({ ...complete, authorizationId: "extra" }, options)).toThrow(
              "exactly one authority"
            );
            expect(() => store.getChangeSetProgress(ctx.mission.id, "0".repeat(64))).toThrow("snapshot changed");
            const db = new DatabaseSync(ctx.dbPath);
            try {
              db.exec(`CREATE TRIGGER test_completion_rollback BEFORE UPDATE ON work_items WHEN NEW.id = '${ctx.mission.id}' AND NEW.status = 'succeeded'
                BEGIN SELECT RAISE(ABORT, 'completion rollback fixture'); END;`);
              expect(() => store.completeChangeSetMission(complete, options)).toThrow("completion rollback fixture");
              expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(0);
              expect(store.getChangeSetProgress(ctx.mission.id).completion).toBeUndefined();
              db.exec("DROP TRIGGER test_completion_rollback");
            } finally {
              db.close();
            }
            const receipt = store.completeChangeSetMission(complete, options);
            expect(store.get(ctx.mission.id)!.status).toBe("succeeded");
            expect(store.completeChangeSetMission(complete, options)).toEqual(receipt);
            expect(() => store.completeChangeSetMission({ ...complete, approvalId: "different" }, options)).toThrow(
              "different authority"
            );
            expect(store.getChangeSetProgress(ctx.mission.id).completion).toEqual(receipt);
            expect(store.readEvents({ name: "change_set.completed" })).toHaveLength(1);
            const trace = await ctx.app.inject({
              method: "GET",
              url: `/work-items/${ctx.mission.id}/mission-trace?limit=200`,
              headers: ctx.headers
            });
            expect(trace.statusCode, trace.body).toBe(200);
            const timeline = trace.json();
            expect(timeline.globalChainVerified).toBe(false);
            expect(timeline.operations).toHaveLength(1);
            const names = timeline.events.map((entry: { event: { name: string } }) => entry.event.name);
            expect(names).toEqual(
              expect.arrayContaining([
                "change_set.submitted",
                "change_set.policy_evaluated",
                "change_set.approved",
                "change_set.operation_permitted",
                "execution_admission.bound",
                "execution_attempt.result_accepted",
                "evidence.manifest_recorded",
                "review.finding_recorded",
                "verification.decision",
                "change_set.completed"
              ])
            );
            const resultEvent = timeline.events.find(
              (entry: { event: { name: string } }) => entry.event.name === "execution_attempt.result_accepted"
            );
            expect(resultEvent.correlation).toMatchObject({
              missionId: ctx.mission.id,
              manifestHash: permit.manifestHash,
              operationId: "a",
              permitId: permit.permitId,
              attemptId: body.attemptId,
              leaseId: body.leaseId
            });
            expect(
              (await ctx.app.inject({ method: "GET", url: `/work-items/${ctx.mission.id}/mission-trace` })).statusCode
            ).toBe(401);
            expect(
              (
                await ctx.app.inject({
                  method: "GET",
                  url: `/work-items/${ctx.mission.id}/mission-trace?limit=201`,
                  headers: ctx.headers
                })
              ).statusCode
            ).toBe(400);

            const replay = await ctx.app.inject({
              method: "POST",
              url: `${ctx.url}/complete`,
              headers: ctx.headers,
              payload: { expectedManifestHash: permit.manifestHash, approvalId: permit.approvalId }
            });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(receipt);
          } else if (scenario === "persisted result tampering") {
            const db = new DatabaseSync(ctx.dbPath);
            try {
              expect(() =>
                db.prepare("UPDATE attempt_results SET summary = 'tampered' WHERE attempt_id = ?").run(body.attemptId)
              ).toThrow("append-only");
              db.exec("DROP TRIGGER attempt_results_immutable_guard");
              db.prepare("UPDATE attempt_results SET summary = 'tampered' WHERE attempt_id = ?").run(body.attemptId);
            } finally {
              db.close();
            }
            expect(() => store.getChangeSetProgress(ctx.mission.id)).toThrow("execution evidence");
            const response = await ctx.app.inject({
              method: "GET",
              url: `${ctx.url}/progress?expectedManifestHash=${permit.manifestHash}`,
              headers: ctx.headers
            });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json().code).toBe("change_set_progress_integrity_mismatch");
          } else {
            expect(() =>
              store.completeChangeSetMission(
                {
                  missionId: ctx.mission.id,
                  expectedManifestHash: permit.manifestHash,
                  executingActorId: "planner",
                  approvalId: permit.approvalId
                },
                { via: "policy_gate", actorId: "planner" }
              )
            ).toThrow("every operation");
          }
          expect(store.verifyAuditChain().ok).toBe(true);
        } finally {
          store.close();
        }
        return;
      }
      const response = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${body.workItemId}/results`,
        headers: { authorization: "Bearer dc-bridge-token" },
        payload
      });
      expect(response.statusCode, response.body).toBe(409);
      const codes: Record<string, string> = {
        "absent file": "verification_not_satisfied",
        "wrong content": "verification_not_satisfied",
        "simulated execution": "verification_execution_binding_mismatch",
        "wrong invocation": "verification_execution_binding_mismatch",
        "missing requirement": "verification_not_satisfied",
        "independent review": "independent_review_required"
      };
      expect(response.json().code).toBe(codes[scenario]);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.get(permit.executionWorkItemId)!.status).toBe("running");
        expect(store.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(0);
        expect(store.isVerificationSatisfiedForAttempt(body.attemptId).satisfied).toBe(false);
        expect(store.getAdmissionPermit(body.attemptId)!.leaseId).toBe(body.leaseId);
        expect(store.getVerificationDecision(body.attemptId)).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("Change Set operation permits", () => {
  it("upgrades a version-46 legacy permit without changing its approved snapshot or hash", async () => {
    const ctx = fixture();
    let closed = false;
    try {
      const { permit } = await approveAndPermit(ctx);
      await ctx.app.close();
      closed = true;
      const db = new DatabaseSync(ctx.dbPath);
      try {
        const prior = db.prepare("SELECT * FROM change_set_operation_permits").get() as Record<
          string,
          string | number | null
        >;
        // Reconstruct the immediately preceding supported schema in this isolated
        // fixture. Its legacy row and all referenced domain/audit data are real.
        db.exec("BEGIN IMMEDIATE");
        db.exec("DROP TABLE change_set_operation_permits");
        db.exec(
          readFileSync(
            new URL("../../../storage/migrations/045_change_set_operation_permits.sql", import.meta.url),
            "utf8"
          )
        );
        db.prepare("INSERT INTO change_set_operation_permits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          prior.permit_id,
          prior.mission_id,
          prior.revision,
          prior.manifest_hash,
          prior.operation_id,
          prior.approval_id,
          prior.execution_work_item_id,
          prior.record_json,
          prior.permit_hash,
          prior.audit_event_id
        );
        db.prepare("DELETE FROM schema_migrations WHERE version = 47").run();
        db.exec("COMMIT");
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
      const upgraded = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(upgraded.getChangeSetOperationPermit(permit.permitId)).toEqual(permit);
        expect(upgraded.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "acs-dc-bridge")).toEqual(
          permit
        );
        expect(upgraded.verifyAuditChain().ok).toBe(true);
      } finally {
        upgraded.close();
      }
      const migrated = new DatabaseSync(ctx.dbPath);
      try {
        expect(migrated.prepare("SELECT authorization_id FROM change_set_operation_permits").get()).toEqual({
          authorization_id: null
        });
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        migrated.close();
      }
    } finally {
      if (!closed) await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rolls back child execution, derived approvals and audit when permit persistence fails", async () => {
    const ctx = fixture();
    try {
      const payload = await proposeForApproval(ctx, true);
      const approved = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/approve`,
        headers: reviewerHeaders,
        payload
      });
      expect(approved.statusCode, approved.body).toBe(201);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      let beforeEvents: number;
      try {
        beforeEvents = store.readEvents().length;
      } finally {
        store.close();
      }
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec(
          "CREATE TRIGGER reject_test_permit BEFORE INSERT ON change_set_operation_permits BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
        );
      } finally {
        db.close();
      }
      const failed = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/operations/a/permit`,
        headers: ctx.headers,
        payload: { expectedManifestHash: payload.expectedManifestHash, approvalId: approved.json().approvalId }
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      const reopened = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(reopened.list()).toHaveLength(1);
        expect(reopened.readEvents()).toHaveLength(beforeEvents);
      } finally {
        reopened.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("does not turn an execution into legacy authority when its permit projection and marker disappear", async () => {
    const ctx = fixture();
    try {
      const { permit } = await approveAndPermit(ctx);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        expect(() => db.prepare("DELETE FROM change_set_operation_permits").run()).toThrow(/immutable/u);
        db.exec("DROP TRIGGER change_set_operation_permits_no_delete");
        db.prepare("DELETE FROM change_set_operation_permits").run();
        db.prepare(
          "UPDATE work_items SET requested_actions_json = json_remove(requested_actions_json, '$[0].params.changeSetBinding') WHERE id = ?"
        ).run(permit.executionWorkItemId);
      } finally {
        db.close();
      }
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() => store.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "acs-dc-bridge")).toThrow(
          /projection missing/u
        );
      } finally {
        store.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("issues JC capabilities from the same human-approved bundle without another human approval", async () => {
    const ctx = fixture();
    try {
      ctx.payload.definition.operations.forEach((op) => {
        op.runtime = "jace_commander";
      });
      const { permit } = await approveAndPermit(ctx);
      expect(permit.runtime).toBe("jace_commander");
      const payload = {
        client_id: "fixture-client",
        tool: "write_file",
        argsSummary: JSON.stringify(ctx.payload.definition.operations[0]!.action.params),
        changeSetPermitId: permit.permitId
      };
      const issued = await ctx.app.inject({
        method: "POST",
        url: "/jc/capability/issue",
        headers: { authorization: "Bearer jc-bridge-token", "x-jc-actor": "planner" },
        payload
      });
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().workItemId).toBe(permit.executionWorkItemId);
      expect(issued.json().capability.payload).toMatchObject({
        version: "acs.jc.v1",
        invocationHash: permit.invocationHash
      });
      const wrongLane = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { authorization: "Bearer dc-bridge-token", "x-dc-actor": "planner" },
        payload
      });
      expect(wrongLane.statusCode, wrongLane.body).toBe(409);
      expect(wrongLane.json().code).toBe("change_set_permit_binding_mismatch");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("limits concurrent independent operations and fences a permit after amendment", async () => {
    const ctx = fixture();
    try {
      ctx.payload.definition.operations[1]!.dependsOn = [];
      const { permit: a, permitBody } = await approveAndPermit(ctx);
      const response = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/operations/b/permit`,
        headers: ctx.headers,
        payload: permitBody
      });
      expect(response.statusCode, response.body).toBe(201);
      const b = response.json();
      const claimed = await ctx.app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: "Bearer dc-bridge-token" },
        payload: {}
      });
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect(claimed.json().workItem.id).toBe(a.executionWorkItemId);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() => store.requireActiveChangeSetOperationPermit(b.executionWorkItemId, "acs-dc-bridge")).toThrow(
          /concurrency limit/u
        );
      } finally {
        store.close();
      }
      const amended = await ctx.app.inject({
        method: "POST",
        url: ctx.url,
        headers: ctx.headers,
        payload: {
          ...ctx.payload,
          submissionId: "new-execution-plan",
          expectedHeadHash: a.manifestHash,
          definition: { ...ctx.payload.definition, objective: "new plan requires review" }
        }
      });
      expect(amended.statusCode, amended.body).toBe(201);
      const reopened = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() => reopened.requireActiveChangeSetOperationPermit(b.executionWorkItemId, "acs-dc-bridge")).toThrow(
          /superseded/u
        );
      } finally {
        reopened.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("binds one durable canonical child to an approved operation and rejects unapproved or wrong-actor selectors", async () => {
    const ctx = fixture();
    try {
      const { permit, permitBody, permitUrl } = await approveAndPermit(ctx);
      const replay = await ctx.app.inject({
        method: "POST",
        url: permitUrl,
        headers: ctx.headers,
        payload: permitBody
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(permit);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(store.getChangeSetOperationPermit(permit.permitId)).toEqual(permit);
        expect(store.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "acs-dc-bridge")).toEqual(
          permit
        );
        expect(() => store.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "other-worker")).toThrow(
          /binding changed/u
        );
        expect(() =>
          store.requireActiveChangeSetOperationPermit(
            permit.executionWorkItemId,
            "acs-dc-bridge",
            new Date(permit.expiresAt)
          )
        ).toThrow(/time budget/u);
        expect(store.readEvents().filter((e) => e.name === "change_set.operation_permitted")).toHaveLength(1);
      } finally {
        store.close();
      }
      const wrongActor = await ctx.app.inject({
        method: "POST",
        url: permitUrl,
        headers: { authorization: "Bearer dc-bridge-token" },
        payload: permitBody
      });
      expect(wrongActor.statusCode, wrongActor.body).toBe(409);
      const absent = await ctx.app.inject({
        method: "POST",
        url: `${ctx.url}/operations/unapproved/permit`,
        headers: ctx.headers,
        payload: permitBody
      });
      expect(absent.statusCode, absent.body).toBe(409);
      expect(absent.json().code).toBe("change_set_operation_not_found");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("enforces dependencies and parent revocation before any canonical claim", async () => {
    const ctx = fixture();
    try {
      const { permit, permitBody } = await approveAndPermit(ctx, "b");
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() => store.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "acs-dc-bridge")).toThrow(
          /dependency/u
        );
      } finally {
        store.close();
      }
      const revoked = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${ctx.mission.id}/change-set-approvals/${permitBody.approvalId}/revoke`,
        headers: reviewerHeaders,
        payload: { reason: "cancel authority" }
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const claim = await ctx.app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: "Bearer dc-bridge-token" }
      });
      expect(claim.statusCode, claim.body).toBe(409);
      expect(claim.json().code).toBe("change_set_approval_revoked");
      const reopened = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(() =>
          reopened.requireActiveChangeSetOperationPermit(permit.executionWorkItemId, "acs-dc-bridge")
        ).toThrow(/revoked/u);
      } finally {
        reopened.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("issues an existing lease-bound DC capability for the exact approved operation and rejects extra calls and replay", async () => {
    const ctx = fixture();
    try {
      const { permit } = await approveAndPermit(ctx);
      const headers = { authorization: "Bearer dc-bridge-token", "x-dc-actor": "planner" };
      const bootstrapBody = {
        runtimeId: "bundle-dc",
        identityConfigFingerprint: "a".repeat(64),
        scopes: ["fs.read", "fs.write"]
      };
      const challenge = await ctx.app.inject({
        method: "POST",
        url: "/dc/runtime/bootstrap",
        headers,
        payload: bootstrapBody
      });
      expect(challenge.statusCode, challenge.body).toBe(201);
      const complete = await ctx.app.inject({
        method: "POST",
        url: "/dc/runtime/bootstrap/complete",
        headers,
        payload: {
          ...bootstrapBody,
          challenge: challenge.json().challenge,
          runtimeIdentity: {
            schemaVersion: 1,
            runtimeId: "bundle-dc",
            challenge: challenge.json().challenge,
            scopes: bootstrapBody.scopes
          }
        }
      });
      expect(complete.statusCode, complete.body).toBe(204);
      const payload = {
        client_id: "fixture-client",
        tool: "write_file",
        argsSummary: JSON.stringify(ctx.payload.definition.operations[0]!.action.params),
        changeSetPermitId: permit.permitId
      };
      const extra = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers,
        payload: { ...payload, argsSummary: JSON.stringify({ path: join(ctx.root, "extra"), content: "not approved" }) }
      });
      expect(extra.statusCode, extra.body).toBe(409);
      expect(extra.json().code).toBe("change_set_permit_binding_mismatch");
      const issued = await ctx.app.inject({ method: "POST", url: "/dc/capability/issue", headers, payload });
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().workItemId).toBe(permit.executionWorkItemId);
      expect(issued.json().capability.payload.invocationHash).toBe(permit.invocationHash);
      const store = new SqliteWorkItemStore(ctx.dbPath);
      try {
        const lease = store.getActiveLeaseForAttempt(issued.json().attemptId)!;
        expect(Date.parse(lease.expiresAt)).toBeLessThanOrEqual(Date.parse(permit.expiresAt));
        expect(Date.parse(lease.maxExpiresAt)).toBeLessThanOrEqual(Date.parse(permit.expiresAt));
      } finally {
        store.close();
      }
      const replay = await ctx.app.inject({ method: "POST", url: "/dc/capability/issue", headers, payload });
      expect(replay.statusCode, replay.body).toBe(409);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});
