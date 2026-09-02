import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { PolicyContext, PolicyDecision } from "./policy.js";

export type PolicyRiskLevel = "read_only" | "safe_mutation" | "requires_approval" | "destructive" | "forbidden";

export interface PolicyRiskClassification {
  risk: PolicyRiskLevel;
  reason: string;
  matchedRules: string[];
  maxRuntimeMs?: number;
  allowedPaths?: string[];
}

const credentialPathPattern =
  /(^|\/)(\.env(\.|$)|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.aws\/credentials$|credentials(\.json)?$|token(\.json)?$)/i;
const shellMetaPattern = /[;&|`$<>]/;

export function evaluateRules(context: PolicyContext): PolicyDecision {
  const classification = classifyPolicyRisk(context);
  const extra = {
    maxRuntimeMs: classification.maxRuntimeMs,
    allowedPaths: classification.allowedPaths
  };

  if (classification.risk === "read_only" || classification.risk === "safe_mutation") {
    return allow(classification.reason, classification.matchedRules, extra);
  }
  if (classification.risk === "requires_approval") {
    return requireApproval(classification.reason, classification.matchedRules, extra);
  }
  return deny(classification.reason, classification.matchedRules);
}

export function classifyPolicyRisk(context: PolicyContext): PolicyRiskClassification {
  const command = context.command ?? [];
  const commandName = command[0] ?? "";

  if (!isSupportedAction(context.action.kind)) {
    return risk("forbidden", "unknown action kind is denied", ["deny:unknown-action"]);
  }
  if (isSudo(command)) {
    return risk("forbidden", "sudo is denied by default", ["deny:sudo"]);
  }
  if (isRmRfRoot(command) || context.destructive === true) {
    return risk("destructive", "destructive command is denied", ["deny:destructive"]);
  }
  if (hasShellMetacharacter(command)) {
    return risk("forbidden", "shell metacharacters are denied", ["deny:shell-metacharacter"]);
  }
  if (touchesCredentialPath(context)) {
    return risk("forbidden", "credential path access is denied", ["deny:credential-path"]);
  }
  if (hasPathEscape(context)) {
    return risk("forbidden", "paths outside project root are denied", ["deny:path-escape"]);
  }
  if (isSelfApproval(context)) {
    return risk("forbidden", "high-risk self-approval is denied", ["deny:self-approval"]);
  }
  if (requiresRiskApproval(context)) {
    return risk("requires_approval", `${context.risk} risk work requires approval`, ["approval:risk"]);
  }

  if (isPackageInstall(command)) {
    return risk("requires_approval", "package install requires approval", ["approval:package-install"]);
  }
  if (context.network === true && !explicitlyAllowsNetwork(context)) {
    return risk("forbidden", "outbound network is denied by default", ["deny:network"]);
  }
  if (context.write === true) {
    return risk("requires_approval", "file writes require approval", ["approval:write"], {
      allowedPaths: allowedPaths(context)
    });
  }
  if (isAgentPrompt(context)) {
    return risk("safe_mutation", "agent prompt dispatch is allowed", ["allow:agent-prompt"]);
  }
  if (isServiceRestart(command)) {
    return risk("requires_approval", "service restart requires approval", ["approval:service-restart"]);
  }
  if (isGitCommit(command)) {
    return risk("requires_approval", "git commit requires approval", ["approval:git-commit"]);
  }
  if (isSystemMutation(commandName)) {
    return risk("requires_approval", "system mutation requires approval", ["approval:system-mutation"]);
  }
  if (isLongRunning(context)) {
    return risk("requires_approval", "long-running command requires approval", ["approval:long-running"]);
  }

  if (isAllowedGitRead(command)) {
    return risk("read_only", "git inspection is allowed", ["allow:git-read"], { maxRuntimeMs: 30_000 });
  }
  if (isPackageLifecycleCommand(command)) {
    return risk("requires_approval", "package lifecycle scripts can execute arbitrary code", ["approval:package-script"], {
      maxRuntimeMs: 120_000
    });
  }
  if (isReadOnlyInsideCwd(context)) {
    return risk("read_only", "read-only repo inspection is allowed", ["allow:read-only"], {
      allowedPaths: allowedPaths(context)
    });
  }

  return risk("forbidden", "no policy rule matched", ["deny:fail-closed"]);
}

function allow(
  reason: string,
  matchedRules: string[],
  extra: Pick<PolicyDecision, "allowedPaths" | "maxRuntimeMs"> = {}
): PolicyDecision {
  return { decision: "allow", reason, matchedRules, ...extra };
}

function deny(reason: string, matchedRules: string[]): PolicyDecision {
  return { decision: "deny", reason, matchedRules };
}

function requireApproval(
  reason: string,
  matchedRules: string[],
  extra: Pick<PolicyDecision, "allowedPaths" | "maxRuntimeMs"> = {}
): PolicyDecision {
  return { decision: "require_approval", reason, matchedRules, requiredApprover: "user", ...extra };
}

function risk(
  risk: PolicyRiskLevel,
  reason: string,
  matchedRules: string[],
  extra: Pick<PolicyRiskClassification, "allowedPaths" | "maxRuntimeMs"> = {}
): PolicyRiskClassification {
  return { risk, reason, matchedRules, ...extra };
}

function isSudo(command: string[]): boolean {
  return command[0] === "sudo" || command.includes("sudo");
}

function isSupportedAction(kind: string): boolean {
  return (
    kind === "system.status" ||
    kind === "fs.list" ||
    kind === "fs.stat" ||
    kind === "fs.read" ||
    kind === "fs.search_name" ||
    kind === "fs.write" ||
    kind === "fs.patch" ||
    kind === "fs.move" ||
    kind === "fs.delete" ||
    kind === "agent.prompt" ||
    kind === "cmd.preview" ||
    kind === "cmd.run" ||
    kind === "service.restart" ||
    kind === "shell"
  );
}

function isRmRfRoot(command: string[]): boolean {
  if (command[0] !== "rm") {
    return false;
  }
  const hasRecursiveForce = command.some((part) => /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r/.test(part));
  return hasRecursiveForce && command.includes("/");
}

function touchesCredentialPath(context: PolicyContext): boolean {
  const paths = context.paths ?? [];
  if (paths.length === 0) {
    return false;
  }
  const base = context.cwd ? resolve(context.cwd) : resolve(".");
  return paths.some((path) => {
    if (credentialPathPattern.test(path)) {
      return true;
    }
    const canonical = realpathForPolicy(resolve(base, path));
    return credentialPathPattern.test(canonical);
  });
}

function explicitlyAllowsNetwork(context: PolicyContext): boolean {
  return context.action.params.allowNetwork === true;
}

function hasPathEscape(context: PolicyContext): boolean {
  if (!context.cwd || !context.paths?.length) {
    return false;
  }
  const root = realpathForPolicy(resolve(context.cwd));
  return context.paths.some((path) => !isInside(root, realpathForPolicy(resolve(root, path))));
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function isPackageInstall(command: string[]): boolean {
  return (
    (command[0] === "npm" && command[1] === "install") ||
    (command[0] === "npm" && command[1] === "i") ||
    (command[0] === "pnpm" && command[1] === "add") ||
    (command[0] === "yarn" && (command[1] === "add" || command[1] === "install"))
  );
}

function hasShellMetacharacter(command: string[]): boolean {
  return command.some((part) => shellMetaPattern.test(part));
}

function realpathForPolicy(path: string): string {
  try {
    if (existsSync(path)) {
      return realpathSync(path);
    }

    let current = dirname(path);
    while (current !== dirname(current)) {
      if (existsSync(current)) {
        return resolve(realpathSync(current), relative(current, path));
      }
      current = dirname(current);
    }
  } catch {
    return resolve(path);
  }

  return resolve(path);
}

function isAgentPrompt(context: PolicyContext): boolean {
  return context.action.kind === "agent.prompt";
}

function isServiceRestart(command: string[]): boolean {
  return (
    (command[0] === "systemctl" && command.includes("restart")) ||
    (command[0] === "service" && command.includes("restart")) ||
    (command[0] === "docker" && command[1] === "restart") ||
    (command[0] === "pm2" && command[1] === "restart")
  );
}

function isGitCommit(command: string[]): boolean {
  return command[0] === "git" && command[1] === "commit";
}

function isSystemMutation(commandName: string): boolean {
  return commandName === "chmod" || commandName === "chown" || commandName === "mount" || commandName === "umount";
}

function isLongRunning(context: PolicyContext): boolean {
  const timeoutMs = Number(context.action.params.timeoutMs ?? 0);
  return context.action.params.longRunning === true || timeoutMs > 120_000;
}

function isSelfApproval(context: PolicyContext): boolean {
  return context.operation === "approve" && requiresRiskApproval(context) && context.actor === context.requester;
}

function requiresRiskApproval(context: PolicyContext): boolean {
  return context.risk === "high" || context.risk === "critical";
}

function isAllowedGitRead(command: string[]): boolean {
  return command[0] === "git" && (command[1] === "status" || command[1] === "diff");
}

function isPackageLifecycleCommand(command: string[]): boolean {
  return (
    (command[0] === "npm" && command[1] === "test") ||
    (command[0] === "npm" && command[1] === "run") ||
    (command[0] === "pnpm" && (command[1] === "test" || command[1] === "run")) ||
    (command[0] === "bun" && command[1] === "test")
  );
}

function isReadOnlyInsideCwd(context: PolicyContext): boolean {
  if (context.write || context.network || context.destructive) {
    return false;
  }
  if (!context.paths?.length) {
    return false;
  }
  if (!context.cwd) {
    return false;
  }
  const root = resolve(context.cwd);
  return context.paths.every((path) => isInside(root, resolve(root, path)));
}

function allowedPaths(context: PolicyContext): string[] | undefined {
  return context.cwd ? [resolve(context.cwd)] : undefined;
}
