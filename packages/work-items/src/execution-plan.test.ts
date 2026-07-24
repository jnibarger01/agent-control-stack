import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem,
  executionAttemptInputHash,
  executionPlanHash,
  executionPlanSubjectInputHash
} from "./index.js";

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-execution-plan-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Immutable plan fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove immutable deterministic execution plans",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [
      {
        kind: "fs.read",
        description: "inspect the source",
        params: { paths: ["src/index.ts"], write: false }
      }
    ],
    risk: "low"
  });
  return { directory, dbPath, store, workItem };
}

describe("immutable execution plans", () => {
  it("derives deterministic hashes and safe dry-run constraints", () => {
    const { directory, store, workItem } = createFixture();
    try {
      const first = defaultExecutionPlanForWorkItem(workItem);
      const second = defaultExecutionPlanForWorkItem(workItem);

      expect(first).toMatchObject({
        schemaVersion: "acs.execution-plan.v1",
        workItemId: workItem.id,
        constraints: {
          executionMode: "dry_run",
          network: "none",
          localGitOnly: true,
          allowPush: false,
          allowDeployment: false,
          allowedCommands: []
        }
      });
      expect(executionPlanHash(first)).toBe(executionPlanHash(second));
      expect(first.subjectInputHash).toBe(executionPlanSubjectInputHash(workItem));
      expect(
        executionAttemptInputHash({
          workItemId: workItem.id,
          planHash: executionPlanHash(first),
          subjectInputHash: first.subjectInputHash
        })
      ).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates, versions, and reads immutable plan records atomically", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const initialDefinition = defaultExecutionPlanForWorkItem(workItem);
      const initial = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: initialDefinition,
        createdByActorId: "actor-user"
      });
      const replay = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: initialDefinition,
        createdByActorId: "actor-user"
      });

      expect(replay).toEqual(initial);
      expect(store.listExecutionPlans(workItem.id)).toEqual([initial]);
      expect(store.getCurrentExecutionPlan(workItem.id)).toEqual(initial);

      const changedDefinition = { ...initialDefinition, objective: `${initialDefinition.objective} safely` };
      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition: changedDefinition,
          createdByActorId: "actor-user"
        })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_conflict" }));

      const changed = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: changedDefinition,
        createdByActorId: "actor-user",
        expectedCurrentPlanHash: initial.planHash
      });
      expect(changed).toMatchObject({ planNumber: 2, workItemId: workItem.id });
      expect(changed.planHash).not.toBe(initial.planHash);
      expect(store.listExecutionPlans(workItem.id)).toEqual([initial, changed]);
      expect(store.getCurrentExecutionPlan(workItem.id)).toEqual(changed);

      const check = new DatabaseSync(dbPath);
      try {
        expect(() =>
          check.prepare(`UPDATE execution_plans SET definition_json = '{}' WHERE plan_id = ?`).run(initial.planId)
        ).toThrow("execution_plans: immutable");
        expect(() => check.prepare(`DELETE FROM execution_plans WHERE plan_id = ?`).run(initial.planId)).toThrow(
          "execution_plans: append-only"
        );
      } finally {
        check.close();
      }

      expect(store.readEvents().filter((event) => event.name === "execution_plan.created")).toHaveLength(2);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects definitions that are not bound to the current work-item inputs", () => {
    const { directory, store, workItem } = createFixture();
    try {
      const definition = {
        ...defaultExecutionPlanForWorkItem(workItem),
        subjectInputHash: "0".repeat(64)
      };
      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition,
          createdByActorId: "actor-user"
        })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_input_mismatch" }));
      expect(store.getCurrentExecutionPlan(workItem.id)).toBeUndefined();
      expect(store.readEvents().some((event) => event.name === "execution_plan.created")).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("admits only the current plan through the policy-gate authority", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });
      const input = {
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        admittedByActorId: "policy-gate"
      };

      expect(() => store.admitExecutionPlan(input, { via: "domain_service" })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" })
      );
      const admission = store.admitExecutionPlan(input, { via: "policy_gate" });
      expect(store.admitExecutionPlan(input, { via: "policy_gate" })).toEqual(admission);
      expect(store.getExecutionPlanAdmission(admission.admissionId)).toEqual(admission);

      const check = new DatabaseSync(dbPath);
      try {
        expect(() =>
          check
            .prepare(`UPDATE execution_plan_admissions SET policy_version = 'other' WHERE admission_id = ?`)
            .run(admission.admissionId)
        ).toThrow("execution_plan_admissions: immutable");
      } finally {
        check.close();
      }

      expect(store.readEvents().filter((event) => event.name === "execution_plan.admitted")).toHaveLength(1);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the plan, head, and event together when audit persistence fails", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const check = new DatabaseSync(dbPath);
      try {
        check.exec(`
          CREATE TRIGGER reject_execution_plan_audit
          BEFORE INSERT ON audit_events
          WHEN NEW.name = 'execution_plan.created'
          BEGIN
            SELECT RAISE(ABORT, 'test audit failure');
          END;
        `);
      } finally {
        check.close();
      }

      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition: defaultExecutionPlanForWorkItem(workItem),
          createdByActorId: "actor-user"
        })
      ).toThrow("test audit failure");
      expect(store.getCurrentExecutionPlan(workItem.id)).toBeUndefined();
      expect(store.listExecutionPlans(workItem.id)).toEqual([]);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
