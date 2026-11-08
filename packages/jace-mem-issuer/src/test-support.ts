/**
 * Test-only helpers: drive a Jace-Mem tool call through the real ACS work-item
 * store and policy engine (create -> approve -> claim -> lease) the way the
 * future /jm/capability/issue route will. Synthetic identities only.
 */
import {
  createPolicyEngine,
  createWorkItemTools,
  gateApproval,
  evaluateWorkItemPolicy,
  summarizePolicy,
  type PolicyEngine
} from "@agent-control-stack/policy-gate";
import { createWorkItemSchema, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import {
  jaceMemActionParams,
  validateJaceMemInvocation,
  type JaceMemInvocation,
  type JaceMemSubject
} from "./issuer.js";

export const WORKER = "acs-jm-bridge";
export const HUMAN = "operator-human";
export const RUNTIME = "jm-test-runtime";
export const SUBJECT: JaceMemSubject = Object.freeze({
  principal: "synthetic-principal",
  agent: "agent-a",
  project: "synthetic-project",
  worktree: "/srv/synthetic/worktree",
  invocation: "inv-0001"
});

/** Valid arguments for every tool (synthetic values). */
export const TOOL_ARGS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  session_start: {},
  session_end: { session: "sess-1" },
  session_delete: { session: "sess-1" },
  memory_capture: { session: "sess-1", text: "synthetic fact", kind: "FACT", status: "CLAIMED", source: "fixture" },
  memory_search: { query: "synthetic", limit: 10 },
  memory_get: { id: "obs-1" },
  memory_delete: { id: "obs-1" },
  memory_retain_since: { cutoff: "2026-01-01T00:00:00.000Z" },
  memory_status: {},
  memory_search_shared: { targetAgent: "agent-b", query: "synthetic" }
});

export function workItemInput(
  invocation: JaceMemInvocation,
  subject: JaceMemSubject,
  requesterSubject = subject.agent
) {
  return createWorkItemSchema.parse({
    title: `Jace-Mem ${invocation.toolName}`,
    intent: `Jace-Mem tool ${invocation.toolName} for ${requesterSubject}`,
    requester: "agent",
    requesterSubject,
    target: {},
    requestedActions: [
      {
        kind: invocation.policy.actionKind,
        description: `Jace-Mem tool ${invocation.toolName}`,
        params: jaceMemActionParams(invocation, subject, RUNTIME)
      }
    ],
    risk: invocation.policy.risk
  });
}

export interface Claimed {
  store: SqliteWorkItemStore;
  invocation: JaceMemInvocation;
  item: ReturnType<ReturnType<typeof createWorkItemTools>["create_work_item"]>;
  claimed: NonNullable<ReturnType<ReturnType<typeof createWorkItemTools>["claim_approved_work_item_by_id"]>>;
}

/**
 * Creates and claims a work item for `tool`. Approval-gated tools are approved by
 * `approver` through the real gate, or through a permissive gate when `forge` is
 * set (simulating a policy regression the registry must still catch).
 */
export function claimFor(
  dbPath: string,
  tool: string,
  options: {
    approver?: string;
    forge?: boolean;
    subject?: JaceMemSubject;
    requesterSubject?: string;
    args?: Record<string, unknown>;
  } = {}
): Claimed {
  const store = new SqliteWorkItemStore(dbPath);
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);
  const invocation = validateJaceMemInvocation(tool, options.args ?? TOOL_ARGS[tool]);
  const subject = options.subject ?? SUBJECT;
  const item = tools.create_work_item(workItemInput(invocation, subject, options.requesterSubject ?? subject.agent));
  if (invocation.policy.requiresApproval) {
    const approver = options.approver ?? HUMAN;
    // An admin-mode approval is only claimable while canonical admin mode is on.
    if (approver === "acs:admin")
      store.setExecutionMode({ mode: "admin", updatedBy: "test-operator", reason: "exercise admin approval" });
    const actionHash = evaluateWorkItemPolicy(item, HUMAN, "create")[0]!.actionHash;
    if (options.forge) {
      const permissive: PolicyEngine = {
        evaluateWorkItem: (workItem, actor) => evaluateWorkItemPolicy(workItem, actor, "create"),
        summarize: summarizePolicy
      };
      gateApproval(store, permissive, { id: item.id, actionHash, approvedBy: approver, reason: "forged for test" });
    } else {
      tools.approve_work_item({ id: item.id, actionHash, approvedBy: approver, reason: "test approval" });
    }
  }
  const claimed = tools.claim_approved_work_item_by_id({ id: item.id, workerId: WORKER, leaseMs: 60_000 });
  if (!claimed?.attemptId) {
    store.close();
    throw new Error(`could not claim ${tool}`);
  }
  return { store, invocation, item, claimed };
}
