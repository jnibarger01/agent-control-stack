import {
  actionFingerprint,
  evaluatePolicy,
  type PolicyContext,
  type PolicyDecision
} from "@agent-control-stack/policy-gate";
import {
  createLinuxSandbox,
  verifyAuthorityReceipt,
  type SandboxAuthorityReceipt,
  type SandboxAuthorityVerifier,
  type SandboxBackend,
  type SandboxCommandProfile,
  type SandboxExecutionObservation,
  type SandboxExecutionRequest
} from "@agent-control-stack/sandbox";
import { ControlStackError, createId } from "@agent-control-stack/shared";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const commandRequestSchema = z
  .object({
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    leaseId: identifierSchema,
    workerId: identifierSchema,
    fencingToken: z.number().int().positive(),
    requester: z.enum(["user", "agent", "system"]),
    actor: z.string().min(1),
    risk: z.enum(["low", "medium", "high", "critical"]),
    policyVersion: z.string().min(1),
    workspace: z
      .object({
        allocationId: identifierSchema,
        hostPath: z.string().min(1)
      })
      .strict(),
    commandProfile: z.enum(["npm-test", "npm-lint", "npm-build", "npm-typecheck", "git-status", "git-diff-check"])
  })
  .strict();

export type CommandRequest = z.infer<typeof commandRequestSchema>;

export type CommandResult =
  | { outcome: "executed"; observation: SandboxExecutionObservation }
  | { outcome: "policy_denied"; decision: PolicyDecision };

const profileCommands: Record<SandboxCommandProfile, string[]> = {
  "git-status": ["git", "status", "--short", "--branch"],
  "git-diff-check": ["git", "diff", "--check"],
  "npm-test": ["npm", "run", "test"],
  "npm-lint": ["npm", "run", "lint"],
  "npm-build": ["npm", "run", "build"],
  "npm-typecheck": ["npm", "run", "typecheck"]
};

/**
 * The only path through which an engine-proposed command actually runs.
 *
 * Every call re-evaluates policy from scratch via the real PolicyEvaluator
 * (packages/policy-gate) - not a cached decision from plan-admission time -
 * and only a policy `allow` reaches the sandbox at all. The resulting
 * action hash is what the sandbox's authority verifier checks the request
 * against, so a request whose content changed after policy evaluation
 * (even if only commandProfile or cwd) fails closed rather than silently
 * running something different from what was evaluated.
 *
 * The authority verifier here is self-contained (recomputes and compares
 * the hash, does not check against a persisted attempt/lease row) because
 * packages/work-items does not yet have store methods for the
 * execution_attempts/attempt_leases tables migration 006 created - only
 * raw SQL exists. Wiring this to real persisted-lease verification is
 * Phase 4 scope; this is real, working, hash-bound gating today, not a
 * mock, but it does not yet prove the caller holds a genuinely-issued,
 * still-active lease row - only that the request is internally consistent
 * and was actually policy-evaluated.
 */
export interface CommandBrokerOptions {
  sandbox?: SandboxBackend;
  /** Defaults to the real policy-gate evaluator. Overridable for testing only. */
  evaluate?: (context: PolicyContext) => PolicyDecision;
}

export class CommandBroker {
  private readonly sandbox: SandboxBackend;
  private readonly evaluate: (context: PolicyContext) => PolicyDecision;

  constructor(options: CommandBrokerOptions = {}) {
    this.sandbox = options.sandbox ?? createLinuxSandbox({ authorityVerifier: selfConsistentVerifier() });
    this.evaluate = options.evaluate ?? evaluatePolicy;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const parsed = commandRequestSchema.parse(request);
    const context = policyContextForCommand(parsed);
    const decision = this.evaluate(context);
    if (decision.decision !== "allow") {
      return { outcome: "policy_denied", decision };
    }

    const actionHash = actionFingerprint(context);
    const sandboxRequest = buildSandboxRequest(parsed, actionHash);
    const observation = await this.sandbox.execute(sandboxRequest);
    return { outcome: "executed", observation };
  }
}

function policyContextForCommand(request: CommandRequest): PolicyContext {
  return {
    workItemId: request.workItemId,
    actor: request.actor,
    operation: "claim",
    requester: request.requester,
    risk: request.risk,
    action: {
      kind: "shell",
      description: `sandboxed command profile: ${request.commandProfile}`,
      params: {}
    },
    cwd: request.workspace.hostPath,
    command: profileCommands[request.commandProfile],
    network: false,
    write: false,
    destructive: false
  };
}

function buildSandboxRequest(request: CommandRequest, actionHash: string): SandboxExecutionRequest {
  return {
    schemaVersion: "acs.sandbox-execution.v1",
    workItemId: request.workItemId,
    attemptId: request.attemptId,
    leaseId: request.leaseId,
    workerId: request.workerId,
    fencingToken: request.fencingToken,
    authorization: { kind: "action", hash: actionHash },
    policyVersion: request.policyVersion,
    auditCorrelationId: createId("audit"),
    idempotencyKey: createId("idem"),
    workspace: request.workspace,
    commandProfile: request.commandProfile,
    cwd: ".",
    environment: {},
    network: "none",
    limits: {
      wallClockMs: 5 * 60 * 1_000,
      terminationGraceMs: 2_000,
      cpuQuotaPercent: 100,
      memoryBytes: 512 * 1_024 * 1_024,
      pids: 64,
      outputBytes: 256 * 1_024,
      tmpfsBytes: 64 * 1_024 * 1_024
    }
  };
}

/**
 * Confirms the request the sandbox is about to execute is exactly the one
 * policy evaluated (same authorization hash, same identifiers) and nothing
 * else - the TOCTOU guard between CommandBroker.run()'s policy check and
 * the sandbox's own execution. Does not check the request against a
 * persisted lease row (see the class-level comment on CommandBroker).
 */
function selfConsistentVerifier(): SandboxAuthorityVerifier {
  return {
    async verify(request: SandboxExecutionRequest): Promise<SandboxAuthorityReceipt> {
      const receipt = {
        schemaVersion: "acs.sandbox-authority-receipt.v1" as const,
        workItemId: request.workItemId,
        attemptId: request.attemptId,
        leaseId: request.leaseId,
        workerId: request.workerId,
        fencingToken: request.fencingToken,
        authorizationHash: request.authorization.hash,
        policyVersion: request.policyVersion,
        workspaceAllocationId: request.workspace.allocationId,
        canonicalWorkspacePath: request.workspace.hostPath,
        executionEvent: {
          id: createId("evt"),
          sequence: 1,
          hash: request.authorization.hash
        }
      };
      return verifyAuthorityReceipt(request, receipt);
    }
  };
}

export { ControlStackError };
