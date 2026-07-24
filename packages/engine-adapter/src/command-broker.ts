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
import type { CommandAuthority } from "@agent-control-stack/work-items";
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
 * A store dependency narrow enough that CommandBroker doesn't need the
 * entire WorkItemStore surface - just the one authoritative, joined lookup
 * (attempt + lease + workspace allocation, all currently active and
 * mutually consistent) it needs to gate execution on.
 */
export interface CommandAuthorityStore {
  getCommandAuthority(input: {
    workItemId: string;
    attemptId: string;
    leaseId: string;
    workerId: string;
    fencingToken: number;
    workspaceAllocationId: string;
  }): CommandAuthority | undefined;
}

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
 * The authority verifier loads its receipt from `store.getCommandAuthority`
 * - a real, persisted, trigger-enforced (storage/migrations/006 and 007)
 * attempt/lease/workspace-allocation record - not merely an echo of the
 * caller's own claims. A request whose attempt, lease, worker, fencing
 * token, or workspace allocation does not match a currently-active,
 * unexpired, mutually-consistent persisted record is refused before the
 * sandbox ever launches a process. The canonical workspace path the
 * sandbox trusts comes from that persisted record, not from the request,
 * so a caller cannot substitute a different host path merely by claiming
 * the right allocation id.
 */
export interface CommandBrokerOptions {
  store: CommandAuthorityStore;
  sandbox?: SandboxBackend;
  /** Defaults to the real policy-gate evaluator. Overridable for testing only. */
  evaluate?: (context: PolicyContext) => PolicyDecision;
}

export class CommandBroker {
  private readonly sandbox: SandboxBackend;
  private readonly evaluate: (context: PolicyContext) => PolicyDecision;

  constructor(options: CommandBrokerOptions) {
    this.sandbox = options.sandbox ?? createLinuxSandbox({ authorityVerifier: storeBackedVerifier(options.store) });
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
 * Loads authority from the store (not the request) and rejects anything
 * that does not resolve to a currently-active, unexpired, mutually-
 * consistent attempt/lease/workspace-allocation triple - see
 * packages/work-items's getCommandAuthority for the exact join and its
 * matching database triggers for what "currently-active" is allowed to
 * mean. Re-checked on every execute() call (immediately before the sandbox
 * launches), not cached from an earlier point in the request's lifecycle,
 * so a lease that expires or is revoked between policy evaluation and
 * process launch is refused rather than honored.
 */
export function storeBackedVerifier(store: CommandAuthorityStore): SandboxAuthorityVerifier {
  return {
    async verify(request: SandboxExecutionRequest): Promise<SandboxAuthorityReceipt> {
      const authority = store.getCommandAuthority({
        workItemId: request.workItemId,
        attemptId: request.attemptId,
        leaseId: request.leaseId,
        workerId: request.workerId,
        fencingToken: request.fencingToken,
        workspaceAllocationId: request.workspace.allocationId
      });
      if (!authority) {
        throw new ControlStackError(
          "command_authority_not_found",
          "no active, matching, unexpired lease/attempt/workspace-allocation was found for this request"
        );
      }
      if (authority.lease.policyVersion !== request.policyVersion) {
        throw new ControlStackError(
          "command_authority_mismatch",
          "request policy version does not match the persisted lease"
        );
      }

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
        // Rooted in the persisted allocation record, never in the caller's
        // own claim - this is what defeats a workspace-substitution attempt
        // even when every identifier otherwise lines up.
        canonicalWorkspacePath: authority.workspaceAllocation.hostPath,
        // verifyAuthorityReceipt requires this to equal the request's own
        // auditCorrelationId, not a freshly generated id - the receipt is
        // confirming authority for *this* request's already-recorded audit
        // intent, not minting a new one.
        executionEvent: {
          id: request.auditCorrelationId,
          sequence: 1,
          hash: request.authorization.hash
        }
      };
      return verifyAuthorityReceipt(request, receipt);
    }
  };
}

export { ControlStackError };
