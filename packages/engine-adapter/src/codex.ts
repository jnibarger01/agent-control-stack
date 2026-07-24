import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  createEngineIsolation,
  type EngineIsolation,
  type EngineIsolationAuthorityVerifier,
  type EngineIsolationObservation,
  type EngineIsolationRequest,
  type EngineRuntimeMount
} from "@agent-control-stack/sandbox";
import { type EngineAdapter, type EngineOutcome, type EngineTask, engineTaskSchema } from "./types.js";

export interface CodexEngineAdapterOptions {
  /** Codex CLI's own sandbox mode for the shell commands it decides to run internally. */
  codexSandboxMode?: "read-only" | "workspace-write";
  /** ACS-operator-trusted authority source - never derived from task input. */
  authorityVerifier: EngineIsolationAuthorityVerifier;
  /** ACS-operator-configured read-only mounts for the Codex CLI's own install directory. */
  runtimeMounts?: EngineRuntimeMount[];
  /** Absolute path to the codex binary. Resolved once at construction; never caller-supplied per task. */
  binaryPath?: string;
  /** Name of the environment variable Codex needs for its own model API. */
  credentialEnvName?: string;
  /** Where the credential's value comes from at invoke time. Defaults to reading process.env once per call, never mutating or exposing the rest of the environment. */
  credentialSource?: (envName: string) => string | undefined;
  isolationFactory?: (options: {
    authorityVerifier: EngineIsolationAuthorityVerifier;
    runtimeMounts?: EngineRuntimeMount[];
  }) => EngineIsolation;
}

const DEFAULT_CODEX_SANDBOX_MODE = "workspace-write";
const DEFAULT_CREDENTIAL_ENV_NAME = "OPENAI_API_KEY";
const DEFAULT_EGRESS_ALLOWLIST = [{ host: "api.openai.com", port: 443 }] as const;

export function buildCodexArgs(prompt: string, sandboxMode: "read-only" | "workspace-write"): string[] {
  return ["exec", "--sandbox", sandboxMode, "--skip-git-repo-check", prompt];
}

/**
 * Codex CLI as an EngineAdapter. Runs `codex exec` inside
 * packages/sandbox's EngineIsolationBackend (ADR 0014) - an
 * authority-resolved workspace mount, a private HOME, exactly one injected
 * credential, and network access scoped to api.openai.com through an
 * audited proxy - not a bare, workspace-scoped subprocess. Codex's own
 * `--sandbox workspace-write` remains as defense in depth for the shell
 * commands it decides to run internally; it is not the containment
 * boundary itself.
 */
export class CodexEngineAdapter implements EngineAdapter {
  readonly id = "codex" as const;
  private readonly sandboxMode: "read-only" | "workspace-write";
  private readonly binaryPath: string;
  private readonly credentialEnvName: string;
  private readonly credentialSource: (envName: string) => string | undefined;
  private readonly isolation: EngineIsolation;

  constructor(options: CodexEngineAdapterOptions) {
    this.sandboxMode = options.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE;
    this.binaryPath = options.binaryPath ?? resolveOnPath("codex");
    this.credentialEnvName = options.credentialEnvName ?? DEFAULT_CREDENTIAL_ENV_NAME;
    this.credentialSource = options.credentialSource ?? ((envName) => process.env[envName]);
    const factory = options.isolationFactory ?? createEngineIsolation;
    this.isolation = factory({
      authorityVerifier: options.authorityVerifier,
      runtimeMounts: options.runtimeMounts
    });
  }

  async invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome> {
    const parsed = engineTaskSchema.parse(task);
    if (signal?.aborted) {
      throw new ControlStackError("engine_invoke_cancelled", "engine invocation was cancelled before it started");
    }

    const credentialValue = this.credentialSource(this.credentialEnvName);
    if (!credentialValue) {
      throw new ControlStackError(
        "engine_credential_unavailable",
        `no value available for required credential ${this.credentialEnvName}`
      );
    }

    const request: EngineIsolationRequest = {
      schemaVersion: "acs.engine-isolation.v1",
      workItemId: parsed.workItemId,
      attemptId: parsed.attemptId,
      leaseId: parsed.leaseId,
      workerId: parsed.workerId,
      fencingToken: parsed.fencingToken,
      authorization: parsed.authorization,
      policyVersion: parsed.policyVersion,
      auditCorrelationId: parsed.auditCorrelationId,
      idempotencyKey: parsed.idempotencyKey,
      workspace: parsed.workspace,
      engineId: this.id,
      executable: this.binaryPath,
      args: buildCodexArgs(parsed.prompt, this.sandboxMode),
      cwd: ".",
      credential: { envName: this.credentialEnvName, envValue: credentialValue },
      network: "scoped-egress",
      egressAllowlist: parsed.egressAllowlist.length ? parsed.egressAllowlist : [...DEFAULT_EGRESS_ALLOWLIST],
      limits: parsed.limits
    };

    const observation = await this.isolation.execute(request, { signal });
    return outcomeFromObservation(observation);
  }
}

function outcomeFromObservation(observation: EngineIsolationObservation): EngineOutcome {
  if (observation.outcome === "timed_out") {
    return { status: "timeout", durationMs: observation.durationMs };
  }
  if (observation.outcome === "cancelled") {
    return { status: "cancelled", durationMs: observation.durationMs };
  }
  if (observation.outcome === "exited" && observation.exitCode !== null) {
    return {
      status: "completed",
      exitCode: observation.exitCode,
      stdout: observation.stdout,
      stderr: observation.stderr,
      durationMs: observation.durationMs,
      stdoutTruncated: observation.stdoutTruncated,
      stderrTruncated: observation.stderrTruncated
    };
  }
  return {
    status: "process_error",
    message: observation.error ?? `engine isolation reported an unexpected outcome: ${observation.outcome}`
  };
}

function resolveOnPath(name: string): string {
  const searchPath = process.env.PATH ?? "";
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep searching the rest of PATH.
    }
  }
  throw new ControlStackError("engine_binary_not_found", `unable to resolve "${name}" on PATH`);
}
