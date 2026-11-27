import { z } from "zod";
import type { Parsed } from "./queue-trace.js";

/**
 * AI Factory backlog (F10). Strict: an unrecognised stage or an extra field fails the contract, so
 * the console renders nothing rather than a guessed status. Mirrors packages/ai-factory-runtime
 * `FactoryMissionView`.
 */
export const FACTORY_STAGE_VALUES = [
  "awaiting_plan",
  "plan_review",
  "pending_dispatch",
  "executing",
  "needs_reconciliation",
  "blocked_integration",
  "failed_gate",
  "verified_awaiting_publication",
  "publication_uncertain",
  "draft_published",
  "cancelled",
  "unknown"
] as const;

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const factoryMissionViewSchema = z
  .object({
    missionId: z.string().regex(/^factory-[a-f0-9]{48}$/u),
    repository: z.string().min(3).max(201),
    pinnedBaseSha: sha,
    missionState: z.string().min(1).max(64),
    stage: z.enum(FACTORY_STAGE_VALUES),
    plan: z.object({ revision: z.number().int().positive(), planDigest: digest, accepted: z.boolean() }).strict().nullable(),
    units: z
      .array(
        z
          .object({
            unitId: z.string().min(1).max(64),
            status: z.string().min(1).max(32),
            failureCategory: z.string().max(64).nullable(),
            resultHash: digest.nullable()
          })
          .strict()
      )
      .max(64),
    budget: z
      .object({ limits: z.record(z.string(), z.number()), usage: z.record(z.string(), z.number()) })
      .strict()
      .nullable(),
    failedGate: z.string().max(64).nullable(),
    publication: z
      .object({ state: z.enum(["none", "uncertain", "published"]), url: z.string().url().max(512).nullable() })
      .strict(),
    nextAction: z
      .object({ recommendation: z.string().min(1).max(300), authority: z.literal("advisory"), requiresHumanApproval: z.boolean() })
      .strict()
  })
  .strict();

export const factoryBacklogSchema = z.object({ missions: z.array(factoryMissionViewSchema).max(100) }).strict();

export type FactoryMissionViewModel = z.infer<typeof factoryMissionViewSchema>;
export type FactoryBacklogReadModel = z.infer<typeof factoryBacklogSchema>;

export function parseFactoryBacklog(input: unknown): Parsed<FactoryBacklogReadModel> {
  const result = factoryBacklogSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, reason: `schema_invalid:${result.error.issues[0]?.path.join(".") ?? ""}` };
}
