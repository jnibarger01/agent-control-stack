import { createHash, randomBytes } from "node:crypto";
import { ControlStackError } from "@agent-control-stack/shared";
import type { EngineIsolation, EngineIsolationAuthorityVerifier, EngineIsolationObservation } from "@agent-control-stack/sandbox";
import {
  buildExecutionEnvelope,
  evidenceMatchesEnvelope,
  verifyExecutionEnvelope,
  type ExecutionEnvelope,
  type SwarmExecutionEvidence,
  type VerifyExecutionEnvelopeResult,
} from "./codex-swarm-envelope.js";
import type { EngineAdapter, EngineOutcome, EngineTask } from "./types.js";

export const CODEX_SWARM_ENGINE_ID = "codex-swarm" as const;
export const CODEX_SWARM_CONTROL_PLANE_ENV = "SWARM_CONTROL_PLANE" as const;
export const CODEX_SWARM_CONTROL_PLANE_ACS = "acs" as const;
export const CODEX_SWARM_ISOLATION_PROFILE = "codex-swarm-v1" as const;
export const CODEX_SWARM_ACS_V1_SOCKET_PATH = "/acs/v1" as const; // logical per-attempt transport endpoint (actual path is attempt-scoped)

export type CodexSwarmRolloutGuard = (input: { task: EngineTask; envelope: ExecutionEnvelope }) => void | Promise<void>;

/** Per-attempt /acs/v1 transport (Unix socket). ACS owns the socket and the OOB MAC secret. */
export interface CodexSwarmAcsTransport {
  /** Execute an ACS-issued envelope and return execution evidence. Must be attempt-bound and fail-closed. */
  execute(input: {
    task: EngineTask;
    envelope: ExecutionEnvelope;
    /** Per-attempt MAC secret; must never be logged or persisted. */
    secret: string;
    signal?: AbortSignal;
  }): Promise<SwarmExecutionEvidence>;
}

export interface CodexSwarmEngineAdapterOptions {
  /** Optional authority verifier for sandbox/isolation integration (when process-backed transport is used). */
  authorityVerifier?: EngineIsolationAuthorityVerifier;
  /** Optional isolation backend/profile enforcement hook. */
  isolationFactory?: (options: { authorityVerifier: EngineIsolationAuthorityVerifier }) => EngineIsolation;
  /** Required governed /acs/v1 transport implementation. */
  transport: CodexSwarmAcsTransport;
  /** Generates a per-attempt MAC secret (>=32 chars). Caller/ACS must deliver it OOB and scrub child env. */
  secretFactory?: () => string;
  /** Rollout guard; must refuse when codex-swarm-v1 profile/production prerequisites are not satisfied. */
  rolloutGuard?: CodexSwarmRolloutGuard;
  /** Default objective/bounds source; in production this comes from admitted plan/execution context. */
  defaults?: {
    permittedPaths?: string[];
    forbiddenPaths?: string[];
    permittedOwnerProfiles?: string[];
    maxLanes?: number;
    maxLoopIterations?: number;
    networkPolicy?: "none" | `scoped-egress:${string}`;
    timeoutMs?: number;
    acceptanceCommands?: string[][];
    validationCommands?: string[][];
    evidenceRequirements?: string[];
  };
}

function requireAcsControlPlaneMode(): void {
  const mode = process.env[CODEX_SWARM_CONTROL_PLANE_ENV];
  if (mode !== CODEX_SWARM_CONTROL_PLANE_ACS) {
    throw new ControlStackError(
      "codex_swarm_control_plane_not_acs",
      `Refusing codex-swarm execution: ${CODEX_SWARM_CONTROL_PLANE_ENV} must be '${CODEX_SWARM_CONTROL_PLANE_ACS}' (fail-closed).`,
    );
  }
}

function defaultRolloutGuard(input: { task: EngineTask; envelope: ExecutionEnvelope }): void {
  requireAcsControlPlaneMode();
  // Isolation profile containment is a hard prerequisite for production execution (ADR 0017).
  // Until a verified codex-swarm-v1 profile is proven for this runtime, refuse.
  const profileVerified = process.env.CODEX_SWARM_V1_PROFILE_VERIFIED === "1";
  if (!profileVerified) {
    throw new ControlStackError(
      "codex_swarm_isolation_profile_unverified",
      `Refusing codex-swarm execution: required isolation profile '${CODEX_SWARM_ISOLATION_PROFILE}' is not verified/available.`,
    );
  }
}

function toOutcome(evidence: SwarmExecutionEvidence, startedAtMs: number): EngineOutcome {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  switch (evidence.exitStatus) {
    case "completed":
      return {
        status: "completed",
        exitCode: 0,
        stdout: JSON.stringify({ schemaVersion: evidence.schemaVersion, acsAttemptId: evidence.acsAttemptId, aggregateVerdict: evidence.aggregateVerdict }),
        stderr: "",
        durationMs,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    case "timeout":
      return { status: "timeout", durationMs };
    case "cancelled":
      return { status: "cancelled", durationMs };
    case "spawn_error":
      return { status: "process_error", message: "codex-swarm subordinate execution reported spawn_error (see evidence)" };
    default:
      return { status: "process_error", message: `unknown codex-swarm exitStatus: ${String((evidence as any).exitStatus)}` };
  }
}

/**
 * Codex Swarm subordinate execution engine adapter (ADR 0017).
 * Authority remains in ACS (ExecutionController/leases/approvals/validation/publication);
 * this adapter binds and conveys an ExecutionEnvelope over /acs/v1 and returns process/evidence outcome only.
 */
export class CodexSwarmEngineAdapter implements EngineAdapter {
  readonly id = CODEX_SWARM_ENGINE_ID;
  private readonly opts: CodexSwarmEngineAdapterOptions;

  constructor(opts: CodexSwarmEngineAdapterOptions) {
    this.opts = opts;
  }

  private buildEnvelope(task: EngineTask, secret: string): ExecutionEnvelope {
    const d = this.opts.defaults ?? {};
    // Envelope is attempt-bound authority context; fields sourced from task/bounds where available.
    return buildExecutionEnvelope(
      {
        acsWorkItemId: task.workItemId,
        acsAttemptId: task.attemptId,
        planId: task.attemptId, // caller should supply admitted plan id/hash via extended task context in future
        admittedPlanHash: task.authorization.hash,
        leaseId: task.leaseId,
        fencingEpoch: task.fencingToken,
        auditCorrelationId: task.auditCorrelationId,
        idempotencyKey: task.idempotencyKey,
        workspace: {
          allocationId: task.workspace.allocationId,
          hostPath: task.workspace.hostPath,
          expectedBaseSha: createHash("sha256").update("unknown").digest("hex").slice(0, 40), // must be provided by governed caller
        },
        objective: task.prompt,
        permittedPaths: d.permittedPaths ?? [],
        forbiddenPaths: d.forbiddenPaths ?? [],
        permittedOwnerProfiles: d.permittedOwnerProfiles ?? ["codex"],
        maxLanes: d.maxLanes ?? 1,
        maxLoopIterations: d.maxLoopIterations ?? 0,
        networkPolicy: d.networkPolicy ?? "none",
        timeoutMs: d.timeoutMs ?? Math.min(task.limits.wallClockMs, 24 * 60 * 60 * 1000),
        acceptanceCommands: d.acceptanceCommands ?? [],
        validationCommands: d.validationCommands ?? [],
        evidenceRequirements: d.evidenceRequirements ?? [],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + Math.min(task.limits.wallClockMs, 60 * 60 * 1000)).toISOString(),
      },
      secret,
    );
  }

  async invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome> {
    requireAcsControlPlaneMode();
    const startedAtMs = Date.now();
    const secret = (this.opts.secretFactory ?? (() => randomBytes(32).toString("hex")))();
    if (secret.length < 32) {
      return { status: "process_error", message: "codex-swarm per-attempt MAC secret must be >= 32 chars" };
    }

    let envelope: ExecutionEnvelope;
    try {
      envelope = this.buildEnvelope(task, secret);
    } catch (e) {
      return { status: "process_error", message: `failed to build/verify execution envelope: ${(e as Error).message}` };
    }

    const guard = this.opts.rolloutGuard ?? defaultRolloutGuard;
    try {
      await guard({ task, envelope });
    } catch (e) {
      return { status: "process_error", message: `codex-swarm rollout/guard refused: ${(e as Error).message}` };
    }

    let evidence: SwarmExecutionEvidence;
    try {
      evidence = await this.opts.transport.execute({ task, envelope, secret, signal });
    } catch (e) {
      if (signal?.aborted) return { status: "cancelled", durationMs: Math.max(0, Date.now() - startedAtMs) };
      return { status: "process_error", message: `codex-swarm /acs/v1 transport failed: ${(e as Error).message}` };
    }

    const match = evidenceMatchesEnvelope(evidence, envelope);
    if (!match.ok) {
      return { status: "process_error", message: `codex-swarm evidence does not match issued envelope: ${match.reason}` };
    }

    // Outcome is process/evidence delivery only; ACS owns validation/acceptance/publication.
    return toOutcome(evidence, startedAtMs);
  }
}

/** Helper: fail-closed envelope verification for callers that hold the OOB secret. */
export function verifyIssuedEnvelope(
  envelope: unknown,
  secret: string,
  expectedAttemptId?: string,
): VerifyExecutionEnvelopeResult {
  return verifyExecutionEnvelope(envelope, secret, expectedAttemptId ? { expectedAttemptId } : {});
}

export { evidenceMatchesEnvelope, type ExecutionEnvelope, type SwarmExecutionEvidence };
