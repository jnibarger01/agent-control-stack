import { ControlStackError } from "@agent-control-stack/shared";
import { previewCommand, type MachineControllerConfig, type RiskLevel } from "@agent-control-stack/machine-controller";

/**
 * Phase 5 - command / process validation for Desktop Commander `start_process`.
 *
 * Desktop Commander runs the command line through a shell and only checks a
 * user-editable blocklist. ACS does not trust that. Here the command line is
 * parsed, shell wrappers / metacharacters are rejected, the executable is
 * separated from its arguments, and the existing ACS command policy
 * (`previewCommand` from `@agent-control-stack/machine-controller`) classifies
 * it. `forbidden` and `destructive` classifications fail closed.
 *
 * ACS approval (bound to the exact action hash) remains the decision point for
 * whether a mutating command may run at all; this layer removes the categories
 * that are never acceptable (sudo, privilege escalation, `rm -rf /`, shell
 * metacharacters, redirection, subshells).
 */

const shellMetaPattern = /[;&|`$<>(){}[\]!*?~\n\r]/;
const privilegeEscalation = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
const shellWrappers = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "env",
  "nice",
  "nohup",
  "timeout",
  "xargs",
  "watch",
  "script"
]);

export interface ValidatedCommand {
  executable: string;
  args: string[];
  risk: RiskLevel;
  reason: string;
}

function splitCommandLine(commandLine: string): string[] {
  // Whitespace split only. Any quoting or metacharacter is treated as hostile
  // and rejected by the caller before we get here.
  return commandLine
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export function validateProcessCommand(
  commandLine: string,
  containmentRoots: readonly string[],
  deniedCommands: readonly string[] = []
): ValidatedCommand {
  if (typeof commandLine !== "string" || commandLine.trim().length === 0) {
    throw new ControlStackError("desktop_commander_command_invalid", "command must be a non-empty string");
  }
  if (commandLine.includes("\0")) {
    throw new ControlStackError("desktop_commander_command_invalid", "command must not contain NUL");
  }
  if (shellMetaPattern.test(commandLine)) {
    throw new ControlStackError(
      "desktop_commander_command_shell_metacharacter",
      "command must not contain shell metacharacters, redirection, globs or subshells"
    );
  }

  const tokens = splitCommandLine(commandLine);
  if (tokens.length === 0) {
    throw new ControlStackError("desktop_commander_command_invalid", "command has no executable");
  }

  const index = 0;
  // Reject leading KEY=VALUE environment assignments (an env-injection vector).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
    throw new ControlStackError(
      "desktop_commander_command_env_assignment",
      "inline environment assignments are not allowed"
    );
  }

  const rawExecutable = tokens[index] ?? "";
  const executableBase = rawExecutable.split("/").pop() ?? rawExecutable;

  if (privilegeEscalation.has(executableBase) || tokens.some((token) => privilegeEscalation.has(token))) {
    throw new ControlStackError(
      "desktop_commander_command_privilege_escalation",
      `privilege escalation is forbidden: ${executableBase}`
    );
  }
  if (shellWrappers.has(executableBase)) {
    throw new ControlStackError(
      "desktop_commander_command_shell_wrapper",
      `shell/exec wrapper is forbidden as the executable: ${executableBase}`
    );
  }
  if (rawExecutable.includes("/") && !rawExecutable.startsWith("/") && !rawExecutable.startsWith("./")) {
    throw new ControlStackError(
      "desktop_commander_command_relative_path",
      `ambiguous relative executable path: ${rawExecutable}`
    );
  }

  const args = tokens.slice(index + 1);
  const config = machineControllerShimConfig(containmentRoots, deniedCommands);
  const preview = previewCommand(config, {
    cwd: containmentRoots[0],
    command: executableBase,
    args
  });

  if (preview.risk === "forbidden") {
    throw new ControlStackError(
      "desktop_commander_command_forbidden",
      `command is forbidden by ACS policy: ${preview.reason}`
    );
  }
  if (preview.risk === "destructive") {
    throw new ControlStackError(
      "desktop_commander_command_destructive",
      `destructive commands are not permitted through the Desktop Commander adapter: ${preview.reason}`
    );
  }

  return { executable: executableBase, args, risk: preview.risk, reason: preview.reason };
}

function machineControllerShimConfig(
  containmentRoots: readonly string[],
  deniedCommands: readonly string[]
): MachineControllerConfig {
  return {
    server: { name: "acs-desktop-commander-adapter", transport: "stdio", version: "0.1.0" },
    security: {
      defaultPolicy: "deny",
      requireApprovalForMutations: true,
      redactSecrets: true,
      maxOutputBytes: 256 * 1024,
      commandTimeoutMs: 120_000,
      commandTerminationGraceMs: 1_000
    },
    paths: { allow: [...containmentRoots], deny: [] },
    commands: {
      // Read-only diagnostics are still allowed to classify as read_only; the
      // adapter never lowers approval requirements based on this.
      allowReadonly: [
        "git",
        "node",
        "npm",
        "pnpm",
        "bun",
        "python3",
        "docker",
        "df",
        "free",
        "ls",
        "cat",
        "rg",
        "grep"
      ],
      deny: [...deniedCommands]
    },
    audit: { logPath: "/dev/null" }
  };
}
