import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "./index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-validation-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({ title: "validation fixture", requester: "user", requesterSubject: "actor-user", intent: "validate", target: { cwd: "/repo" }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }], risk: "low" });
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
  const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: "b".repeat(64) }, { via: "domain_service" });
  return { directory, store, workItem, attempt };
}

describe("validation persistence", () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  it("persists validation checks idempotently", () => {
    const f = fixture(); directory = f.directory;
    const input = { attemptId: f.attempt.attemptId, workItemId: f.workItem.id, passed: false, idempotencyKey: "validation-work-1", checks: [{ name: "forbidden_paths", passed: false, detail: "secret changed", stderr: "redacted" }] };
    const first = f.store.recordValidationRun(input, { via: "domain_service" });
    expect(f.store.recordValidationRun(input, { via: "domain_service" })).toEqual(first);
    expect(f.store.getValidationRunForAttempt(f.attempt.attemptId)).toEqual(first);
    expect(first.checks[0]).toMatchObject({ name: "forbidden_paths", passed: false, detail: "secret changed" });
    expect(f.store.readEvents().filter((event) => event.name === "validation.run.recorded")).toHaveLength(1);
  });
});
