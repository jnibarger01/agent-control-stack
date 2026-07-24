import { z } from "zod";

export const verificationCriterionSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z.string().min(1).max(2_000),
    expected: z.string().min(1).max(2_000)
  })
  .strict();

export type VerificationCriterion = z.infer<typeof verificationCriterionSchema>;

export const commandEvidenceSchema = z
  .object({
    commandProfile: z.string().min(1),
    exitCode: z.number().int().nullable(),
    observedSuccess: z.boolean(),
    stdout: z.string(),
    stderr: z.string()
  })
  .strict();

export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

export const verificationEvidenceSchema = z
  .object({
    workItemId: z.string().min(1),
    /** What the implementer engine claims it did - untrusted, evaluated against the rest of the evidence, never taken as fact on its own. */
    implementerClaim: z.string().min(1).max(16_000),
    diffSummary: z.string().max(64_000),
    commandResults: z.array(commandEvidenceSchema).max(32)
  })
  .strict();

export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

export const verificationCriterionResultSchema = z
  .object({
    criterionId: z.string().min(1),
    satisfied: z.boolean(),
    observed: z.string().min(1).max(2_000)
  })
  .strict();

export type VerificationCriterionResult = z.infer<typeof verificationCriterionResultSchema>;

export const verificationResultSchema = z
  .object({
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    summary: z.string().min(1).max(4_000),
    criteriaResults: z.array(verificationCriterionResultSchema),
    verifierEngineId: z.string().min(1),
    durationMs: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, context) => {
    // "pass" is only earnable when every criterion the verifier itself
    // reported is satisfied - a verdict claiming pass while listing an
    // unsatisfied criterion (or none at all) is internally inconsistent
    // and must not be trusted as a genuine pass.
    if (value.verdict === "pass") {
      if (value.criteriaResults.length === 0 || value.criteriaResults.some((result) => !result.satisfied)) {
        context.addIssue({
          code: "custom",
          path: ["verdict"],
          message: "verdict cannot be pass unless every reported criterion is satisfied"
        });
      }
    }
  });

export type VerificationResult = z.infer<typeof verificationResultSchema>;

/**
 * Implementations must never share model-provider or process identity with
 * the engine that produced the evidence being verified - see
 * runIndependentVerification, which enforces this at the call boundary
 * rather than trusting each Verifier to self-police.
 */
export interface Verifier {
  readonly engineId: string;
  verify(criteria: VerificationCriterion[], evidence: VerificationEvidence): Promise<VerificationResult>;
}
