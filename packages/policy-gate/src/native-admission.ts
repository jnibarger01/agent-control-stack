import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { createWorkItemSchema, type ActionRequest, type CreateWorkItemInput } from "@agent-control-stack/work-items";

export type NativeAdmissionRisk = "read_only" | "draft" | "write" | "destructive";
export type NativeAdmissionTaskType =
  | "coding"
  | "research"
  | "memory_lookup"
  | "browser_scrape"
  | "deal_analysis"
  | "system_admin"
  | "unknown";

export interface NativeAdmissionEnvelope {
  schemaVersion: "acs.native-admission.v1";
  taskId: string;
  goal: string;
  taskType: NativeAdmissionTaskType;
  allowedTools: string[];
  workspace: string;
  risk: NativeAdmissionRisk;
  approvalRequired: true;
  rollbackRequired: boolean;
  networkAccess: "none" | "declared";
}

export interface NativeAdmissionPolicy {
  effectiveRisk: NativeAdmissionRisk;
  approvalRequired: true;
  rollbackRequired: boolean;
  networkViolation: boolean;
  reasons: string[];
}

export interface NativeAdmissionRoute {
  target: "codex" | "claude" | "pi" | "opencode" | "approval-queue" | "human-triage";
  queuedForApproval: boolean;
}

export interface ContractAdmission {
  envelope: NativeAdmissionEnvelope;
  policy: NativeAdmissionPolicy;
  route: NativeAdmissionRoute;
}

const localRiskFloor: Record<CreateWorkItemInput["risk"], NativeAdmissionRisk> = {
  low: "read_only",
  medium: "draft",
  high: "write",
  critical: "write"
};

const riskRank: Record<NativeAdmissionRisk, number> = {
  read_only: 0,
  draft: 1,
  write: 2,
  destructive: 3
};

const routeTable: Record<NativeAdmissionTaskType, NativeAdmissionRoute["target"]> = {
  coding: "codex",
  research: "claude",
  memory_lookup: "pi",
  browser_scrape: "opencode",
  deal_analysis: "claude",
  system_admin: "approval-queue",
  unknown: "human-triage"
};

/**
 * Native replacement for the retired AgentOS envelope admission dependency.
 * Input first passes the canonical ACS work-item schema; policy then derives
 * a route without accepting caller-selected engine authority.
 */
export function evaluateContractAdmission(input: unknown): ContractAdmission {
  const parsed = createWorkItemSchema.parse(input);
  const envelope = workItemInputToNativeEnvelope(parsed);
  const policy = applyNativeAdmissionPolicy(envelope);
  if (policy.networkViolation) {
    throw new ControlStackError("network_blocked", `native admission blocked network access: ${policy.reasons.join("; ")}`);
  }
  if (policy.rollbackRequired && !hasRollbackCheckpoint(parsed.requestedActions)) {
    throw new ControlStackError("policy_blocked", "contract envelope invalid: destructive tasks require rollback checkpoint metadata");
  }
  return { envelope, policy, route: routeNativeAdmission(envelope.taskType, policy) };
}

function workItemInputToNativeEnvelope(input: CreateWorkItemInput): NativeAdmissionEnvelope {
  const workspace = input.target.cwd ?? input.target.repo ?? "";
  return {
    schemaVersion: "acs.native-admission.v1",
    taskId: `task-${stableHash({ title: input.title, intent: input.intent, target: input.target, actions: input.requestedActions }).slice(0, 40)}`,
    goal: input.intent,
    taskType: inferTaskType(input.requestedActions, workspace.length > 0),
    allowedTools: input.requestedActions.map(actionToTool),
    workspace,
    risk: localRiskFloor[input.risk],
    approvalRequired: true,
    rollbackRequired: hasRollbackCheckpoint(input.requestedActions),
    networkAccess: input.requestedActions.some((action) => action.params.allowNetwork === true) ? "declared" : "none"
  };
}

function inferTaskType(actions: ActionRequest[], hasWorkspace: boolean): NativeAdmissionTaskType {
  if (actions.length === 0 || actions.some((action) => isUnknownActionKind(action.kind))) return "unknown";
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

function actionToTool(action: ActionRequest): string {
  const tools: Partial<Record<ActionRequest["kind"], string>> = {
    "fs.read": "read_file",
    "fs.list": "list_files",
    "fs.stat": "stat_file",
    "fs.search_name": "search_files",
    "fs.write": "write_file",
    "fs.patch": "apply_patch",
    "fs.move": "move_file",
    "fs.delete": "delete_file",
    "cmd.preview": "diff_read",
    "cmd.run": "run_command",
    shell: "run_command",
    "service.restart": "systemctl"
  };
  return tools[action.kind] ?? action.kind;
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

function applyNativeAdmissionPolicy(envelope: NativeAdmissionEnvelope): NativeAdmissionPolicy {
  const reasons: string[] = [];
  let effectiveRisk = envelope.risk;
  const floor: NativeAdmissionRisk = envelope.taskType === "coding" ? "draft" : envelope.taskType === "system_admin" ? "write" : "read_only";
  if (riskRank[floor] > riskRank[effectiveRisk]) {
    effectiveRisk = floor;
    reasons.push(`risk floor: task_type=${envelope.taskType} raises risk to ${floor}`);
  }
  for (const tool of envelope.allowedTools) {
    const toolRisk = classifyToolRisk(tool);
    if (riskRank[toolRisk] > riskRank[effectiveRisk]) {
      effectiveRisk = toolRisk;
      reasons.push(`tool escalation: ${tool} -> ${toolRisk}`);
    }
  }
  const networkViolation =
    envelope.networkAccess === "none" && envelope.allowedTools.some((tool) => /^(fetch|http|browser|scrape|curl|download|web_|firecrawl|page_doctor)/.test(tool.toLowerCase()));
  if (networkViolation) reasons.push("network_blocked: tool requires declared network access");
  const rollbackRequired = effectiveRisk === "destructive" || envelope.rollbackRequired;
  if (effectiveRisk === "destructive" && !envelope.rollbackRequired) reasons.push("rollback required for destructive work");
  return { effectiveRisk, approvalRequired: true, rollbackRequired, networkViolation, reasons };
}

function classifyToolRisk(tool: string): NativeAdmissionRisk {
  const normalized = tool.toLowerCase();
  if (/^(rm|delete|drop|force_push|force-push|git_push_force|prune|wipe|format|shutdown|systemctl_stop)/.test(normalized)) return "destructive";
  if (/^(write|edit|create|move|rename|git_commit|git_push|git_merge|apply_patch|install|deploy|exec|shell|run_command|db_write|systemctl)/.test(normalized)) return "write";
  if (/^(draft|propose|plan|generate_patch|open_pr_draft)/.test(normalized)) return "draft";
  if (/^(read|list|search|grep|stat|get|fetch_local|view|log|diff_read|memory_read|trace_read)/.test(normalized)) return "read_only";
  return "write";
}

function routeNativeAdmission(taskType: NativeAdmissionTaskType, policy: NativeAdmissionPolicy): NativeAdmissionRoute {
  const target = routeTable[taskType];
  return {
    target,
    queuedForApproval:
      riskRank[policy.effectiveRisk] >= riskRank.write || target === "approval-queue" || target === "human-triage"
  };
}
