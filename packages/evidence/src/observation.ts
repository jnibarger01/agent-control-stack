import { z } from "zod";

/**
 * An `Observation` is a MACHINE-DERIVED FACT produced by an `EVIDENCE_AUTHORITY`
 * subsystem (sandbox, workspace manager, git adapter, test runner, process
 * supervisor, audit subsystem). It is structurally distinct from a `Finding`
 * (a model interpretation, `packages/advisory`) and a `Decision` (an ACS
 * authority outcome, `packages/work-items`).
 *
 * A model-generated summary is never an `Observation`.
 */

export const evidenceSourceSchema = z.enum([
  "sandbox",
  "workspace-manager",
  "git-adapter",
  "test-runner",
  "process-supervisor",
  "audit-subsystem",
  "execution-controller"
]);

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const observationSchema = z
  .object({
    kind: z.string().min(1).max(128),
    /** Which ACS-controlled subsystem produced this fact. */
    source: evidenceSourceSchema,
    /** JSON-serialisable machine value; never model prose. */
    value: z.unknown(),
    observedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type Observation = z.infer<typeof observationSchema>;

export function observation(
  kind: string,
  source: EvidenceSource,
  value: unknown,
  observedAt: Date = new Date()
): Observation {
  return observationSchema.parse({ kind, source, value, observedAt: observedAt.toISOString() });
}
