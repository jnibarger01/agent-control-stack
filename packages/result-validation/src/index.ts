import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { EngineOutcome } from "@agent-control-stack/engine-adapter";

const execFileAsync = promisify(execFile);

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
      const escapesWorkspace =
        isAbsolute(artifact) || !resolve(input.workspacePath, artifact).startsWith(`${resolve(input.workspacePath)}/`);
      if (escapesWorkspace) {
        add(`artifact:${artifact}`, false, "artifact path escapes workspace");
        continue;
      }
      try {
        await access(resolve(input.workspacePath, artifact));
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
    const result = await (input.commandRunner ?? defaultCommandRunner)([input.gitPath ?? "git", "diff", "--name-only"], input.workspacePath);
    return { paths: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), exitCode: result.exitCode };
  }
}

async function defaultCommandRunner(command: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const executable = command[0];
    const args = command.slice(1);
    const result = await execFileAsync(executable, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

function matchesPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path === pattern || path.startsWith(`${pattern.replace(/\/$/u, "")}/`));
}
