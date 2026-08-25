import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "./index.js";

describe("publication record persistence", () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  it("enforces one idempotent publication per work item", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-publication-record-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    const workItem = store.create({ title: "publish", requester: "user", requesterSubject: "actor-user", intent: "publish", target: { cwd: "/repo" }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }], risk: "low" });
    const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
    const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) }, { via: "domain_service" });
    const input = { workItemId: workItem.id, attemptId: attempt.attemptId, branch: "acs/attempt/1", commitSha: "abcdef1", pullRequestUrl: "https://github.com/acme/repo/pull/1", idempotencyKey: `publication:${workItem.id}` };
    const first = store.recordPublication(input, { via: "domain_service" });
    expect(store.recordPublication(input, { via: "domain_service" })).toEqual(first);
    expect(store.listPublications(workItem.id)).toEqual([first]);
    store.close();
  });
});
