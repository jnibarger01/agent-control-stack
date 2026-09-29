import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "./index.js";

describe("publication record persistence", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("enforces one idempotent publication per work item", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-publication-record-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    const workItem = store.create({
      title: "publish",
      requester: "user",
      requesterSubject: "actor-user",
      intent: "publish",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "actor-user"
    });
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );
    const input = {
      workItemId: workItem.id,
      attemptId: attempt.attemptId,
      branch: "acs/attempt/1",
      commitSha: "abcdef1",
      pullRequestUrl: "https://github.com/acme/repo/pull/1",
      idempotencyKey: `publication:${workItem.id}`
    };
    const first = store.recordPublication(input, { via: "domain_service" });
    expect(store.recordPublication(input, { via: "domain_service" })).toEqual(first);
    expect(store.listPublications(workItem.id)).toEqual([first]);

    const db = new DatabaseSync(join(directory, "control.db"), { readOnly: true });
    try {
      const promotionRows = db
        .prepare(
          `SELECT canonical_json FROM trace_outbox
           WHERE work_item_id = ? AND json_extract(canonical_json, '$.kind') LIKE 'promotion.%'
           ORDER BY seq`
        )
        .all(workItem.id) as Array<{ canonical_json: string }>;
      expect(promotionRows).toHaveLength(1);
      expect(JSON.parse(promotionRows[0]!.canonical_json)).toMatchObject({
        kind: "promotion.completed",
        actor: { id: "acs", type: "system" },
        payload: {
          attempt_id: attempt.attemptId,
          publication_id: first.publicationId,
          commit_sha: "abcdef1",
          transport: "pull_request"
        }
      });
    } finally {
      db.close();
    }
    store.close();
  });

  it("keeps the durable publication record when promotion.completed trace persistence fails", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-publication-complete-trace-fail-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "publish",
      requester: "user",
      intent: "publish",
      requestedActions: [{ kind: "fs.read", description: "inspect" }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "actor-user"
    });
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );

    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec(`CREATE TRIGGER promotion_complete_trace_boom BEFORE INSERT ON trace_outbox
                BEGIN SELECT RAISE(ABORT, 'trace unavailable'); END`);
    } finally {
      raw.close();
    }

    const failuresBefore = store.getTraceEnqueueFailureCount();
    const record = store.recordPublication(
      {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        branch: "acs/attempt/1",
        commitSha: "abcdef1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        idempotencyKey: `publication:${workItem.id}`
      },
      { via: "domain_service" }
    );
    expect(store.getPublicationByIdempotency(`publication:${workItem.id}`)).toEqual(record);
    expect(store.readEvents({ workItemId: workItem.id }).at(-1)?.name).toBe("publication.recorded");
    expect(store.getTraceEnqueueFailureCount()).toBe(failuresBefore + 1);
    store.close();
  });

  it("records a bounded promotion.blocked audit + trace fact", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-publication-block-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "publish",
      requester: "user",
      requesterSubject: "actor-user",
      intent: "publish",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "actor-user"
    });
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );

    const blocked = store.recordPublicationBlocked(
      {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        stage: "plan_authorization",
        reasonCode: "push_not_authorized",
        externalState: "none"
      },
      { via: "domain_service" }
    );
    expect(blocked).toMatchObject({
      workItemId: workItem.id,
      attemptId: attempt.attemptId,
      stage: "plan_authorization",
      reasonCode: "push_not_authorized",
      externalState: "none"
    });
    expect(store.readEvents({ workItemId: workItem.id }).at(-1)?.name).toBe("publication.blocked");

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT canonical_json FROM trace_outbox
           WHERE work_item_id = ? AND json_extract(canonical_json, '$.kind') = 'promotion.blocked'`
        )
        .get(workItem.id) as { canonical_json: string };
      expect(JSON.parse(row.canonical_json)).toMatchObject({
        kind: "promotion.blocked",
        payload: {
          attempt_id: attempt.attemptId,
          stage: "plan_authorization",
          reason_code: "push_not_authorized",
          external_state: "none"
        }
      });
      expect(row.canonical_json).not.toContain("/repo");
    } finally {
      db.close();
      store.close();
    }
  });

  it("keeps the durable promotion block audit when trace persistence fails", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-publication-block-trace-fail-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "publish",
      requester: "user",
      intent: "publish",
      requestedActions: [{ kind: "fs.read", description: "inspect" }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "actor-user"
    });
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );

    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec(`CREATE TRIGGER promotion_trace_boom BEFORE INSERT ON trace_outbox
                BEGIN SELECT RAISE(ABORT, 'trace unavailable'); END`);
    } finally {
      raw.close();
    }

    const failuresBefore = store.getTraceEnqueueFailureCount();
    store.recordPublicationBlocked(
      {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        stage: "lease_entry",
        reasonCode: "lease_not_current",
        externalState: "none"
      },
      { via: "domain_service" }
    );
    expect(store.readEvents({ workItemId: workItem.id }).at(-1)?.name).toBe("publication.blocked");
    expect(store.getTraceEnqueueFailureCount()).toBe(failuresBefore + 1);

    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        (
          check
            .prepare(
              `SELECT count(*) AS n FROM trace_outbox
               WHERE work_item_id = ? AND json_extract(canonical_json, '$.kind') = 'promotion.blocked'`
            )
            .get(workItem.id) as { n: number }
        ).n
      ).toBe(0);
    } finally {
      check.close();
      store.close();
    }
  });
});
