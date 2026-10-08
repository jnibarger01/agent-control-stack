import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  classifyReadOnlyArgv,
  commandPathOperands,
  inferCommandEffects,
  type CommandEffectTag
} from "./command-effects.js";
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
  // Jace Commander privileged_exec (acs.jc.v1): root execution of one exact
  // argv. Never auto-allowed, never admin-auto-approved, never self-approved;
  // it can only proceed on a human approval of this exact action hash. The
  // argv is deliberately NOT mapped to `command`, so the ordinary `sudo` /
  // shell-metacharacter denials below keep applying to every other action.
  if (context.action.kind === PRIVILEGED_EXEC_KIND) {
    if (context.operation === "approve" && isRequestingActor(context)) {
      return risk("forbidden", "privileged execution cannot be self-approved", ["deny:self-approval"]);
    }
    return risk("requires_approval", "privileged execution requires an approval record", ["approval:privileged-exec"]);
  }
  if (JC_APPROVAL_KINDS.has(context.action.kind)) {
    if (context.operation === "approve" && isRequestingActor(context)) {
      return risk("forbidden", "Jace Commander mutations cannot be self-approved", ["deny:self-approval"]);
    }
    return risk("requires_approval", "Jace Commander mutation requires approval", ["approval:jc-mutation"]);
  }
  if (JC_READ_KINDS.has(context.action.kind) && context.write !== true && context.destructive !== true) {
    return risk("read_only", "Jace Commander read-only integration view is allowed", ["allow:jc-read"]);
  }
  if (context.action.kind === "jc.integration.write" && context.destructive !== true) {
    // Creates an ACS work item that is itself policy-evaluated on its own.
    return risk("safe_mutation", "Jace Commander mission submission is allowed", ["allow:jc-mission-submit"]);
  }
  // Effects implied by the argv itself (P0-1). They annotate the decision; they only change its outcome
  // where the rules below say so. `write` is never inferred, because inferring it would move an action the
  // old rules denied into an approval.
  const effects = inferCommandEffects(command);
  // Paths the argv names count for the credential and project-root checks, not just declared `paths`.
  const pathScope = withCommandPathOperands(context, command);

  if (isSudo(command)) {
    return risk("forbidden", "sudo is denied by default", ["deny:sudo"]);
  }
  // `destructive: true` from the caller, and the literal `rm -rf /`, were hard denies before argv
  // classification existed, so they stay denies. A destructive argv on its own is not one: admin mode
  // auto-approves authorized execution (see the command-review branch below).
  if (isRmRfRoot(command) || context.destructive === true) {
    return risk("destructive", "destructive command is denied", ["deny:destructive"]);
  }
  if (hasShellMetacharacter(command)) {
    return risk("forbidden", "shell metacharacters are denied", ["deny:shell-metacharacter"]);
  }
  if (touchesCredentialPath(pathScope)) {
    return risk("forbidden", "credential path access is denied", ["deny:credential-path"]);
  }
  // Only declared paths. An argv operand outside the workspace is tagged on the approval below; denying
  // it would be a new hard deny for commands the old rules allowed. Credential paths are different: this
  // file already hard-denies them (`deny:credential-path`), so an argv that names one stays denied.
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
  // Only the caller-asserted flag was a hard deny before argv classification existed. A networked argv
  // is handled by the command review below, so it can be approved under admin mode instead of denied.
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
    return risk(
      "requires_approval",
      "package lifecycle scripts can execute arbitrary code",
      ["approval:package-script"],
      {
        maxRuntimeMs: 120_000
      }
    );
  }
  if (isReadOnlyInsideCwd(context)) {
    return risk("read_only", "read-only repo inspection is allowed", ["allow:read-only"], {
      allowedPaths: allowedPaths(context)
    });
  }
  const reviewed = reviewCommandBearingAction(context, effects.tags);
  if (reviewed) {
    return reviewed;
  }

  // Nothing else matched, so the old rules denied this. A destructive argv keeps that deny, but under the
  // rule id Jace approved for `git push --force` (P11): deny:destructive rather than deny:fail-closed.
  // The outcome is unchanged. A destructive command the old rules allowed never reaches here; the review
  // above already sent it to approval.
  if (effects.destructive) {
    return risk("destructive", "destructive command is denied", ["deny:destructive"]);
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

/** Action kinds policy evaluates. Anything else is denied as unknown (fail closed). */
export const SUPPORTED_ACTION_KINDS: readonly string[] = Object.freeze([
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
  "shell",
  "jc.integration.read",
  "jc.integration.write",
  "jc.fs.read",
  "jc.fs.write",
  "jc.process.read",
  "jc.process.exec",
  "jc.git.read",
  "jc.git.write",
  "jc.git.network",
  "privileged.exec"
]);

const PRIVILEGED_EXEC_KIND = "privileged.exec";
const JC_READ_KINDS: ReadonlySet<string> = new Set([
  "jc.integration.read",
  "jc.fs.read",
  "jc.process.read",
  "jc.git.read"
]);
const JC_APPROVAL_KINDS: ReadonlySet<string> = new Set([
  "jc.fs.write",
  "jc.process.exec",
  "jc.git.write",
  "jc.git.network"
]);

function isSupportedAction(kind: string): boolean {
  return SUPPORTED_ACTION_KINDS.includes(kind);
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

/**
 * Whether the acting principal is the one that requested the work. Jace
 * Commander work items are created with requester "agent" and the real
 * (attested) actor in requesterSubject, so both are compared.
 */
function isRequestingActor(context: PolicyContext): boolean {
  return (
    context.actor === context.requester ||
    (context.requesterSubject !== undefined && context.actor === context.requesterSubject)
  );
}

function isSelfApproval(context: PolicyContext): boolean {
  return context.operation === "approve" && requiresRiskApproval(context) && context.actor === context.requester;
}

function requiresRiskApproval(context: PolicyContext): boolean {
  return context.risk === "high" || context.risk === "critical";
}

/** `git status` / `git diff` in an exact read-only shape (no --output, --ext-diff, -c, ...). */
function isAllowedGitRead(command: string[]): boolean {
  return command[0] === "git" && (command[1] === "status" || command[1] === "diff") && classifyReadOnlyArgv(command).ok;
}

/** The pre-P0-1 git-read rule, which allowed any `git status` / `git diff` without reading the flags. */
function isLegacyUnscopedGitRead(command: string[]): boolean {
  return (
    command[0] === "git" && (command[1] === "status" || command[1] === "diff") && !classifyReadOnlyArgv(command).ok
  );
}

function isPackageLifecycleCommand(command: string[]): boolean {
  return (
    (command[0] === "npm" && command[1] === "test") ||
    (command[0] === "npm" && command[1] === "run") ||
    (command[0] === "pnpm" && (command[1] === "test" || command[1] === "run")) ||
    (command[0] === "bun" && command[1] === "test")
  );
}

/** Action kinds whose effect is the command they carry. Without a command there is nothing to classify. */
const COMMAND_BEARING_KINDS: ReadonlySet<string> = new Set(["shell", "cmd.run", "service.restart"]);

/**
 * Read-only inspection inside the project root. For an action that carries a command, declared `paths`
 * alone are not enough: the argv must be an allowlisted read-only shape and every operand it names must
 * stay inside `cwd`. A command that is not that shape is not read-only here; the command review below
 * sends it to approval instead of allowing it.
 */
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
  const command = context.command ?? [];
  if (command.length === 0 && COMMAND_BEARING_KINDS.has(context.action.kind)) {
    return false;
  }
  const root = resolve(context.cwd);
  if (!context.paths.every((path) => isInside(root, resolve(root, path)))) {
    return false;
  }
  if (command.length === 0) {
    return true;
  }
  const verdict = classifyReadOnlyArgv(command);
  return verdict.ok && verdict.operands.every((operand) => isInside(root, resolve(root, operand)));
}

/**
 * The pre-P0-1 read-only rule: caller flags clear, declared paths present and all inside `cwd`.
 */
function legacyReadOnlyInsideCwd(context: PolicyContext): boolean {
  if (context.write || context.network || context.destructive) {
    return false;
  }
  if (!context.paths?.length || !context.cwd) {
    return false;
  }
  const root = resolve(context.cwd);
  return context.paths.every((path) => isInside(root, resolve(root, path)));
}

/**
 * Command-bearing actions no earlier rule decided. The old rules auto-approved these whenever the
 * declared paths were inside `cwd`, without reading the argv, so a command that is not an exact
 * allowlisted read-only shape now needs a human approval instead (admin mode auto-approves those).
 * A command-bearing action the old rules did not allow keeps `deny:fail-closed`.
 *
 * The effect tags say why the approval is needed. They never change the outcome, so nothing the old
 * rules denied becomes an approval.
 */
function reviewCommandBearingAction(
  context: PolicyContext,
  tags: readonly CommandEffectTag[]
): PolicyRiskClassification | undefined {
  const command = context.command ?? [];
  if (!COMMAND_BEARING_KINDS.has(context.action.kind)) {
    return undefined;
  }
  // The old rules auto-approved a command-bearing action when its declared paths were inside `cwd`, and
  // any `git status` / `git diff` regardless of flags. Those now need approval unless the exact-shape
  // allowlist already allowed them above. Anything the old rules did not auto-approve is left to deny.
  const oldAutoApproved = legacyReadOnlyInsideCwd(context) || isLegacyUnscopedGitRead(command);
  if (!oldAutoApproved) {
    return undefined;
  }
  const effectTags = command.length === 0 ? (["unknown_command"] as const) : tags;
  const matchedRules = ["approval:command-review", ...effectTags.map((tag) => `effect:${tag}`)];
  const summary = effectTags.length > 0 ? effectTags.join(", ") : "unclassified command";
  return risk("requires_approval", `command requires approval (${summary})`, matchedRules);
}

function withCommandPathOperands(context: PolicyContext, command: string[]): PolicyContext {
  const operands = commandPathOperands(command);
  if (operands.length === 0) {
    return context;
  }
  return { ...context, paths: [...new Set([...(context.paths ?? []), ...operands])] };
}

function allowedPaths(context: PolicyContext): string[] | undefined {
  return context.cwd ? [resolve(context.cwd)] : undefined;
}
