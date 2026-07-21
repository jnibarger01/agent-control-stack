import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createConnectorTools } from "./connector.js";

describe("gateway connector adapter", () => {
  it("turns a registered command request into a governed, worker-bound work item", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-command-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    store.registerActor({ id: "agent-1", actorType: "AGENT", displayName: "Agent 1" });
    const tools = createConnectorTools({ store, policy: createPolicyEngine(), workItemTools: createWorkItemTools(store, createPolicyEngine()), cwd: "/repo" });

    try {
      const result = tools["command.preview"]({ actor: "agent-1", commandId: "os.metadata" });

      expect(result).toMatchObject({
        workItem: {
          status: "approved",
          requestedActions: [
            {
              kind: "cmd.preview",
              params: expect.objectContaining({
                commandId: "os.metadata",
                registryActionId: "acs.command.preview",
                registryVersion: "1.0"
              })
            }
          ]
        }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown command and non-relative filesystem targets before creating work", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-input-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createConnectorTools({ store, policy, workItemTools: createWorkItemTools(store, policy), cwd: "/repo" });

    try {
      expect(() => tools["command.preview"]({ actor: "agent", commandId: "shell" })).toThrow(ControlStackError);
      expect(() => tools["filesystem.read_text"]({ actor: "agent", rootId: "acs-repo", relativePath: "/etc/hosts" })).toThrow(
        ControlStackError
      );
      expect(store.list()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates service and config mutations and requires a human approval actor", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-mutation-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    store.registerActor({ id: "agent-1", actorType: "AGENT", displayName: "Agent 1" });
    store.registerActor({ id: "human-1", actorType: "HUMAN", displayName: "Human 1" });
    const policy = createPolicyEngine();
    const tools = createConnectorTools({ store, policy, workItemTools: createWorkItemTools(store, policy), cwd: "/repo" });

    try {
      const restart = tools["service.restart"]({ actor: "agent-1", serviceId: "acs-connector-test", reason: "acceptance" }) as {
        workItem: { id: string; status: string };
        approvalHashes: string[];
      };
      const config = tools["config.change"]({
        actor: "agent-1",
        targetId: "acs-connector-settings",
        patch: [{ op: "replace", path: "/max_evidence_bytes", value: 1000 }],
        reason: "acceptance"
      });

      expect(restart).toMatchObject({ workItem: { status: "needs_approval" } });
      expect(config).toMatchObject({ workItem: { status: "needs_approval" } });
      expect(() => tools["work_item.approve"]({ actor: "agent-1", id: restart.workItem.id, actionHash: restart.approvalHashes[0] })).toThrow(
        "human approval"
      );

      const approved = tools["work_item.approve"]({
        actor: "human-1",
        id: restart.workItem.id,
        actionHash: restart.approvalHashes[0],
        reason: "approved acceptance fixture"
      });
      expect(approved).toMatchObject({ workItem: { status: "approved" } });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restricts work-item retrieval to the requesting actor or a human", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-access-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    store.registerActor({ id: "agent-1", actorType: "AGENT", displayName: "Agent 1" });
    store.registerActor({ id: "agent-2", actorType: "AGENT", displayName: "Agent 2" });
    store.registerActor({ id: "human-1", actorType: "HUMAN", displayName: "Human 1" });
    const policy = createPolicyEngine();
    const tools = createConnectorTools({ store, policy, workItemTools: createWorkItemTools(store, policy), cwd: "/repo" });

    try {
      const created = tools["command.run"]({ actor: "agent-1", commandId: "os.metadata" }) as { workItem: { id: string } };
      expect(() => tools["result.get"]({ actor: "agent-2", id: created.workItem.id })).toThrow("work-item access");
      expect(tools["result.get"]({ actor: "agent-1", id: created.workItem.id })).toMatchObject({ workItem: { id: created.workItem.id } });
      expect(tools["result.get"]({ actor: "human-1", id: created.workItem.id })).toMatchObject({ workItem: { id: created.workItem.id } });

      const claimed = store.claimNextApprovedWorkItem("worker-test");
      expect(claimed?.id).toBe(created.workItem.id);
      if (!claimed) throw new Error("expected the test work item to be claimed");
      store.submitWorkResult({
        id: created.workItem.id,
        workerId: "worker-test",
        leaseToken: claimed.leaseToken,
        status: "succeeded",
        result: { execution_mode: "dry_run" }
      });
      expect(tools["result.get"]({ actor: "human-1", id: created.workItem.id })).toMatchObject({
        lease: { workerId: "worker-test", status: "succeeded", released: true }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
