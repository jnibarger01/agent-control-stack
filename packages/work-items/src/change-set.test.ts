import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANGE_SET_SCHEMA_VERSION,
  SqliteWorkItemStore,
  changeSetDefinitionSchema,
  changeSetManifestHash,
  executionPlanSubjectInputHash,
  type ChangeSetDefinition,
  type ChangeSetSnapshot
} from "./index.js";

const directories: string[] = [];
const stores: SqliteWorkItemStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const now = new Date("2030-01-01T00:00:00.000Z");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-change-set-"));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  stores.push(store);
  const mission = store.create({
    title: "Change set mission",
    requester: "user",
    requesterSubject: "human-operator",
    intent: "inspect and repair a bounded issue",
    target: { repo: "/repo" },
    requestedActions: [{ kind: "fs.write", description: "repair the source", params: { paths: ["/repo/a.ts"] } }],
    risk: "medium"
  });
  const scope: ChangeSetDefinition["scope"] = [{ kind: "repository", id: "/repo" }];
  const definition: ChangeSetDefinition = {
    schemaVersion: CHANGE_SET_SCHEMA_VERSION,
    missionId: mission.id,
    subjectInputHash: executionPlanSubjectInputHash(mission),
    executingActorId: "agent-engineer",
    objective: "repair and verify the source",
    scope,
    maximumPrivileges: ["fs.read", "fs.write"],
    expiresAt: "2030-01-01T01:00:00.000Z",
    constraints: { maxRuntimeMs: 30_000, maxParallelOperations: 1, failureBehavior: "stop" },
    operations: [
      {
        operationId: "inspect",
        runtime: "desktop_commander",
        toolName: "read_file",
        action: { kind: "fs.read", description: "inspect source", params: { path: "/repo/a.ts" } },
        resources: scope,
        requestedPrivileges: ["fs.read"],
        effect: "read_only",
        expectedSideEffects: [],
        dependsOn: [],
        retry: { maxAttempts: 1, idempotencyKey: "inspect-once" }
      },
      {
        operationId: "edit",
        runtime: "desktop_commander",
        toolName: "write_file",
        action: { kind: "fs.write", description: "repair source", params: { path: "/repo/a.ts", content: "fixed" } },
        resources: scope,
        requestedPrivileges: ["fs.write"],
        effect: "mutation",
        expectedSideEffects: ["replace /repo/a.ts"],
        dependsOn: ["inspect"],
        retry: { maxAttempts: 1, idempotencyKey: "edit-once" }
      }
    ],
    verification: [
      {
        requirementId: "read-back",
        operationIds: ["edit"],
        kind: "fs_inspect",
        expectation: { content: "fixed" },
        independent: false
      }
    ]
  };
  const submit = (submissionId = "submit-1", expectedHeadHash: string | null = null, proposed = definition) =>
    store.submitChangeSet({
      definition: proposed,
      submissionId,
      expectedHeadHash,
      createdByActorId: "agent-engineer",
      now
    });
  return { dbPath, store, mission, definition, submit };
}

describe("immutable Change Set snapshot", () => {
  const mutations: Array<[string, (definition: ChangeSetDefinition) => void]> = [
    [
      "expiration",
      (d) => {
        d.expiresAt = "2030-01-01T02:00:00.000Z";
      }
    ],
    [
      "executing actor",
      (d) => {
        d.executingActorId = "another-agent";
      }
    ],
    [
      "operation identity",
      (d) => {
        d.operations[0]!.operationId = "renamed";
        d.operations[1]!.dependsOn = ["renamed"];
      }
    ],
    [
      "tool",
      (d) => {
        d.operations[1]!.toolName = "edit_block";
      }
    ],
    [
      "operation parameters",
      (d) => {
        d.operations[1]!.action.params.content = "other bytes";
      }
    ],
    [
      "dependencies",
      (d) => {
        d.operations[1]!.dependsOn = [];
      }
    ],
    [
      "verification expectation",
      (d) => {
        d.verification[0]!.expectation.content = "other bytes";
      }
    ],
    [
      "verification independence",
      (d) => {
        d.verification[0]!.independent = true;
      }
    ],
    [
      "maximum privileges",
      (d) => {
        d.maximumPrivileges.push("deploy");
      }
    ],
    [
      "retry budget",
      (d) => {
        d.operations[1]!.retry.maxAttempts = 2;
      }
    ],
    [
      "parallel execution constraint",
      (d) => {
        d.constraints.maxParallelOperations = 2;
      }
    ],
    [
      "scope",
      (d) => {
        d.scope.push({ kind: "repository", id: "/other" });
      }
    ],
    [
      "side effects",
      (d) => {
        d.operations[1]!.expectedSideEffects.push("another effect");
      }
    ]
  ];
  for (const [name, mutate] of mutations) {
    it(`binds ${name} into the approved snapshot hash`, () => {
      const { definition } = fixture();
      const snapshot: ChangeSetSnapshot = { revision: 1, parentManifestHash: null, definition };
      const changed = structuredClone(snapshot);
      mutate(changed.definition);
      expect(changeSetManifestHash(changed)).not.toBe(changeSetManifestHash(snapshot));
    });
  }

  it("rejects cycles, missing dependencies, duplicate operation IDs and out-of-scope resources", () => {
    const { definition } = fixture();
    for (const mutate of [
      (d: ChangeSetDefinition) => {
        d.operations[0]!.dependsOn = ["edit"];
      },
      (d: ChangeSetDefinition) => {
        d.operations[1]!.dependsOn = ["missing"];
      },
      (d: ChangeSetDefinition) => {
        d.operations[0]!.operationId = "edit";
      },
      (d: ChangeSetDefinition) => {
        d.operations[1]!.resources = [{ kind: "repository", id: "/other" }];
      },
      (d: ChangeSetDefinition) => {
        d.operations[1]!.requestedPrivileges = ["deploy"];
      }
    ]) {
      const changed = structuredClone(definition);
      mutate(changed);
      expect(changeSetDefinitionSchema.safeParse(changed).success).toBe(false);
    }
  });

  it("requires machine evidence for mutations and independent review for privileged operations", () => {
    const { definition } = fixture();
    const changed = structuredClone(definition);
    changed.verification = [];
    expect(changeSetDefinitionSchema.safeParse(changed).success).toBe(false);
    changed.verification = definition.verification;
    changed.operations[1]!.effect = "privileged";
    expect(changeSetDefinitionSchema.safeParse(changed).success).toBe(false);
    changed.verification.push({
      requirementId: "review",
      operationIds: ["edit"],
      kind: "independent_review",
      expectation: { verdict: "pass" },
      independent: true
    });
    expect(changeSetDefinitionSchema.safeParse(changed).success).toBe(true);
    changed.verification[1]!.independent = false;
    expect(changeSetDefinitionSchema.safeParse(changed).success).toBe(false);
  });

  it("rejects unsupported JSON and caller-supplied authority fields", () => {
    const { definition } = fixture();
    const snapshot = { revision: 1, parentManifestHash: null, definition };
    expect(() => changeSetManifestHash({ ...snapshot, approved: true })).toThrow();
    expect(() => changeSetManifestHash({ ...snapshot, definition: { ...definition, extra: undefined } })).toThrow();
    definition.operations[1]!.action.params.value = Number.NaN;
    expect(() => changeSetManifestHash(snapshot)).toThrow();
  });
});

describe("Change Set persistence", () => {
  it("persists an audited immutable snapshot across restart without granting approval", () => {
    const { dbPath, store, submit, mission } = fixture();
    const record = submit();
    const reopened = new SqliteWorkItemStore(dbPath);
    stores.push(reopened);
    expect(reopened.getChangeSet(mission.id)).toEqual(record);
    expect(reopened.get(mission.id)?.status).toBe(mission.status);
    expect(reopened.readEvents().filter((event) => event.name === "change_set.submitted")).toHaveLength(1);
    expect(reopened.verifyAuditChain().ok).toBe(true);
    expect(store.getCurrentExecutionPlan(mission.id)).toBeUndefined();
  });

  it("replays the exact submission once and rejects reuse for changed content or actor", () => {
    const { store, definition, submit } = fixture();
    const record = submit();
    expect(submit()).toEqual(record);
    const changed = structuredClone(definition);
    changed.objective = "material amendment";
    expect(() => submit("submit-1", null, changed)).toThrow(/already used/);
    expect(() =>
      store.submitChangeSet({
        definition,
        submissionId: "submit-1",
        expectedHeadHash: null,
        createdByActorId: "other-agent",
        now
      })
    ).toThrow(/already used/);
    expect(store.readEvents().filter((event) => event.name === "change_set.submitted")).toHaveLength(1);
  });

  it("chains amendments and fences a competing writer with the old head", () => {
    const { dbPath, store, mission, definition, submit } = fixture();
    const first = submit();
    const competing = new SqliteWorkItemStore(dbPath);
    stores.push(competing);
    const amended = structuredClone(definition);
    amended.objective = "amended plan";
    const second = submit("submit-2", first.manifestHash, amended);
    expect(second.snapshot.revision).toBe(2);
    expect(second.snapshot.parentManifestHash).toBe(first.manifestHash);
    expect(store.getChangeSet(mission.id, 1)).toEqual(first);
    expect(() =>
      competing.submitChangeSet({
        definition,
        submissionId: "losing-writer",
        expectedHeadHash: first.manifestHash,
        createdByActorId: "agent-engineer",
        now
      })
    ).toThrow(/head changed/);
    expect(store.getChangeSet(mission.id)).toEqual(second);
  });

  it("rolls back the revision when head persistence fails", () => {
    const { dbPath, store, mission, submit } = fixture();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER fail_change_set_head BEFORE INSERT ON change_set_heads BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
      );
      expect(() => submit()).toThrow(/injected failure/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM change_set_revisions").get()).toEqual({ count: 0 });
      expect(store.getChangeSet(mission.id)).toBeUndefined();
      expect(store.readEvents().filter((event) => event.name === "change_set.submitted")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("enforces append-only SQL and detects tampering if a privileged writer removes that protection", () => {
    const { dbPath, store, mission, submit } = fixture();
    submit();
    const db = new DatabaseSync(dbPath);
    try {
      expect(() => db.exec("UPDATE change_set_revisions SET snapshot_json = '{}' ")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM change_set_revisions")).toThrow(/immutable/);
      db.exec("DROP TRIGGER change_set_revisions_no_update; UPDATE change_set_revisions SET snapshot_json = '{}'");
      expect(() => store.getChangeSet(mission.id)).toThrow(/integrity verification/);
    } finally {
      db.close();
    }
  });

  it("rejects head rollback even when it points to a valid older snapshot", () => {
    const { dbPath, store, mission, definition, submit } = fixture();
    const first = submit();
    submit("submit-2", first.manifestHash, definition);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE change_set_heads SET revision = 1, manifest_hash = ?").run(first.manifestHash);
      expect(() => store.getChangeSet(mission.id)).toThrow(/head is stale/);
    } finally {
      db.close();
    }
  });

  it("rejects expiration and mission input mismatch without persisting a revision", () => {
    const { store, mission, definition, submit } = fixture();
    const expired = structuredClone(definition);
    expired.expiresAt = now.toISOString();
    expect(() => submit("expired", null, expired)).toThrow(/expiration/);
    const mismatched = structuredClone(definition);
    mismatched.subjectInputHash = "a".repeat(64);
    expect(() => submit("mismatch", null, mismatched)).toThrow(/mission inputs/);
    expect(store.getChangeSet(mission.id)).toBeUndefined();
  });

  it("binds provenance to the submission audit event", () => {
    const { dbPath, store, mission, submit } = fixture();
    const record = submit();
    expect(store.readEvents().find((event) => event.id === record.auditEventId)?.body.manifestHash).toBe(
      record.manifestHash
    );
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "DROP TRIGGER change_set_revisions_no_update; UPDATE change_set_revisions SET created_by_actor_id = 'another-agent'"
      );
      expect(() => store.getChangeSet(mission.id)).toThrow(/integrity verification/);
    } finally {
      db.close();
    }
  });

  it("detects a modified submission audit body during read", () => {
    const { dbPath, store, mission, submit } = fixture();
    const record = submit();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE audit_events SET body = '{}' WHERE id = ?").run(record.auditEventId);
      expect(() => store.getChangeSet(mission.id)).toThrow(/integrity verification/);
      expect(store.verifyAuditChain().ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects a self-consistent rewritten snapshot that no longer matches its audit anchor", () => {
    const { dbPath, store, mission, submit } = fixture();
    const record = submit();
    const rewritten = structuredClone(record.snapshot);
    rewritten.definition.expiresAt = "2030-01-01T02:00:00.000Z";
    const rewrittenHash = changeSetManifestHash(rewritten);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP TRIGGER change_set_revisions_no_update");
      // Preserve foreign-key checks: replace the head inside one transaction
      // while simulating a privileged writer that removed the immutable trigger.
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM change_set_heads WHERE mission_id = ?").run(mission.id);
      db.prepare("UPDATE change_set_revisions SET snapshot_json = ?, manifest_hash = ?").run(
        JSON.stringify(rewritten),
        rewrittenHash
      );
      db.prepare("INSERT INTO change_set_heads (mission_id, revision, manifest_hash) VALUES (?, 1, ?)").run(
        mission.id,
        rewrittenHash
      );
      db.exec("COMMIT");
      expect(() => store.getChangeSet(mission.id)).toThrow(/integrity verification/);
      expect(store.verifyAuditChain().ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rolls back revision and head when audit persistence fails", () => {
    const { dbPath, store, mission, submit } = fixture();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER fail_change_set_audit BEFORE INSERT ON audit_events WHEN NEW.name = 'change_set.submitted' BEGIN SELECT RAISE(ABORT, 'audit failure'); END;"
      );
      expect(() => submit()).toThrow(/audit failure/);
      expect(store.getChangeSet(mission.id)).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM change_set_revisions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("preserves opaque authenticated principal IDs", () => {
    const { store, definition } = fixture();
    definition.executingActorId = "auth0|engineer@example.com";
    const record = store.submitChangeSet({
      definition,
      submissionId: "opaque-actor",
      expectedHeadHash: null,
      createdByActorId: "human@example.com",
      now
    });
    expect(store.getChangeSet(definition.missionId)).toEqual(record);
  });
});
