import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCaller, ModelRequest } from "@agent-control-stack/moa-orchestrator";
import { sha256, stableStringify } from "@agent-control-stack/moa-orchestrator";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../server.js";
import { createMoaAcsClient, verifyExecutableGrant } from "./acs-client.js";

const actor = "operator";
const auth = { token: "token", actor } as const;
const proposedAction = {
  category: "filesystem_write" as const,
  summary: "Apply approved patch",
  requires_mutation: true
};
const expectedActionHash = sha256(stableStringify(proposedAction));

const advisorJson = JSON.stringify({
  verdict: "risky",
  key_risks: [],
  recommended_next_steps: [],
  do_not_do: [],
  confidence: 0.8
});

function aggCreate(): string {
  return JSON.stringify({
    decision: "create_work_item",
    advisor_synthesis: { consensus: "Patch needed.", disagreements: [], ignored_advice: [] },
    risk: "high",
    proposed_action: { category: "gateway_auth", summary: "Patch gateway auth", requires_mutation: true },
    acs_work_item: null,
    user_response: "Routing through ACS."
  });
}

function aggExecute(workItemId: string): string {
  return JSON.stringify({
    decision: "execute_approved_work",
    advisor_synthesis: { consensus: "Ready.", disagreements: [], ignored_advice: [] },
    risk: "medium",
    proposed_action: proposedAction,
    acs_work_item: { work_item_id: workItemId },
    user_response: "Execute approved item."
  });
}

class FakeCaller implements ModelCaller {
  constructor(private readonly aggregatorReply: string) {}
  async complete(request: ModelRequest): Promise<string> {
    return request.system.startsWith("You are the aggregator") ? this.aggregatorReply : advisorJson;
  }
}

describe("MoA ACS adapter", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempStore() {
    const dir = mkdtempSync(join(tmpdir(), "acs-moa-"));
    dirs.push(dir);
    return new SqliteWorkItemStore(join(dir, "control.db"));
  }

  async function createApprovedMoaWork(store: SqliteWorkItemStore): Promise<WorkItem> {
    const client = createMoaAcsClient(store);
    await client.createWorkItem({
      task_id: "task_abc",
      session_id: "session-a",
      actor,
      title: "Approved MoA work",
      category: "filesystem_write",
      summary: "Apply approved patch",
      risk: "high",
      requires_approval: true,
      expected_action_hash: expectedActionHash,
      source: "moa_aggregator"
    });
    const workItem = store.list({ status: "needs_approval" })[0]!;
    const actionHash = createPolicyEngine().evaluateWorkItem(workItem, actor, "approve")[0]!.actionHash;
    createWorkItemTools(store, createPolicyEngine()).approve_work_item({
      id: workItem.id,
      approvedBy: actor,
      reason: "approve exact MoA action",
      actionHash
    });
    return store.get(workItem.id)!;
  }

  function grantInput(workItemId: string) {
    return {
      work_item_id: workItemId,
      actor,
      task_id: "task_abc",
      session_id: "session-a",
      source: "moa_aggregator" as const,
      expected_category: "filesystem_write" as const,
      expected_action_hash: expectedActionHash
    };
  }

  it("rejects approved work with wrong task, actor/session, action hash/category, or leaseability", async () => {
    const store = tempStore();
    try {
      const workItem = await createApprovedMoaWork(store);
      expect(() => verifyExecutableGrant(store, { ...grantInput(workItem.id), task_id: "task_wrong" })).toThrow(
        "binding mismatch"
      );
      expect(() => verifyExecutableGrant(store, { ...grantInput(workItem.id), actor: "other" })).toThrow(
        "actor binding mismatch"
      );
      expect(() => verifyExecutableGrant(store, { ...grantInput(workItem.id), session_id: "session-b" })).toThrow(
        "binding mismatch"
      );
      expect(() => verifyExecutableGrant(store, { ...grantInput(workItem.id), expected_action_hash: "wrong" })).toThrow(
        "hash binding mismatch"
      );
      expect(() =>
        verifyExecutableGrant(store, { ...grantInput(workItem.id), expected_category: "read_only" })
      ).toThrow("binding mismatch");
      store.cancelWorkItem(
        workItem.id,
        { actor: "operator", reason: "make grant non-executable" },
        { via: "domain_service" }
      );
      expect(() => verifyExecutableGrant(store, grantInput(workItem.id))).toThrow("not approved");
    } finally {
      store.close();
    }
  });

  it("fails execution requests without a valid approval grant", async () => {
    const store = tempStore();
    try {
      const client = createMoaAcsClient(store);
      await client.createWorkItem({
        task_id: "task_abc",
        session_id: "session-a",
        actor,
        title: "Ungrafted work",
        category: "filesystem_write",
        summary: "Apply patch",
        risk: "high",
        requires_approval: true,
        expected_action_hash: expectedActionHash,
        source: "moa_aggregator"
      });
      const workItem = store.list({ status: "needs_approval" })[0]!;
      store.approveWorkItem(workItem.id, { via: "policy_gate" });
      const result = await client.requestExecution({
        work_item_id: workItem.id,
        actor,
        grant_id: "missing",
        lease_token: "missing",
        expected_action_hash: expectedActionHash
      });
      expect(result.dispatched).toBe(false);
      expect(result.reason).toContain("grant");
    } finally {
      store.close();
    }
  });

  it("replays identical /agent/run requests without generated task_id creating duplicate work items", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-moa-gw-"));
    dirs.push(dir);
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      moa: { caller: new FakeCaller(aggCreate()), auditLogPath: join(dir, "moa-audit.jsonl") }
    });
    const payload = {
      mode: "moa",
      preset: "cheap",
      task: { goal: "Review gateway auth", risk: "high", kind: "code_review", files: ["apps/gateway/src/mcp.ts"] }
    };
    const first = await app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: `Bearer ${auth.token}` },
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: `Bearer ${auth.token}` },
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    try {
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
      await app.close();
    }
  });

  it("audits blocked random approved-ID execution without dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-moa-gw-"));
    dirs.push(dir);
    const auditLogPath = join(dir, "moa-audit.jsonl");
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      moa: { caller: new FakeCaller(aggExecute("wrk_random_approved")), auditLogPath }
    });
    const response = await app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: `Bearer ${auth.token}` },
      payload: {
        mode: "moa",
        preset: "cheap",
        task: { goal: "Execute random work", risk: "high", kind: "code_review", files: ["apps/gateway/src/mcp.ts"] }
      }
    });
    expect(response.statusCode).toBe(409);
    const audit = readFileSync(auditLogPath, "utf8");
    expect(audit).toContain("moa.moa_execution_blocked");
    expect(audit).not.toContain("work item not found");
    await app.close();
  });
});
