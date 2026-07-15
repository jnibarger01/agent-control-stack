import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { stableHash, type AuditChainVerification } from "@agent-control-stack/shared";
import {
  SqliteWorkItemStore,
  WorkItemEvent,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { replay } from "./replay.js";

const expectedEventNames = [
  WorkItemEvent.Created,
  "policy.decided",
  WorkItemEvent.NeedsApproval,
  "policy.decided",
  "approval.granted",
  WorkItemEvent.Approved,
  WorkItemEvent.Running,
  "policy.decided",
  "approval.consumed",
  WorkItemEvent.Succeeded
];

export interface SqliteEvaluationRun {
  databasePath: string;
  chainVerification: AuditChainVerification;
  finalProjection: WorkItem;
  eventNames: string[];
  semanticDigest: string;
}

export interface DeterministicSqliteEvaluation {
  verdict: "PASS";
  runs: [SqliteEvaluationRun, SqliteEvaluationRun];
  tamperedDatabasePath: string;
  tamperDetection: {
    ok: true;
    sequence: number;
    reason: "previous_hash_mismatch" | "event_hash_mismatch";
  };
}

export function runDeterministicSqliteEvaluation(_rootDir: string): DeterministicSqliteEvaluation {
  mkdirSync(_rootDir, { recursive: true });
  const first = runGoldenPath(join(_rootDir, "run-1.db"));
  const second = runGoldenPath(join(_rootDir, "run-2.db"));

  if (first.semanticDigest !== second.semanticDigest) {
    throw new Error(`SQLite evaluation semantic mismatch: ${first.semanticDigest} != ${second.semanticDigest}`);
  }

  const tamperedDatabasePath = join(_rootDir, "tampered.db");
  copyFileSync(first.databasePath, tamperedDatabasePath);
  tamperAuditBody(tamperedDatabasePath, 2);
  const tamperedStore = new SqliteWorkItemStore(tamperedDatabasePath);
  let tamperedVerification: AuditChainVerification;
  try {
    tamperedVerification = tamperedStore.verifyAuditChain();
  } finally {
    tamperedStore.close();
  }

  if (tamperedVerification.ok) {
    throw new Error("SQLite evaluation tampered audit chain verified successfully");
  }
  if (
    tamperedVerification.failure.sequence !== 2 ||
    tamperedVerification.failure.reason !== "event_hash_mismatch"
  ) {
    throw new Error(
      `SQLite evaluation tamper mismatch: ${tamperedVerification.failure.reason} at ${tamperedVerification.failure.sequence}`
    );
  }

  return {
    verdict: "PASS",
    runs: [first, second],
    tamperedDatabasePath,
    tamperDetection: {
      ok: true,
      sequence: tamperedVerification.failure.sequence,
      reason: tamperedVerification.failure.reason
    }
  };
}

function runGoldenPath(databasePath: string): SqliteEvaluationRun {
  const store = new SqliteWorkItemStore(databasePath);
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);

  try {
    const created = tools.create_work_item({
      title: "Dry control-plane lifecycle",
      requester: "agent",
      intent: "Evaluate exact approval, claim-time policy, and lease-bound result state",
      target: { cwd: "/evaluation" },
      requestedActions: [
        {
          kind: "fs.write",
          description: "Represent a gated write without executing it",
          params: { paths: ["evaluation.txt"], write: true }
        }
      ],
      risk: "low"
    });
    if (created.status !== "needs_approval") {
      throw new Error(`SQLite evaluation create ended in ${created.status}`);
    }

    const approvalEvaluation = policy.evaluateWorkItem(created, "human-operator", "approve")[0];
    if (!approvalEvaluation || approvalEvaluation.decision.decision !== "require_approval") {
      throw new Error("SQLite evaluation did not produce an exact approval requirement");
    }
    const approval = tools.approve_work_item({
      id: created.id,
      approvedBy: "human-operator",
      reason: "Approve the exact evaluation-only write manifest",
      actionHash: approvalEvaluation.actionHash
    });
    if (approval.workItem.status !== "approved" || approval.approvals.length !== 1) {
      throw new Error(`SQLite evaluation approval ended in ${approval.workItem.status}`);
    }

    const claimed = tools.claim_next_approved_work_item({ workerId: "eval-worker" });
    if (!claimed || claimed.id !== created.id) {
      throw new Error("SQLite evaluation failed to claim the approved work item");
    }

    tools.submit_work_result({
      id: claimed.id,
      workerId: claimed.workerId,
      leaseToken: claimed.leaseToken,
      status: "succeeded",
      result: { evaluation: "control-plane-only" }
    });

    const events = store.readEvents({ limit: 500 });
    const chainVerification = store.verifyAuditChain();
    if (!chainVerification.ok) {
      throw new Error(
        `SQLite evaluation audit chain failed: ${chainVerification.failure.reason} at ${chainVerification.failure.sequence}`
      );
    }

    const eventNames = events.map((event) => event.name);
    if (stableHash(eventNames) !== stableHash(expectedEventNames)) {
      throw new Error(`SQLite evaluation event sequence mismatch: ${eventNames.join(",")}`);
    }

    const projected = replay(events).workItems;
    const finalProjection = projected[0];
    const persisted = store.get(created.id);
    if (!finalProjection || projected.length !== 1 || !persisted || stableHash(finalProjection) !== stableHash(persisted)) {
      throw new Error(`SQLite evaluation replay divergence for ${created.id}`);
    }

    return {
      databasePath,
      chainVerification,
      finalProjection,
      eventNames,
      semanticDigest: stableHash(normalizeSemantics(events, finalProjection))
    };
  } finally {
    store.close();
  }
}

function normalizeSemantics(events: StoredAuditEvent[], finalProjection: WorkItem): unknown {
  return {
    events: events.map((event) => ({
      sequence: event.sequence,
      id: "<event-id>",
      name: event.name,
      timeUnixNano: "<time>",
      attributes: normalizeValue(event.attributes, finalProjection.id),
      body: normalizeValue(event.body, finalProjection.id),
      previousHash: "<hash>",
      eventHash: "<hash>"
    })),
    finalProjection: normalizeValue(finalProjection, finalProjection.id)
  };
}

function normalizeValue(value: unknown, workItemId: string, key?: string): unknown {
  if (
    key === "createdAt" ||
    key === "updatedAt" ||
    key === "leaseExpiresAt" ||
    key === "expiresAt" ||
    key === "consumedAt"
  ) {
    return "<time>";
  }
  if (key === "requestHash" || key === "approval.request_hash") {
    return "<request-hash>";
  }
  if (value === workItemId) {
    return "<work-item-id>";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, workItemId));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        normalizeValue(entry, workItemId, entryKey)
      ])
    );
  }
  return value;
}

function tamperAuditBody(databasePath: string, sequence: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(`SELECT body FROM audit_events WHERE sequence = ?`).get(sequence) as
      | { body: string }
      | undefined;
    if (!row) {
      throw new Error(`SQLite evaluation audit row is missing at sequence ${sequence}`);
    }
    const body = JSON.parse(row.body) as Record<string, unknown>;
    body.tampered = true;
    database.prepare(`UPDATE audit_events SET body = ? WHERE sequence = ?`).run(JSON.stringify(body), sequence);
  } finally {
    database.close();
  }
}
