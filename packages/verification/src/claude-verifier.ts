import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  createEngineIsolation,
  type EngineIsolation,
  type EngineIsolationAuthorityVerifier,
  type EngineIsolationRequest,
  type EngineRuntimeMount
} from "@agent-control-stack/sandbox";
import {
  verificationResultSchema,
  type CommandEvidence,
  type Verifier,
  type VerificationCriterion,
  type VerificationEvidence,
  type VerificationResult
} from "./types.js";

const DEFAULT_CREDENTIAL_ENV_NAME = "ANTHROPIC_API_KEY";
const DEFAULT_EGRESS_ALLOWLIST = [{ host: "api.anthropic.com", port: 443 }] as const;

export interface ClaudeVerifierOptions {
  binaryPath?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** ACS-operator-trusted authority source - never derived from evidence input. */
  authorityVerifier: EngineIsolationAuthorityVerifier;
  /**
   * The verifier reads evidence over stdin and never touches a repository
   * (--tools "" below disables tool use entirely), so it needs only a
   * throwaway scratch allocation, not the work item's real workspace - but
   * that allocation is still authority-verified, never a caller-supplied
   * path, exactly like the workspace an engine writes into.
   */
  scratchWorkspace: { allocationId: string; hostPath: string };
  runtimeMounts?: EngineRuntimeMount[];
  credentialEnvName?: string;
  credentialSource?: (envName: string) => string | undefined;
  isolationFactory?: (options: {
    authorityVerifier: EngineIsolationAuthorityVerifier;
    runtimeMounts?: EngineRuntimeMount[];
  }) => EngineIsolation;
}

const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier. You did not produce the change under review and have no memory of producing it.

Evaluate only the supplied criteria and evidence. Evidence includes command
results (exit codes, stdout, stderr) that were captured by the harness, not
self-reported by the implementer - trust the command results over the
implementer's own claim about what happened when they disagree. If the
evidence is insufficient to judge a criterion either way, mark that
criterion unsatisfied and explain why in "observed" rather than guessing.

Return exactly one JSON object matching the required schema. No prose
outside the JSON. Do not request or infer the implementer's reasoning,
hidden state, or intentions - judge only what the evidence shows happened.`;

const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    summary: { type: "string" },
    criteriaResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterionId: { type: "string" },
          satisfied: { type: "boolean" },
          observed: { type: "string" }
        },
        required: ["criterionId", "satisfied", "observed"]
      }
    }
  },
  required: ["verdict", "summary", "criteriaResults"]
} as const;

export function buildClaudeVerifierArgs(model: string, maxBudgetUsd: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--system-prompt",
    VERIFIER_SYSTEM_PROMPT,
    "--json-schema",
    JSON.stringify(RESULT_JSON_SCHEMA)
  ];
}

interface ClaudeCliEnvelope {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
}

let verifierInvocationCounter = 0;

/**
 * Renders a verdict from evidence via a single, non-interactive, tools-
 * disabled Claude CLI call (--tools "" --permission-mode plan) run inside
 * packages/sandbox's EngineIsolationBackend (ADR 0014) - the same isolation
 * boundary as CodexEngineAdapter: private HOME, one injected credential,
 * network scoped to api.anthropic.com through an audited proxy, full
 * process-tree containment. This engine only ever reads evidence and
 * judges it (it never touches the filesystem or runs commands), which is
 * exactly the shape an independent verifier needs and the implementer
 * engine explicitly must not have.
 *
 * Binding this invocation to the exact plan/action/attempt/workspace being
 * verified (beyond the workItemId already carried in VerificationEvidence)
 * is a separate, tracked hardening item - this class establishes the
 * isolation boundary; it does not yet re-derive engine provenance from
 * trusted configuration for arbitrary Verifier implementations.
 */
export class ClaudeVerifier implements Verifier {
  readonly engineId = "claude-cli-verifier" as const;
  private readonly binaryPath: string;
  private readonly model: string;
  private readonly maxBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly credentialEnvName: string;
  private readonly credentialSource: (envName: string) => string | undefined;
  private readonly scratchWorkspace: { allocationId: string; hostPath: string };
  private readonly isolation: EngineIsolation;

  constructor(options: ClaudeVerifierOptions) {
    this.binaryPath = options.binaryPath ?? resolveOnPath("claude");
    this.model = options.model ?? "claude-sonnet-5";
    this.maxBudgetUsd = options.maxBudgetUsd ?? 0.5;
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 1_000;
    this.credentialEnvName = options.credentialEnvName ?? DEFAULT_CREDENTIAL_ENV_NAME;
    this.credentialSource = options.credentialSource ?? ((envName) => process.env[envName]);
    this.scratchWorkspace = options.scratchWorkspace;
    const factory = options.isolationFactory ?? createEngineIsolation;
    this.isolation = factory({ authorityVerifier: options.authorityVerifier, runtimeMounts: options.runtimeMounts });
  }

  async verify(criteria: VerificationCriterion[], evidence: VerificationEvidence): Promise<VerificationResult> {
    const started = Date.now();
    const prompt = buildVerificationPrompt(criteria, evidence);
    const credentialValue = this.credentialSource(this.credentialEnvName);
    if (!credentialValue) {
      throw new ControlStackError(
        "verifier_credential_unavailable",
        `no value available for required credential ${this.credentialEnvName}`
      );
    }

    verifierInvocationCounter += 1;
    const suffix = `${evidence.workItemId}-${verifierInvocationCounter}`.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(-100);
    const request: EngineIsolationRequest = {
      schemaVersion: "acs.engine-isolation.v1",
      workItemId: evidence.workItemId,
      attemptId: `verify-${suffix}`,
      leaseId: `verify-${suffix}`,
      workerId: "claude-cli-verifier",
      fencingToken: verifierInvocationCounter,
      authorization: { kind: "action", hash: "0".repeat(64) },
      policyVersion: "verifier-v1",
      auditCorrelationId: `verify-${suffix}`,
      idempotencyKey: `verify-${suffix}`,
      workspace: this.scratchWorkspace,
      engineId: this.engineId,
      executable: this.binaryPath,
      args: buildClaudeVerifierArgs(this.model, this.maxBudgetUsd),
      cwd: ".",
      stdin: prompt,
      credential: { envName: this.credentialEnvName, envValue: credentialValue },
      network: "scoped-egress",
      egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
      limits: {
        wallClockMs: this.timeoutMs,
        terminationGraceMs: Math.min(5_000, Math.max(100, Math.floor(this.timeoutMs / 10))),
        cpuQuotaPercent: 100,
        memoryBytes: 512 * 1_024 * 1_024,
        pids: 32,
        outputBytes: 256 * 1_024,
        tmpfsBytes: 32 * 1_024 * 1_024
      }
    };

    const observation = await this.isolation.execute(request);
    if (observation.outcome === "timed_out") {
      throw new ControlStackError("verifier_timeout", `verifier timed out after ${this.timeoutMs}ms`);
    }
    if (observation.outcome !== "exited" || observation.exitCode !== 0) {
      throw new ControlStackError(
        "verifier_process_failed",
        observation.error ?? `verifier exited with outcome ${observation.outcome}`
      );
    }

    const parsed = parseClaudeEnvelope(observation.stdout);
    const judged = JSON.parse(parsed) as unknown;
    return verificationResultSchema.parse({
      ...(judged as Record<string, unknown>),
      verifierEngineId: this.engineId,
      durationMs: Date.now() - started
    });
  }
}

function buildVerificationPrompt(criteria: VerificationCriterion[], evidence: VerificationEvidence): string {
  return JSON.stringify({
    criteria,
    implementerClaim: evidence.implementerClaim,
    diffSummary: evidence.diffSummary,
    commandResults: evidence.commandResults satisfies CommandEvidence[]
  });
}

function parseClaudeEnvelope(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI returned invalid JSON");
  }
  const envelope = value as ClaudeCliEnvelope;
  if (envelope.type !== "result" || typeof envelope.subtype !== "string" || typeof envelope.is_error !== "boolean") {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI result is missing envelope fields");
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new ControlStackError("verifier_invalid_response", `verifier CLI call did not succeed (${envelope.subtype})`);
  }
  if (typeof envelope.result !== "string") {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI result is missing the result field");
  }
  return envelope.result;
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
  throw new ControlStackError("verifier_binary_not_found", `unable to resolve "${name}" on PATH`);
}
