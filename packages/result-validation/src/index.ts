import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runBoundedCommand, subprocessEnv } from "@agent-control-stack/machine-controller";
import type { EngineOutcome } from "@agent-control-stack/engine-adapter";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
  stdout?: string;
  stderr?: string;
}

export interface ValidationInput {
  workspacePath: string;
  outcome: EngineOutcome;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  expectedArtifacts?: string[];
  commands?: string[][];
  gitPath?: string;
  commandRunner?: (command: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  changedPaths: string[];
}

/** Independent evidence gate. Agent-reported success is only one input. */
export class ResultValidator {
  async validate(input: ValidationInput): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];
    const changed = await this.changedPaths(input);
    const changedPaths = changed.paths;
    const add = (name: string, passed: boolean, detail: string, extra: Partial<ValidationCheck> = {}) => checks.push({ name, passed, detail, ...extra });

    add("engine_outcome", input.outcome.status === "completed" && input.outcome.exitCode === 0, input.outcome.status === "completed" ? `exit code ${input.outcome.exitCode}` : `engine outcome ${input.outcome.status}`);
    add("git_diff", changed.exitCode === 0, changed.exitCode === 0 ? "git diff inspected" : "git diff inspection failed");
    const forbidden = changedPaths.filter((path) => matchesPath(path, input.forbiddenPaths ?? []));
    add("forbidden_paths", forbidden.length === 0, forbidden.length ? `forbidden paths changed: ${forbidden.join(", ")}` : "no forbidden paths changed");
    const allowed = input.allowedPaths ?? [];
    if (allowed.length) {
      const outside = changedPaths.filter((path) => !matchesPath(path, allowed));
      add("allowed_paths", outside.length === 0, outside.length ? `paths outside allowed boundary: ${outside.join(", ")}` : "all changes are within the allowed boundary");
    }

    for (const artifact of input.expectedArtifacts ?? []) {
      const workspaceRoot = resolve(input.workspacePath);
      const artifactPath = resolve(input.workspacePath, artifact);
      const escapesWorkspace = isAbsolute(artifact) || !artifactPath.startsWith(`${workspaceRoot}/`);
      if (escapesWorkspace) {
        add(`artifact:${artifact}`, false, "artifact path escapes workspace");
        continue;
      }
      try {
        const artifactStat = await lstat(artifactPath);
        if (artifactStat.isSymbolicLink()) {
          const [realTarget, realWorkspaceRoot] = await Promise.all([
            realpath(artifactPath),
            realpath(workspaceRoot)
          ]);
          const withinWorkspace = realTarget === realWorkspaceRoot || realTarget.startsWith(`${realWorkspaceRoot}/`);
          if (!withinWorkspace) {
            add(`artifact:${artifact}`, false, "artifact is a symlink that escapes the workspace");
            continue;
          }
        }
        await access(artifactPath);
        add(`artifact:${artifact}`, true, "artifact exists");
      } catch {
        add(`artifact:${artifact}`, false, "artifact is missing");
      }
    }

    for (const command of input.commands ?? []) {
      const result = await (input.commandRunner ?? defaultCommandRunner)(command, input.workspacePath);
      add(`command:${command[0] ?? "unknown"}`, result.exitCode === 0, `exit code ${result.exitCode}`, { stdout: result.stdout, stderr: result.stderr });
    }
    return { passed: checks.every((check) => check.passed), checks, changedPaths };
  }

  private async changedPaths(input: ValidationInput): Promise<{ paths: string[]; exitCode: number }> {
    const runner = input.commandRunner ?? defaultCommandRunner;
    const git = input.gitPath ?? "git";
    // Compare the complete worktree (staged, unstaged, deleted) against HEAD
    // in one shot, and separately list untracked files - together this is
    // the exact set `git add -A` would stage for publication. Plain
    // `git diff --name-only` alone omits staged and untracked changes.
    const [trackedResult, untrackedResult] = await Promise.all([
      runner([git, "diff", "--name-only", "HEAD"], input.workspacePath),
      runner([git, "ls-files", "--others", "--exclude-standard"], input.workspacePath)
    ]);
    const exitCode = trackedResult.exitCode !== 0 ? trackedResult.exitCode : untrackedResult.exitCode;
    const paths = new Set<string>();
    for (const line of [...trackedResult.stdout.split("\n"), ...untrackedResult.stdout.split("\n")]) {
      const trimmed = line.trim();
      if (trimmed) paths.add(trimmed);
    }
    return { paths: [...paths], exitCode };
  }
}

async function defaultCommandRunner(command: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [executable, ...args] = command;
  if (!executable) {
    return { stdout: "", stderr: "empty command", exitCode: 1 };
  }
  const result = await runBoundedCommand({
    cwd,
    command: executable,
    args,
    env: subprocessEnv(),
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

function matchesPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path === pattern || path.startsWith(`${pattern.replace(/\/$/u, "")}/`));
}
