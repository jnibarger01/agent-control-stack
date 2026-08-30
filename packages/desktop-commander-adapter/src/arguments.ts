import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import type { WorkItem } from "@agent-control-stack/work-items";
import { containCwd, containPath, type ContainmentConfig } from "./containment.js";
import { validateProcessCommand } from "./command-validation.js";
import { desktopCommanderToolPolicy, type DesktopCommanderToolPolicy } from "./tool-policy.js";

/**
 * Phase 3 + Phase 6 support.
 *
 * `reconstructDesktopCommanderInvocation` derives the canonical, fully-validated
 * Desktop Commander tool call from *trusted stored work-item state* (never from
 * agent-supplied transport metadata), so the action that executes is exactly the
 * action ACS evaluated and approved.
 */

export const DESKTOP_COMMANDER_INVOCATION_DOMAIN = "acs:desktop-commander-invocation:v1";

export interface NormalizedInvocation {
  toolName: string;
  /** Fully validated + path-normalised arguments to send over MCP. */
  validatedArguments: Record<string, unknown>;
  policy: DesktopCommanderToolPolicy;
  /** Canonical paths touched (post-containment), for audit + defence in depth. */
  canonicalPaths: string[];
}

function normalizePaths(
  policy: DesktopCommanderToolPolicy,
  args: Record<string, unknown>,
  containment: ContainmentConfig
): { args: Record<string, unknown>; canonicalPaths: string[] } {
  const next: Record<string, unknown> = { ...args };
  const canonicalPaths: string[] = [];

  for (const key of policy.cwdArgs) {
    const raw = next[key];
    if (typeof raw === "string") {
      const contained = containCwd(containment, raw);
      next[key] = contained.canonical;
      canonicalPaths.push(contained.canonical);
    }
  }
  const baseCwd = policy.cwdArgs.length > 0 ? (next[policy.cwdArgs[0] as string] as string | undefined) : undefined;

  for (const key of policy.pathArgs) {
    const raw = next[key];
    if (typeof raw !== "string") {
      throw new ControlStackError("desktop_commander_argument_invalid", `expected string path for '${key}'`);
    }
    const contained = containPath(containment, raw, baseCwd);
    next[key] = contained.canonical;
    canonicalPaths.push(contained.canonical);
  }
  for (const key of policy.multiPathArgs) {
    const raw = next[key];
    if (!Array.isArray(raw)) {
      throw new ControlStackError("desktop_commander_argument_invalid", `expected array of paths for '${key}'`);
    }
    next[key] = raw.map((entry) => {
      if (typeof entry !== "string") {
        throw new ControlStackError("desktop_commander_argument_invalid", `expected string path in '${key}'`);
      }
      const contained = containPath(containment, entry, baseCwd);
      canonicalPaths.push(contained.canonical);
      return contained.canonical;
    });
  }
  return { args: next, canonicalPaths };
}

/**
 * Validate + normalise a single requested action's params into a Desktop
 * Commander tool call.
 */
export function normalizeInvocation(
  toolName: string,
  rawParams: Record<string, unknown>,
  containment: ContainmentConfig
): NormalizedInvocation {
  const policy = desktopCommanderToolPolicy(toolName);
  if (!policy) {
    throw new ControlStackError(
      "desktop_commander_tool_not_allowlisted",
      `tool is not on the ACS Desktop Commander allowlist: ${toolName}`
    );
  }

  const parsed = policy.argsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new ControlStackError(
      "desktop_commander_argument_invalid",
      `invalid arguments for ${toolName}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`
    );
  }
  const validated = parsed.data as Record<string, unknown>;

  const { args, canonicalPaths } = normalizePaths(policy, validated, containment);

  for (const key of policy.commandArgs) {
    const commandLine = args[key];
    if (typeof commandLine !== "string") {
      throw new ControlStackError("desktop_commander_argument_invalid", `expected string command for '${key}'`);
    }
    // Throws on any forbidden/destructive command.
    validateProcessCommand(commandLine, containment.allowedRoots);
  }

  return {
    toolName,
    validatedArguments: canonicalize(args),
    policy,
    canonicalPaths
  };
}

/**
 * Reconstruct the canonical Desktop Commander invocation for a work item from
 * trusted stored state. Exactly one requested action is supported for real
 * execution (fail closed otherwise).
 */
export function reconstructDesktopCommanderInvocation(
  workItem: Pick<WorkItem, "id" | "requestedActions">,
  containment: ContainmentConfig
): NormalizedInvocation {
  const actions = workItem.requestedActions ?? [];
  if (actions.length !== 1) {
    throw new ControlStackError(
      "desktop_commander_action_count",
      `Desktop Commander execution requires exactly one requested action, work item ${workItem.id} has ${actions.length}`
    );
  }
  const [action] = actions;
  const params = (action.params ?? {}) as Record<string, unknown>;
  const toolName = typeof params.tool === "string" && params.tool.length > 0 ? params.tool : action.kind;
  const toolArgs = (params.arguments ?? params.args ?? stripControlParams(params)) as Record<string, unknown>;
  return normalizeInvocation(toolName, toolArgs, containment);
}

function stripControlParams(params: Record<string, unknown>): Record<string, unknown> {
  const { tool, arguments: _args, args: _a, write, destructive, network, allowNetwork, ...rest } = params;
  void tool;
  void _args;
  void _a;
  void write;
  void destructive;
  void network;
  void allowNetwork;
  return rest;
}

/** Deterministic key ordering so the fingerprint is stable. */
function canonicalize(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

/**
 * Phase 6 - a stable fingerprint of the exact tool call. Changing the tool, any
 * argument, or a normalised path changes this hash.
 */
export function desktopCommanderInvocationFingerprint(invocation: {
  toolName: string;
  validatedArguments: Record<string, unknown>;
}): string {
  return domainHash(DESKTOP_COMMANDER_INVOCATION_DOMAIN, {
    toolName: invocation.toolName,
    arguments: invocation.validatedArguments
  });
}
