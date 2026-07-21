import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { createWorkItemSchema, type ActionRequest, type CreateWorkItemInput } from "@agent-control-stack/work-items";
import {
  applyRiskPolicy,
  normalizeFailureCode,
  route,
  validateEnvelope,
  type RiskPolicyResult,
  type RouteDecision,
  type TaskEnvelope
} from "agentos-contracts";

export interface ContractAdmission {
  envelope: TaskEnvelope;
  policy: RiskPolicyResult;
  route: RouteDecision;
}

const localRiskFloor: Record<CreateWorkItemInput["risk"], TaskEnvelope["risk_level"]> = {
  low: "read_only",
  medium: "draft",
  high: "write",
  critical: "write"
};

export function evaluateContractAdmission(input: unknown): ContractAdmission {
  const parsed = createWorkItemSchema.parse(input);
  const envelope = workItemInputToEnvelope(parsed);
  const validation = validateEnvelope(envelope);
  if (!validation.ok || !validation.envelope) {
    throw contractError("policy_blocked", "contract envelope invalid", validation.reasons);
  }

  const policy = applyRiskPolicy(validation.envelope);
  const decision = route(validation.envelope);
  if (!decision.ok) {
    throw contractError(decision.failure_code, "contract route rejected", decision.reasons);
  }
  if (decision.rollback_required && !hasRollbackCheckpoint(parsed.requestedActions)) {
    throw contractError("policy_blocked", "contract envelope invalid", ["destructive tasks require rollback checkpoint metadata"]);
  }

  return { envelope: validation.envelope, policy, route: decision };
}

function workItemInputToEnvelope(input: CreateWorkItemInput): TaskEnvelope {
  const allowedTools = input.requestedActions.map(actionToContractTool);
  const rollbackRequired = hasRollbackCheckpoint(input.requestedActions);
  const networkAccess = input.requestedActions.some((action) => action.params.allowNetwork === true) ? "declared" : "none";
  const workspace = input.target.cwd ?? input.target.repo ?? "";
  return {
    schema_version: "1.0",
    task_id: contractTaskId(input),
    goal: input.intent,
    origin: requesterToOrigin(input.requester),
    task_type: inferTaskType(input.requestedActions, workspace.length > 0),
    allowed_tools: allowedTools,
    workspace,
    risk_level: localRiskFloor[input.risk],
    approval_required: true,
    success_criteria: [input.intent],
    timeout_seconds: maxTimeoutSeconds(input.requestedActions),
    trace_required: true,
    rollback_required: rollbackRequired,
    network_access: networkAccess,
    human_notes: input.title
  };
}

function requesterToOrigin(requester: CreateWorkItemInput["requester"]): TaskEnvelope["origin"] {
  if (requester === "user") {
    return "dashboard";
  }
  if (requester === "agent") {
    return "hermes";
  }
  return "api";
}

function inferTaskType(actions: ActionRequest[], hasWorkspace: boolean): TaskEnvelope["task_type"] {
  if (actions.length === 0 || actions.some((action) => isUnknownActionKind(action.kind))) {
    return "unknown";
  }
  if (actions.some((action) => action.kind === "service.restart" || action.kind === "shell" || action.kind === "cmd.run")) {
    return "system_admin";
  }
  if (actions.some((action) => action.params.network === true || action.kind.startsWith("browser") || action.kind.includes("scrape"))) {
    return "browser_scrape";
  }
  if (actions.some((action) => action.kind.startsWith("fs.") || action.kind === "cmd.preview")) {
    return hasWorkspace ? "coding" : "unknown";
  }
  return "unknown";
}

function actionToContractTool(action: ActionRequest): string {
  switch (action.kind) {
    case "fs.read":
      return "read_file";
    case "fs.list":
      return "list_files";
    case "fs.stat":
      return "stat_file";
    case "fs.search_name":
      return "search_files";
    case "fs.write":
      return "write_file";
    case "fs.patch":
      return "apply_patch";
    case "fs.move":
      return "move_file";
    case "fs.delete":
      return "delete_file";
    case "cmd.preview":
      return "diff_read";
    case "cmd.run":
    case "shell":
      return "run_command";
    case "service.restart":
      return "systemctl";
    default:
      return action.kind;
  }
}

function isUnknownActionKind(kind: string): boolean {
  return !new Set([
    "system.status",
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.search_name",
    "fs.write",
    "fs.patch",
    "fs.move",
    "fs.delete",
    "agent.prompt",
    "cmd.preview",
    "cmd.run",
    "service.restart",
    "shell"
  ]).has(kind);
}

function hasRollbackCheckpoint(actions: ActionRequest[]): boolean {
  return actions.some((action) => {
    const checkpoint = action.params.rollbackCheckpoint;
    return typeof checkpoint === "string"
      ? checkpoint.length > 0
      : checkpoint !== null && typeof checkpoint === "object" && Object.keys(checkpoint).length > 0;
  });
}

function maxTimeoutSeconds(actions: ActionRequest[]): number {
  const values = actions
    .map((action) => action.params.timeoutMs)
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
  const timeoutMs = values.length ? Math.max(...values) : 900_000;
  return Math.max(1, Math.min(86_400, Math.ceil(timeoutMs / 1000)));
}

function contractTaskId(input: CreateWorkItemInput): string {
  return `task-${stableHash({ title: input.title, intent: input.intent, target: input.target, actions: input.requestedActions }).slice(0, 40)}`;
}

function contractError(code: unknown, message: string, reasons: string[]): ControlStackError {
  return new ControlStackError(normalizeFailureCode(code), `${message}: ${reasons.join("; ")}`);
}
