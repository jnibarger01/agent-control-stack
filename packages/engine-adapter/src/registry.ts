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
import { engineTaskSchema, type EngineAdapter, type EngineOutcome, type EngineTask } from "./types.js";

export interface CliEngineAdapterOptions {
  id: string;
  binaryName: string;
  credentialEnvName: string;
  authorityVerifier: EngineIsolationAuthorityVerifier;
  runtimeMounts?: EngineRuntimeMount[];
  binaryPath?: string;
  credentialSource?: (envName: string) => string | undefined;
  buildArgs?: (prompt: string) => string[];
  isolationFactory?: (options: { authorityVerifier: EngineIsolationAuthorityVerifier; runtimeMounts?: EngineRuntimeMount[] }) => EngineIsolation;
}

const DEFAULT_EGRESS = [{ host: "api.openai.com", port: 443 }] as const;

/** Common provider adapter. The only process boundary is EngineIsolation. */
export class CliEngineAdapter implements EngineAdapter {
  readonly id: string;
  private readonly binaryPath: string;
  private readonly credentialSource: (envName: string) => string | undefined;
  private readonly isolation: EngineIsolation;
  private readonly options: CliEngineAdapterOptions;

  constructor(options: CliEngineAdapterOptions) {
    this.options = options;
    this.id = options.id;
    this.binaryPath = options.binaryPath ?? resolveOnPath(options.binaryName);
    this.credentialSource = options.credentialSource ?? ((name) => process.env[name]);
    this.isolation = (options.isolationFactory ?? createEngineIsolation)({
      authorityVerifier: options.authorityVerifier,
      runtimeMounts: options.runtimeMounts
    });
  }

  async invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome> {
    const parsed = engineTaskSchema.parse(task);
    if (signal?.aborted) throw new ControlStackError("engine_invoke_cancelled", "engine invocation was cancelled before it started");
    const credential = this.credentialSource(this.options.credentialEnvName);
    if (!credential) throw new ControlStackError("engine_credential_unavailable", `no value available for required credential ${this.options.credentialEnvName}`);
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
      args: (this.options.buildArgs ?? ((prompt) => ["-p", prompt]))(parsed.prompt),
      cwd: ".",
      credential: { envName: this.options.credentialEnvName, envValue: credential },
      network: "scoped-egress",
      egressAllowlist: parsed.egressAllowlist.length ? parsed.egressAllowlist : [...DEFAULT_EGRESS],
      limits: parsed.limits
    };
    return outcomeFromObservation(await this.isolation.execute(request, { signal }));
  }
}

export class ClaudeEngineAdapter extends CliEngineAdapter {
  constructor(options: Omit<CliEngineAdapterOptions, "id" | "binaryName" | "credentialEnvName"> & Partial<Pick<CliEngineAdapterOptions, "binaryPath" | "credentialSource">>) {
    super({ ...options, id: "claude", binaryName: "claude", credentialEnvName: "ANTHROPIC_API_KEY" });
  }
}
export class GeminiEngineAdapter extends CliEngineAdapter {
  constructor(options: Omit<CliEngineAdapterOptions, "id" | "binaryName" | "credentialEnvName"> & Partial<Pick<CliEngineAdapterOptions, "binaryPath" | "credentialSource">>) {
    super({ ...options, id: "gemini", binaryName: "gemini", credentialEnvName: "GEMINI_API_KEY" });
  }
}
export class GrokEngineAdapter extends CliEngineAdapter {
  constructor(options: Omit<CliEngineAdapterOptions, "id" | "binaryName" | "credentialEnvName"> & Partial<Pick<CliEngineAdapterOptions, "binaryPath" | "credentialSource">>) {
    super({ ...options, id: "grok", binaryName: "grok", credentialEnvName: "XAI_API_KEY" });
  }
}
export class OpenCodeEngineAdapter extends CliEngineAdapter {
  constructor(options: Omit<CliEngineAdapterOptions, "id" | "binaryName" | "credentialEnvName"> & Partial<Pick<CliEngineAdapterOptions, "binaryPath" | "credentialSource">>) {
    super({ ...options, id: "opencode", binaryName: "opencode", credentialEnvName: "OPENAI_API_KEY" });
  }
}
export class PiEngineAdapter extends CliEngineAdapter {
  constructor(options: Omit<CliEngineAdapterOptions, "id" | "binaryName" | "credentialEnvName"> & Partial<Pick<CliEngineAdapterOptions, "binaryPath" | "credentialSource">>) {
    super({ ...options, id: "pi", binaryName: "pi", credentialEnvName: "OPENAI_API_KEY" });
  }
}

export class EngineAdapterRegistry {
  private readonly adapters = new Map<string, EngineAdapter>();

  constructor(adapters: Iterable<EngineAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EngineAdapter): void {
    if (this.adapters.has(adapter.id)) throw new ControlStackError("engine_adapter_duplicate", `engine adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): EngineAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): EngineAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new ControlStackError("engine_adapter_not_found", `engine adapter is not registered: ${id}`);
    return adapter;
  }
}

function outcomeFromObservation(observation: EngineIsolationObservation): EngineOutcome {
  if (observation.outcome === "timed_out") return { status: "timeout", durationMs: observation.durationMs };
  if (observation.outcome === "cancelled") return { status: "cancelled", durationMs: observation.durationMs };
  if (observation.outcome === "exited" && observation.exitCode !== null) {
    return { status: "completed", exitCode: observation.exitCode, stdout: observation.stdout, stderr: observation.stderr, durationMs: observation.durationMs, stdoutTruncated: observation.stdoutTruncated, stderrTruncated: observation.stderrTruncated };
  }
  return { status: "process_error", message: observation.error ?? `engine isolation reported ${observation.outcome}` };
}

function resolveOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  throw new ControlStackError("engine_binary_not_found", `unable to resolve "${name}" on PATH`);
}
