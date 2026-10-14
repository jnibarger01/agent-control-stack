import { createHash } from "node:crypto";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * Advisor consultation evidence (ADR 0027).
 *
 * This module is the disposition-and-hash view. Guidance text lives in
 * `advisor-guidance.ts` and must not be imported by policy, routing, or approval.
 */

/**
 * v2 binds the hash to the attempt / lease / claim the consultation was fenced to (migration 074).
 * v1 rows (073) do not verify under v2 and therefore never satisfy the completion gate.
 */
export const ADVISOR_CONSULTATION_SCHEMA_VERSION = "acs.advisor-consultation.v2" as const;
export const ADVISOR_CONSULTATION_HASH_DOMAIN = "acs:advisor-consultation:v2" as const;

export const ADVISOR_CHECKPOINTS = ["before_approach", "recurring_failure", "before_completion"] as const;
export type AdvisorCheckpoint = (typeof ADVISOR_CHECKPOINTS)[number];

export const ADVISOR_DISPOSITIONS = ["reviewed", "declined", "unavailable"] as const;
export type AdvisorDisposition = (typeof ADVISOR_DISPOSITIONS)[number];

export const advisorCheckpointSchema = z.enum(ADVISOR_CHECKPOINTS);
export const advisorDispositionSchema = z.enum(ADVISOR_DISPOSITIONS);

const boundedId = z.string().min(1).max(256);

export const advisorConsultRequestSchema = z
  .object({
    checkpoint: advisorCheckpointSchema,
    subject: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("work_item"),
          workItemId: boundedId,
          attemptId: boundedId.optional(),
          leaseId: boundedId,
          /** Proof of lease possession. Required: a worker/lease/epoch tuple alone is guessable or leakable. */
          leaseToken: z.string().min(16).max(512),
          workerId: boundedId,
          fencingEpoch: z.number().int().nonnegative()
        })
        .strict(),
      z
        .object({
          kind: z.literal("mission_unit"),
          missionId: boundedId,
          unitId: boundedId,
          workerId: boundedId,
          claimToken: z.string().min(1).max(256)
        })
        .strict()
    ])
  })
  .strict();

export type AdvisorConsultRequest = z.infer<typeof advisorConsultRequestSchema>;

/** Canonical model ids. Aliases resolve to the current family default. */
export const ADVISOR_MODEL_IDS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1"
] as const;

export type AdvisorModelId = (typeof ADVISOR_MODEL_IDS)[number];

const MODEL_ALIASES: Record<string, AdvisorModelId> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1"
};

const CANNOT_ADVISE = new Set<AdvisorModelId>(["claude-haiku-4-5"]);

const FABLE: AdvisorModelId[] = ["claude-fable-5", "claude-fable-5-1"];
const OPUS_ANY: AdvisorModelId[] = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5"
];
const OPUS_47_OR_LATER: AdvisorModelId[] = ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"];
const OPUS_5_OR_LATER: AdvisorModelId[] = ["claude-opus-5", "claude-opus-5-5"];
const SONNET_ANY: AdvisorModelId[] = ["claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"];
const SONNET_5_OR_LATER: AdvisorModelId[] = ["claude-sonnet-5", "claude-sonnet-5-5"];
const HAIKU_55: AdvisorModelId[] = ["claude-haiku-5-5"];

const ACCEPTED_ADVISORS: Record<AdvisorModelId, readonly AdvisorModelId[]> = {
  "claude-haiku-4-5": [...FABLE, ...OPUS_ANY, ...SONNET_ANY, ...HAIKU_55],
  "claude-sonnet-4-6": [...FABLE, ...OPUS_ANY, ...SONNET_ANY, ...HAIKU_55],
  "claude-opus-4-6": [...FABLE, ...OPUS_ANY, ...SONNET_5_OR_LATER, ...HAIKU_55],
  "claude-sonnet-5": [...FABLE, ...OPUS_47_OR_LATER, ...SONNET_5_OR_LATER, ...HAIKU_55],
  "claude-haiku-5-5": [...FABLE, ...OPUS_47_OR_LATER, ...SONNET_5_OR_LATER, ...HAIKU_55],
  "claude-opus-4-7": [...FABLE, ...OPUS_47_OR_LATER, "claude-sonnet-5-5"],
  "claude-opus-4-8": [...FABLE, ...OPUS_47_OR_LATER, "claude-sonnet-5-5"],
  "claude-sonnet-5-5": [...FABLE, ...OPUS_5_OR_LATER, "claude-sonnet-5-5"],
  "claude-opus-5": [...FABLE, ...OPUS_5_OR_LATER],
  "claude-opus-5-5": [...FABLE, ...OPUS_5_OR_LATER],
  "claude-fable-5": ["claude-fable-5", "claude-fable-5-1"],
  "claude-fable-5-1": ["claude-fable-5-1"]
};

export function resolveAdvisorModelId(modelId: string): AdvisorModelId | undefined {
  const alias = MODEL_ALIASES[modelId];
  if (alias) return alias;
  return (ADVISOR_MODEL_IDS as readonly string[]).includes(modelId) ? (modelId as AdvisorModelId) : undefined;
}

export interface AdvisorPairing {
  executorModelId: AdvisorModelId;
  advisorModelId: AdvisorModelId;
}

export function assertAdvisorPairing(input: {
  executorModelId: string;
  advisorModelId: string;
  allowedAdvisorModels?: readonly string[];
}): AdvisorPairing {
  const executorModelId = resolveAdvisorModelId(input.executorModelId);
  const advisorModelId = resolveAdvisorModelId(input.advisorModelId);
  if (!executorModelId || !advisorModelId) {
    throw new ControlStackError("advisor_model_unrecognized", "advisor binding names a model ACS does not recognize");
  }
  if (CANNOT_ADVISE.has(advisorModelId) || !ACCEPTED_ADVISORS[executorModelId].includes(advisorModelId)) {
    throw new ControlStackError(
      "advisor_pairing_rejected",
      `advisor ${advisorModelId} cannot advise executor ${executorModelId}`
    );
  }
  if (input.allowedAdvisorModels) {
    const allowed = new Set(
      input.allowedAdvisorModels.map((model) => resolveAdvisorModelId(model)).filter((model) => model !== undefined)
    );
    if (!allowed.has(advisorModelId)) {
      throw new ControlStackError("advisor_model_excluded", `advisor ${advisorModelId} is outside the allowlist`);
    }
  }
  return { executorModelId, advisorModelId };
}

export function missionUnitSubjectId(missionId: string, unitId: string): string {
  return `mission:${missionId}:unit:${unitId}`;
}

export function advisorOutputDigest(disposition: AdvisorDisposition, material: string): string {
  return createHash("sha256").update(`${disposition}\n${material}`).digest("hex");
}

export interface AdvisorConsultationView {
  schemaVersion: typeof ADVISOR_CONSULTATION_SCHEMA_VERSION;
  consultationId: string;
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  checkpoint: AdvisorCheckpoint;
  disposition: AdvisorDisposition;
  inputSha256: string;
  outputSha256: string;
  executorModelId: string;
  advisorModelId: string;
  createdAt: string;
  /** The execution attempt the consultation was fenced to (work items on the attempt protocol). */
  attemptId: string | null;
  /** The worker lease the consultation was fenced to (work items). */
  leaseId: string | null;
  /** sha256 of the mission-unit claim token the consultation was fenced to (mission units). */
  claimTokenHash: string | null;
}

export function advisorConsultationHash(view: AdvisorConsultationView): string {
  return createHash("sha256")
    .update(
      `${ADVISOR_CONSULTATION_HASH_DOMAIN}\n${JSON.stringify({
        schemaVersion: view.schemaVersion,
        consultationId: view.consultationId,
        subjectId: view.subjectId,
        missionId: view.missionId,
        subjectKind: view.subjectKind,
        checkpoint: view.checkpoint,
        disposition: view.disposition,
        inputSha256: view.inputSha256,
        outputSha256: view.outputSha256,
        executorModelId: view.executorModelId,
        advisorModelId: view.advisorModelId,
        createdAt: view.createdAt,
        attemptId: view.attemptId,
        leaseId: view.leaseId,
        claimTokenHash: view.claimTokenHash
      })}`
    )
    .digest("hex");
}

/**
 * Success may require a before-completion consultation. The input is dispositions
 * only: guidance text is not a parameter and is not inspected.
 *
 * Only `reviewed` satisfies the gate. `declined` (the advisor refused to answer) and
 * `unavailable` fail closed: a gate token must show the advisor actually reviewed the work.
 */
export function advisorCompletionBlock(input: {
  requireBeforeCompletion: boolean;
  dispositions: readonly AdvisorDisposition[];
}): "advisor_consultation_required" | undefined {
  if (!input.requireBeforeCompletion) return undefined;
  const reviewed = input.dispositions.some((disposition) => disposition === "reviewed");
  return reviewed ? undefined : "advisor_consultation_required";
}

export interface AdvisorFlightEvent {
  seq: number;
  kind: string;
  body: unknown;
}

const MAX_FLIGHT_EVENTS = 40;
const MAX_PROJECTION_CHARS = 24_000;
/**
 * Keys whose values are dropped (not just redacted) before a flight is sent to an external advisor:
 * command lines, environments, headers and other credential-bearing material. Matching is on the
 * key name, case-insensitive, with `_`/`-` separators ignored.
 */
const DROPPED_KEY =
  /^(?:argv|args|arguments|raw ?command|commands?|cmds?|command ?line|cmd ?line|shell ?command|script|stdin|env|environment|env ?vars?|headers?|authorization|proxy ?authorization|cookies?|set ?cookie|credentials?|passwords?|passwd|secrets?|tokens?|access ?token|refresh ?token|api ?keys?|private ?key|connection ?string|dsn)$/i;

function droppedKey(key: string): boolean {
  return DROPPED_KEY.test(key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
}

function dropCommandMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => dropCommandMaterial(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !droppedKey(key))
      .map(([key, entry]) => [key, dropCommandMaterial(entry)])
  );
}

export function projectFlightForAdvisor(events: readonly AdvisorFlightEvent[]): {
  text: string;
  sha256: string;
  truncated: boolean;
} {
  const recent = [...events].sort((left, right) => left.seq - right.seq).slice(-MAX_FLIGHT_EVENTS);
  const projected = recent.map((event) => ({
    seq: event.seq,
    kind: event.kind.slice(0, 128),
    body: dropCommandMaterial(redactValue(event.body))
  }));
  let text = JSON.stringify(projected);
  let truncated = false;
  if (text.length > MAX_PROJECTION_CHARS) {
    text = text.slice(0, MAX_PROJECTION_CHARS);
    truncated = true;
  }
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    truncated
  };
}
