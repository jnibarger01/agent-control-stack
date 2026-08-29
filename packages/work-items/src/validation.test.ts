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

  it("never persists secret-like validation command output unredacted, in the durable table or the audit event", () => {
    const f = fixture();
    directory = f.directory;
    const secrets = [
      "Bearer sk-testFAKEsecretvaluethatlookslikeanapikey1234567890",
      "ghp_FAKEtestGithubPersonalAccessToken1234567890abcd",
      "AWS_SECRET_ACCESS_KEY=FAKEexampleSecretValueForTestingOnly1234567890"
    ];
    const input = {
      attemptId: f.attempt.attemptId,
      workItemId: f.workItem.id,
      passed: true,
      idempotencyKey: "validation-secret-redaction",
      checks: [
        {
          name: "command:npm",
          passed: true,
          detail: "exit code 0",
          stdout: `build output\n${secrets[0]}\nmore output`,
          stderr: `warning\n${secrets[1]}\n${secrets[2]}`
        }
      ]
    };

    const recorded = f.store.recordValidationRun(input, { via: "domain_service" });
    for (const secret of secrets) {
      expect(recorded.checks[0]?.stdout).not.toContain(secret);
      expect(recorded.checks[0]?.stderr).not.toContain(secret);
    }

    // The durable table itself - not just the returned/re-hydrated object -
    // must never contain the raw secret text.
    const dbAny = f.store as unknown as {
      db: { prepare: (sql: string) => { all: (...a: unknown[]) => Array<{ stdout: string | null; stderr: string | null }> } };
    };
    const rows = dbAny.db.prepare(`SELECT stdout, stderr FROM validation_checks`).all();
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      for (const secret of secrets) {
        expect(row.stdout ?? "").not.toContain(secret);
        expect(row.stderr ?? "").not.toContain(secret);
      }
    }

    // Nor the audit event body.
    const event = f.store.readEvents().find((entry) => entry.name === "validation.run.recorded");
    const eventText = JSON.stringify(event?.body ?? {});
    for (const secret of secrets) {
      expect(eventText).not.toContain(secret);
    }
  });

  it("bounds persisted validation command output instead of storing it unbounded", () => {
    const f = fixture();
    directory = f.directory;
    const hugeOutput = "x".repeat(100_000);
    const input = {
      attemptId: f.attempt.attemptId,
      workItemId: f.workItem.id,
      passed: true,
      idempotencyKey: "validation-bounded-output",
      checks: [{ name: "command:build", passed: true, detail: "exit code 0", stdout: hugeOutput }]
    };

    const recorded = f.store.recordValidationRun(input, { via: "domain_service" });
    expect(recorded.checks[0]?.stdout?.length ?? 0).toBeLessThan(hugeOutput.length);
  });
});
