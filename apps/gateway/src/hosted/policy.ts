import { isAbsolute, relative, resolve } from "node:path";
import { stableHash, type ActionRequest, type WorkItem } from "./contracts.js";

export type HostedPolicyOperation = "create" | "unblock";
export type HostedDecision = "allow" | "deny" | "require_approval";

export interface HostedPolicyEvaluation {
  readonly actionHash: string;
  readonly decision: HostedDecision;
  readonly reason: string;
  readonly matchedRules: string[];
}

export interface HostedPolicyReceipt {
  readonly decision: HostedDecision;
  readonly reason: string;
  readonly evaluations: HostedPolicyEvaluation[];
}

const supportedKinds = new Set([
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
]);
const shellMetaPattern = /[;&|`$<>]/u;
const credentialPathPattern =
  /(^|\/)(\.env(\.|$)|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.aws\/credentials$|credentials(\.json)?$|token(\.json)?$)/iu;

/**
 * Hosted policy is an admission gate, not execution authority. The local ACS
 * worker MUST re-evaluate the approved action against its own filesystem and
 * execution policy before doing anything privileged.
 */
export function evaluateHostedPolicy(workItem: WorkItem, actor: string, operation: HostedPolicyOperation): HostedPolicyReceipt {
  const evaluations = workItem.requestedActions.map((rawAction) => {
    const action = canonicalAction(rawAction);
    const context = policyContext(workItem, action, actor, operation);
    const decision = evaluateAction(workItem, action, context);
    return { actionHash: stableHash(context), ...decision };
  });

  if (evaluations.length === 0) {
    return { decision: "deny", reason: "work item has no requested actions", evaluations: [] };
  }
  const denial = evaluations.find((entry) => entry.decision === "deny");
  if (denial) return { decision: "deny", reason: denial.reason, evaluations };
  const approval = evaluations.find((entry) => entry.decision === "require_approval");
  if (approval) return { decision: "require_approval", reason: approval.reason, evaluations };
  return { decision: "allow", reason: "all actions allowed", evaluations };
}

function evaluateAction(
  workItem: WorkItem,
  action: ActionRequest,
  context: ReturnType<typeof policyContext>
): Omit<HostedPolicyEvaluation, "actionHash"> {
  const command = stringArray(action.params.command) ?? [];
  const commandName = command[0] ?? "";
  const paths = context.paths;

  if (!supportedKinds.has(action.kind)) return deny("unknown action kind is denied", "deny:unknown-action");
  if (command[0] === "sudo" || command.includes("sudo")) return deny("sudo is denied by default", "deny:sudo");
  if (isRmRfRoot(command) || action.params.destructive === true) return deny("destructive command is denied", "deny:destructive");
  if (command.some((part) => shellMetaPattern.test(part))) return deny("shell metacharacters are denied", "deny:shell-metacharacter");
  if (action.params.write !== true && paths.some((path) => credentialPathPattern.test(path))) {
    return deny("credential file reads are denied", "deny:credential-path");
  }
  if (hasLexicalPathEscape(context.cwd, paths)) return deny("paths outside project root are denied", "deny:path-escape");
  if (workItem.risk === "high" || workItem.risk === "critical") {
    return approval(`${workItem.risk} risk work requires approval`, "approval:risk");
  }
  if (isPackageInstall(command)) return approval("package install requires approval", "approval:package-install");
  if (action.params.network === true && action.params.allowNetwork !== true) {
    return deny("outbound network is denied by default", "deny:network");
  }
  if (action.params.write === true || isWriteKind(action.kind)) return approval("file writes require approval", "approval:write");
  if (action.kind === "agent.prompt") return allow("agent prompt dispatch is allowed", "allow:agent-prompt");
  if (isServiceRestart(command)) return approval("service restart requires approval", "approval:service-restart");
  if (command[0] === "git" && command[1] === "commit") return approval("git commit requires approval", "approval:git-commit");
  if (["chmod", "chown", "mount", "umount"].includes(commandName)) return approval("system mutation requires approval", "approval:system-mutation");
  if (action.params.longRunning === true || numberValue(action.params.timeoutMs) > 120_000) {
    return approval("long-running command requires approval", "approval:long-running");
  }
  if (command[0] === "git" && (command[1] === "status" || command[1] === "diff")) {
    return allow("git inspection is allowed", "allow:git-read");
  }
  if (isPackageLifecycle(command)) return approval("package lifecycle scripts can execute arbitrary code", "approval:package-script");
  if (isReadOnlyKind(action.kind) && context.cwd && paths.length > 0) return allow("read-only repo inspection is allowed", "allow:read-only");
  if (action.kind === "system.status") return allow("system status inspection is allowed", "allow:system-status");
  return deny("no policy rule matched", "deny:fail-closed");
}

function policyContext(workItem: WorkItem, action: ActionRequest, actor: string, operation: HostedPolicyOperation) {
  const cwd = stringValue(action.params.cwd) ?? workItem.target.cwd;
  const paths = stringArray(action.params.paths) ?? workItem.target.files ?? [];
  return {
    schemaVersion: "acs.hosted-policy-context.v1",
    workItemId: workItem.id,
    actor,
    operation,
    requester: workItem.requester,
    requesterSubject: workItem.requesterSubject ?? null,
    risk: workItem.risk,
    action,
    cwd: cwd ?? null,
    command: stringArray(action.params.command) ?? [],
    paths,
    network: action.params.network === true,
    write: action.params.write === true || isWriteKind(action.kind),
    destructive: action.params.destructive === true
  };
}

function canonicalAction(action: ActionRequest): ActionRequest {
  const aliases: Record<string, string> = { read: "fs.read", inspect: "fs.read", edit: "fs.write", write: "fs.write", command: "shell" };
  return { ...action, kind: aliases[action.kind] ?? action.kind };
}

function isReadOnlyKind(kind: string): boolean {
  return ["fs.list", "fs.stat", "fs.read", "fs.search_name"].includes(kind);
}

function isWriteKind(kind: string): boolean {
  return ["fs.write", "fs.patch", "fs.move", "fs.delete"].includes(kind);
}

function hasLexicalPathEscape(cwd: string | undefined, paths: string[]): boolean {
  if (!cwd || paths.length === 0) return false;
  const root = resolve(cwd);
  return paths.some((path) => {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, target);
    return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
  });
}

function isRmRfRoot(command: string[]): boolean {
  if (command[0] !== "rm") return false;
  return command.some((part) => /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r/u.test(part)) && command.includes("/");
}

function isPackageInstall(command: string[]): boolean {
  return (
    (command[0] === "npm" && ["install", "i"].includes(command[1] ?? "")) ||
    (command[0] === "pnpm" && command[1] === "add") ||
    (command[0] === "yarn" && ["add", "install"].includes(command[1] ?? ""))
  );
}

function isPackageLifecycle(command: string[]): boolean {
  return (
    (command[0] === "npm" && ["test", "run"].includes(command[1] ?? "")) ||
    (command[0] === "pnpm" && ["test", "run"].includes(command[1] ?? "")) ||
    (command[0] === "bun" && command[1] === "test")
  );
}

function isServiceRestart(command: string[]): boolean {
  return (
    (command[0] === "systemctl" && command.includes("restart")) ||
    (command[0] === "service" && command.includes("restart")) ||
    (command[0] === "docker" && command[1] === "restart") ||
    (command[0] === "pm2" && command[1] === "restart")
  );
}

function allow(reason: string, rule: string) {
  return { decision: "allow" as const, reason, matchedRules: [rule] };
}
function deny(reason: string, rule: string) {
  return { decision: "deny" as const, reason, matchedRules: [rule] };
}
function approval(reason: string, rule: string) {
  return { decision: "require_approval" as const, reason, matchedRules: [rule] };
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0) ? value : undefined;
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
