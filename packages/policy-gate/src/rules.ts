import { resolve } from "node:path";
import type { PolicyContext, PolicyDecision } from "./policy.js";

const credentialPathPattern =
  /(^|\/)(\.env(\.|$)|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.aws\/credentials$|credentials(\.json)?$|token(\.json)?$)/i;

export function evaluateRules(context: PolicyContext): PolicyDecision {
  const command = context.command ?? [];
  const commandName = command[0] ?? "";

  if (isSudo(command)) {
    return deny("sudo is denied by default", ["deny:sudo"]);
  }
  if (isRmRfRoot(command) || context.destructive === true) {
    return deny("destructive command is denied", ["deny:destructive"]);
  }
  if (readsCredentialPath(context)) {
    return deny("credential file reads are denied", ["deny:credential-path"]);
  }
  if (context.write === true && hasPathEscape(context)) {
    return deny("writes outside project root are denied", ["deny:path-escape"]);
  }

  if (isPackageInstall(command)) {
    return requireApproval("package install requires approval", ["approval:package-install"]);
  }
  if (context.network === true && !explicitlyAllowsNetwork(context)) {
    return deny("outbound network is denied by default", ["deny:network"]);
  }
  if (context.write === true) {
    return requireApproval("file writes require approval", ["approval:write"], { allowedPaths: allowedPaths(context) });
  }
  if (isServiceRestart(command)) {
    return requireApproval("service restart requires approval", ["approval:service-restart"]);
  }
  if (isGitCommit(command)) {
    return requireApproval("git commit requires approval", ["approval:git-commit"]);
  }
  if (isSystemMutation(commandName)) {
    return requireApproval("system mutation requires approval", ["approval:system-mutation"]);
  }
  if (isLongRunning(context)) {
    return requireApproval("long-running command requires approval", ["approval:long-running"]);
  }

  if (isAllowedGitRead(command)) {
    return allow("git inspection is allowed", ["allow:git-read"], { maxRuntimeMs: 30_000 });
  }
  if (isAllowedTestCommand(command)) {
    return allow("test command is allowed", ["allow:test"], { maxRuntimeMs: 120_000 });
  }
  if (isReadOnlyInsideCwd(context)) {
    return allow("read-only repo inspection is allowed", ["allow:read-only"], { allowedPaths: allowedPaths(context) });
  }

  return deny("no policy rule matched", ["deny:fail-closed"]);
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

function isSudo(command: string[]): boolean {
  return command[0] === "sudo" || command.includes("sudo");
}

function isRmRfRoot(command: string[]): boolean {
  if (command[0] !== "rm") {
    return false;
  }
  const hasRecursiveForce = command.some((part) => /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r/.test(part));
  return hasRecursiveForce && command.includes("/");
}

function readsCredentialPath(context: PolicyContext): boolean {
  return context.write !== true && (context.paths ?? []).some((path) => credentialPathPattern.test(path));
}

function explicitlyAllowsNetwork(context: PolicyContext): boolean {
  return context.action.params.allowNetwork === true;
}

function hasPathEscape(context: PolicyContext): boolean {
  if (!context.cwd || !context.paths?.length) {
    return false;
  }
  const root = resolve(context.cwd);
  return context.paths.some((path) => !isInside(root, resolve(root, path)));
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

function isAllowedGitRead(command: string[]): boolean {
  return command[0] === "git" && (command[1] === "status" || command[1] === "diff");
}

function isAllowedTestCommand(command: string[]): boolean {
  return (
    (command[0] === "npm" && command[1] === "test") ||
    (command[0] === "npm" && command[1] === "run" && (command[2] === "test" || command[2] === "check")) ||
    command[0] === "vitest"
  );
}

function isReadOnlyInsideCwd(context: PolicyContext): boolean {
  if (context.write || context.network || context.destructive) {
    return false;
  }
  if (!context.paths?.length) {
    return context.action.kind === "inspect" || context.action.kind === "read";
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
