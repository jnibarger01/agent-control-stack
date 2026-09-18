import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { previewCommand, type MachineControllerConfig, type RiskLevel } from "@agent-control-stack/machine-controller";
import { containPath, type ContainmentConfig } from "./containment.js";

const shellMetaPattern = /[;&|`$<>(){}[\]!*?~\n\r'"\\]/;
const privilegeEscalation = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
const shellWrappers = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "env", "nice", "nohup", "timeout", "xargs", "watch", "script"
]);
const fixedExecutableDirs = ["/usr/bin", "/bin", "/usr/local/bin"] as const;
const dangerousExactArgs = new Set([
  "--no-index", "--privileged", "-v", "--volume", "--mount", "--device",
  "--cap-add", "--security-opt", "--pid=host", "--ipc=host", "--uts=host",
  "--userns=host", "--network=host"
]);
const pathValueFlags = new Set([
  "--output", "-o", "--file", "-f", "--config", "--cwd", "--prefix", "--cache",
  "--work-tree", "--git-dir", "-C"
]);

export interface ValidatedCommand {
  executable: string;
  resolvedExecutable: string;
  resolvedCommandLine: string;
  args: string[];
  risk: RiskLevel;
  reason: string;
}
function splitCommandLine(commandLine: string): string[] {
  return commandLine.trim().split(/\s+/).filter(Boolean);
}

export function validateProcessCommand(
  commandLine: string,
  containmentInput: ContainmentConfig | readonly string[],
  baseCwd?: string,
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
      "command must not contain shell metacharacters, redirection, quoting, globs or subshells"
    );
  }

  const tokens = splitCommandLine(commandLine);
  if (tokens.length === 0) {
    throw new ControlStackError("desktop_commander_command_invalid", "command has no executable");
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) {
    throw new ControlStackError("desktop_commander_command_env_assignment", "inline environment assignments are not allowed");
  }

  const rawExecutable = tokens[0] ?? "";
  if (rawExecutable.includes("/") || rawExecutable.includes("\\")) {
    throw new ControlStackError("desktop_commander_command_executable_path", "executable paths are forbidden; use an allowlisted command name");
  }
  const executableBase = rawExecutable;
  if (privilegeEscalation.has(executableBase) || tokens.some((token) => privilegeEscalation.has(token))) {
    throw new ControlStackError("desktop_commander_command_privilege_escalation", `privilege escalation is forbidden: ${executableBase}`);
  }
  if (shellWrappers.has(executableBase)) {
    throw new ControlStackError("desktop_commander_command_shell_wrapper", `shell/exec wrapper is forbidden as the executable: ${executableBase}`);
  }

  const containment: ContainmentConfig =
    "allowedRoots" in containmentInput
      ? containmentInput
      : { allowedRoots: [...containmentInput], deniedRoots: [] };
  const cwd = baseCwd ?? containment.allowedRoots[0];
  if (!cwd) {
    throw new ControlStackError("desktop_commander_path_no_root", "no Desktop Commander allow root is configured");
  }

  const rawArgs = tokens.slice(1);
  const config = machineControllerShimConfig(containment.allowedRoots, deniedCommands);
  const preview = previewCommand(config, { cwd, command: executableBase, args: rawArgs });

  if (preview.risk === "forbidden") {
    throw new ControlStackError("desktop_commander_command_forbidden", `command is forbidden by ACS policy: ${preview.reason}`);
  }
  if (preview.risk === "destructive") {
    throw new ControlStackError(
      "desktop_commander_command_destructive",
      `destructive commands are not permitted through the Desktop Commander adapter: ${preview.reason}`
    );
  }

  const args = validateArgumentPaths(rawArgs, containment, cwd);
  const resolvedExecutable = resolveExecutableFromFixedPath(executableBase);
  const resolvedCommandLine = [resolvedExecutable, ...args].join(" ");
  return { executable: executableBase, resolvedExecutable, resolvedCommandLine, args, risk: preview.risk, reason: preview.reason };
}

function validateArgumentPaths(args: string[], containment: ContainmentConfig, cwd: string): string[] {
  const next = [...args];
  for (let i = 0; i < next.length; i += 1) {
    const token = next[i] ?? "";
    if (dangerousExactArgs.has(token) || token.startsWith("--privileged=") || token.startsWith("--volume=") ||
        token.startsWith("--mount=") || token.startsWith("--device=") || token.startsWith("--cap-add=") ||
        token.startsWith("--security-opt=")) {
      throw new ControlStackError("desktop_commander_command_dangerous_argument", `dangerous command argument is forbidden: ${token}`);
    }
    const eq = token.indexOf("=");
    if (eq > 0 && pathValueFlags.has(token.slice(0, eq))) {
      const flag = token.slice(0, eq);
      next[i] = `${flag}=${containCommandPath(containment, token.slice(eq + 1), cwd)}`;
      continue;
    }
    if (pathValueFlags.has(token)) {
      const value = next[i + 1];
      if (!value) throw new ControlStackError("desktop_commander_command_invalid", `missing path value for ${token}`);
      next[i + 1] = containCommandPath(containment, value, cwd);
      i += 1;
      continue;
    }
    if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../") ||
        token.split(/[\\/]/).some((part) => part === "..") || looksSensitive(token)) {
      next[i] = containCommandPath(containment, token, cwd);
    }
  }
  return next;
}

function containCommandPath(containment: ContainmentConfig, value: string, cwd: string): string {
  const canonical = containPath(containment, value, cwd).canonical;
  if (/\s/.test(canonical)) {
    throw new ControlStackError("desktop_commander_command_path_whitespace", "command paths containing whitespace are not supported");
  }
  return canonical;
}

function looksSensitive(value: string): boolean {
  return /(^|[\\/])(\.env(\.|$)|\.ssh([\\/]|$)|\.gnupg([\\/]|$)|\.aws[\\/](credentials|config)$|\.kube[\\/]config$|\.npmrc$|\.netrc$|id_(rsa|ed25519)$|credentials(\.json)?$|token(\.json)?$)/i.test(value);
}

function resolveExecutableFromFixedPath(executable: string): string {
  for (const dir of fixedExecutableDirs) {
    const candidate = join(dir, executable);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not executable in this directory; try the next fixed directory
    }
  }
  throw new ControlStackError("desktop_commander_command_executable_missing", `allowlisted executable not found on fixed system PATH: ${executable}`);
}

function machineControllerShimConfig(containmentRoots: readonly string[], deniedCommands: readonly string[]): MachineControllerConfig {
  return {
    server: { name: "acs-desktop-commander-adapter", transport: "stdio", version: "0.1.0" },
    security: {
      defaultPolicy: "deny", requireApprovalForMutations: true, redactSecrets: true,
      maxOutputBytes: 256 * 1024, commandTimeoutMs: 120_000, commandTerminationGraceMs: 1_000
    },
    paths: { allow: [...containmentRoots], deny: [] },
    commands: {
      allowReadonly: ["git", "node", "npm", "pnpm", "bun", "python3", "docker", "df", "free", "ls", "cat", "rg", "grep"],
      deny: [...deniedCommands]
    },
    audit: { logPath: "/dev/null" }
  };
}
