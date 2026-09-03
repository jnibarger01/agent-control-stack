import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * The ACS <-> Codex Swarm boundary (ADR 0017).
 *
 * `ExecutionEnvelope` is the ONLY authority context Codex Swarm receives when
 * ACS launches it. It is immutable, tamper-evident (`envelopeHash`), and bound
 * to exactly one ACS attempt by a per-attempt HMAC (`mac`). Codex Swarm returns
 * a `SwarmExecutionEvidence` - execution evidence, never an authoritative
 * success claim. There is deliberately no `succeeded` / `approved` / `promoted`
 * field on the evidence: ACS derives the terminal outcome itself from
 * independent validation and verification.
 *
 * Both this module and `codex-swarm/src/acs/envelope.ts` implement the same
 * wire contract. Codex Swarm has no zod dependency, so its copy is a
 * hand-rolled fail-closed parser kept in sync via shared fixtures.
 */

export const CODEX_SWARM_ENVELOPE_SCHEMA_VERSION = "acs.codex-swarm-envelope.v1" as const;
export const CODEX_SWARM_EVIDENCE_SCHEMA_VERSION = "acs.codex-swarm-evidence.v1" as const;
export const CODEX_SWARM_ENVELOPE_HASH_DOMAIN = "acs:codex-swarm-envelope:v1" as const;
export const CODEX_SWARM_ENGINE_ID = "codex-swarm" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const gitRevisionSchema = z.string().min(7).max(256);

/** `none`, or `scoped-egress:<sha256 of the sorted "host:port" allowlist>`. */
export const codexSwarmNetworkPolicySchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value === "none" || /^scoped-egress:[a-f0-9]{64}$/u.test(value),
    "networkPolicy must be 'none' or 'scoped-egress:<64-hex>'"
  );

/**
 * A shell command Codex Swarm is permitted to run as a lane acceptance or
 * validation step, as an already-split argv (no shell string interpolation).
 */
const commandSchema = z.array(z.string().min(1).max(8_192)).min(1).max(64);

function expiresAfterIssued(value: { issuedAt: string; expiresAt: string }, context: z.RefinementCtx): void {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after issuedAt"
    });
  }
}

/**
 * The envelope body as a plain strict object (no cross-field refinement), so it
 * can be `.extend`ed for the full envelope. `executionEnvelopeBodySchema` below
 * adds the refinement for standalone parsing.
 */
const executionEnvelopeBodyObjectSchema = z
  .object({
    schemaVersion: z.literal(CODEX_SWARM_ENVELOPE_SCHEMA_VERSION),

    // Attempt binding - the whole point of the envelope.
    acsWorkItemId: identifierSchema,
    acsAttemptId: identifierSchema,
    planId: identifierSchema,
    admittedPlanHash: hash64,
    leaseId: identifierSchema,
    fencingEpoch: z.number().int().positive(),
    auditCorrelationId: identifierSchema,
    idempotencyKey: identifierSchema,

    // Where Codex Swarm may work, and against what base.
    workspace: z
      .object({
        allocationId: identifierSchema,
        hostPath: z.string().min(1).max(4_096),
        expectedBaseSha: gitRevisionSchema
      })
      .strict(),

    // What to do, and the bounds it may only narrow.
    objective: z.string().min(1).max(8_000),
    permittedPaths: z.array(z.string().min(1).max(4_096)).max(4_096),
    forbiddenPaths: z.array(z.string().min(1).max(4_096)).max(4_096),
    permittedOwnerProfiles: z.array(identifierSchema).min(1).max(16),
    maxLanes: z.number().int().positive().max(64),
    maxLoopIterations: z.number().int().nonnegative().max(64),
    networkPolicy: codexSwarmNetworkPolicySchema,
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    acceptanceCommands: z.array(commandSchema).max(64),
    validationCommands: z.array(commandSchema).max(64),
    evidenceRequirements: z.array(identifierSchema).max(64),

    // Freshness.
    issuedAt: timestampSchema,
    expiresAt: timestampSchema
  })
  .strict();

/** The envelope body with its cross-field invariant, for standalone parsing. */
export const executionEnvelopeBodySchema = executionEnvelopeBodyObjectSchema.superRefine(expiresAfterIssued);

export type ExecutionEnvelopeBody = z.infer<typeof executionEnvelopeBodyObjectSchema>;

export const executionEnvelopeSchema = executionEnvelopeBodyObjectSchema
  .extend({
    /** `domainHash(CODEX_SWARM_ENVELOPE_HASH_DOMAIN, body)` - integrity, no key. */
    envelopeHash: hash64,
    /** `HMAC-SHA256(perAttemptSecret, canonicalJson(body-with-envelopeHash))` - authenticity. */
    mac: hash64
  })
  .strict()
  .superRefine(expiresAfterIssued);

export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;

// ── evidence (Codex Swarm -> ACS) ──────────────────────────────────────────

const footprintViolationSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    reason: z.string().min(1).max(256)
  })
  .strict();

const commandResultSchema = z
  .object({
    command: z.string().min(1).max(16_000),
    exitCode: z.number().int(),
    outputTail: z.string().max(64_000)
  })
  .strict();

export const swarmLaneResultSchema = z
  .object({
    laneId: identifierSchema,
    ownerProfile: identifierSchema,
    transportId: z.string().min(1).max(128),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    workerRunStatus: z.enum(["completed", "timeout", "spawn-error"]),
    baseSha: gitRevisionSchema,
    headSha: gitRevisionSchema,
    headTreeSha: gitRevisionSchema.nullable(),
    commits: z.array(z.string().min(1).max(256)).max(4_096),
    filesChanged: z.array(z.string().min(1).max(4_096)).max(10_000),
    footprintResult: z
      .object({
        ok: z.boolean(),
        violations: z.array(footprintViolationSchema).max(10_000)
      })
      .strict(),
    acceptanceResults: z.array(commandResultSchema).max(64),
    validationResults: z.array(commandResultSchema).max(64),
    gateVerdict: z.enum(["PASS", "PASS_WITH_CONCERNS", "BLOCKED", "FAIL"]),
    secretScanResult: z
      .object({
        clean: z.boolean(),
        findingCount: z.number().int().nonnegative(),
        coverageNotes: z.array(z.string().min(1).max(2_000)).max(256)
      })
      .strict(),
    blockers: z.array(z.string().min(1).max(4_000)).max(64),
    warnings: z.array(z.string().min(1).max(4_000)).max(256)
  })
  .strict();

export type SwarmLaneResult = z.infer<typeof swarmLaneResultSchema>;

export const swarmExecutionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(CODEX_SWARM_EVIDENCE_SCHEMA_VERSION),

    // Echoed authority context - ACS rejects the result if any of these do not
    // match the envelope it issued.
    acsAttemptId: identifierSchema,
    envelopeHash: hash64,
    leaseId: identifierSchema,
    fencingEpoch: z.number().int().positive(),

    exitStatus: z.enum(["completed", "timeout", "cancelled", "spawn_error"]),
    startedAt: timestampSchema,
    endedAt: timestampSchema,

    laneResults: z.array(swarmLaneResultSchema).max(64),

    integration: z
      .object({
        integrationBranch: z.string().min(1).max(256),
        integratedHeadSha: gitRevisionSchema,
        integratedTreeSha: gitRevisionSchema,
        topologicalOrder: z.array(identifierSchema).max(64),
        overlaps: z
          .array(
            z
              .object({
                a: identifierSchema,
                b: identifierSchema,
                paths: z.array(z.string().min(1).max(4_096)).max(10_000)
              })
              .strict()
          )
          .max(4_096)
      })
      .strict()
      .nullable(),

    aggregateVerdict: z.enum(["PASS", "PASS_WITH_CONCERNS", "BLOCKED", "FAIL"]),
    swarmInternalRecommendationIdentity: z.string().min(1).max(256).nullable(),
    loopIterationsRun: z.number().int().nonnegative().max(64),
    loopStopReason: z.string().min(1).max(256).nullable(),

    evidenceBundle: z
      .object({
        auditEventCount: z.number().int().nonnegative(),
        auditLogHash: hash64,
        diffHash: hash64
      })
      .strict()
  })
  .strict();

export type SwarmExecutionEvidence = z.infer<typeof swarmExecutionEvidenceSchema>;

// ── hashing + MAC ─────────────────────────────────────────────────────────

/** Integrity hash over the envelope body (everything except `envelopeHash`/`mac`). */
export function executionEnvelopeHash(body: ExecutionEnvelopeBody): string {
  return domainHash(CODEX_SWARM_ENVELOPE_HASH_DOMAIN, executionEnvelopeBodySchema.parse(body));
}

function envelopeMac(bodyWithHash: Omit<ExecutionEnvelope, "mac">, secret: string): string {
  if (secret.length < 32) {
    throw new TypeError("codex-swarm envelope MAC secret must be at least 32 characters");
  }
  return createHmac("sha256", secret).update(canonicalJson(bodyWithHash)).digest("hex");
}

export type BuildExecutionEnvelopeInput = Omit<ExecutionEnvelopeBody, "schemaVersion">;

/**
 * Assemble a full, signed envelope. `secret` is the per-attempt MAC key ACS
 * hands to the Codex Swarm child process out of band (never on the wire, never
 * logged).
 */
export function buildExecutionEnvelope(input: BuildExecutionEnvelopeInput, secret: string): ExecutionEnvelope {
  const body = executionEnvelopeBodySchema.parse({
    schemaVersion: CODEX_SWARM_ENVELOPE_SCHEMA_VERSION,
    ...input
  });
  const envelopeHash = executionEnvelopeHash(body);
  const bodyWithHash = { ...body, envelopeHash };
  return executionEnvelopeSchema.parse({
    ...bodyWithHash,
    mac: envelopeMac(bodyWithHash, secret)
  });
}

export type VerifyExecutionEnvelopeResult =
  | { ok: true; envelope: ExecutionEnvelope }
  | { ok: false; reason: string };

export interface VerifyExecutionEnvelopeOptions {
  /** The `acsAttemptId` the caller expects this envelope to be bound to. */
  expectedAttemptId?: string;
  now?: () => Date;
}

/**
 * Fail-closed envelope verification. Every "no" path returns
 * `{ ok: false, reason }`; there is no default-accept. Checks, in order:
 * shape, integrity hash, MAC (constant-time), expiry, and - when supplied -
 * attempt binding.
 */
export function verifyExecutionEnvelope(
  value: unknown,
  secret: string,
  options: VerifyExecutionEnvelopeOptions = {}
): VerifyExecutionEnvelopeResult {
  const parsed = executionEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `envelope_schema_invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  const envelope = parsed.data;
  const { envelopeHash, mac, ...body } = envelope;

  if (executionEnvelopeHash(body) !== envelopeHash) {
    return { ok: false, reason: "envelope_hash_mismatch" };
  }

  let expectedMac: string;
  try {
    expectedMac = envelopeMac({ ...body, envelopeHash }, secret);
  } catch (error) {
    return { ok: false, reason: `envelope_mac_secret_invalid: ${(error as Error).message}` };
  }
  const presented = Buffer.from(mac, "hex");
  const expected = Buffer.from(expectedMac, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "envelope_mac_mismatch" };
  }

  const now = (options.now ?? (() => new Date()))().getTime();
  if (Date.parse(envelope.expiresAt) <= now) {
    return { ok: false, reason: "envelope_expired" };
  }

  if (options.expectedAttemptId !== undefined && envelope.acsAttemptId !== options.expectedAttemptId) {
    return { ok: false, reason: "envelope_attempt_mismatch" };
  }

  return { ok: true, envelope };
}

/**
 * Fail-closed check that a returned evidence document belongs to the envelope
 * ACS issued. Does not judge success - only identity.
 */
export function evidenceMatchesEnvelope(
  evidence: SwarmExecutionEvidence,
  envelope: ExecutionEnvelope
): { ok: true } | { ok: false; reason: string } {
  if (evidence.acsAttemptId !== envelope.acsAttemptId) return { ok: false, reason: "evidence_attempt_mismatch" };
  if (evidence.envelopeHash !== envelope.envelopeHash) return { ok: false, reason: "evidence_envelope_hash_mismatch" };
  if (evidence.leaseId !== envelope.leaseId) return { ok: false, reason: "evidence_lease_mismatch" };
  if (evidence.fencingEpoch !== envelope.fencingEpoch) return { ok: false, reason: "evidence_fencing_mismatch" };
  return { ok: true };
}
