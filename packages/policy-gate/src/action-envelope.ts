import { z } from "zod";
import type { PolicyContext } from "./policy.js";

/**
 * The immutable request shape used for policy fingerprints and receipts.
 *
 * Keeping this projection in one place prevents the policy evaluator, approval
 * gate, and audit path from silently hashing different views of an action.
 * `arguments` is deliberately the full caller-supplied parameter object: an
 * argument change must produce a different authorization identity. Caller and
 * lifecycle fields are intentionally excluded from the fingerprinted envelope
 * so an approval remains bound to the action across create/approve/claim.
 */
export const canonicalActionEnvelopeSchema = z.object({
  schemaVersion: z.literal("acs.policy-action.v1"),
  risk: z.enum(["low", "medium", "high", "critical"]),
  action: z.object({
    kind: z.string().min(1),
    description: z.string().min(1),
    arguments: z.record(z.string(), z.unknown())
  }),
  cwd: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  network: z.boolean().optional(),
  write: z.boolean().optional(),
  destructive: z.boolean().optional()
});

export type CanonicalActionEnvelope = z.infer<typeof canonicalActionEnvelopeSchema>;

export function canonicalActionEnvelope(context: PolicyContext): CanonicalActionEnvelope {
  return canonicalActionEnvelopeSchema.parse({
    schemaVersion: "acs.policy-action.v1",
    risk: context.risk,
    action: {
      kind: context.action.kind,
      description: context.action.description,
      arguments: context.action.params
    },
    cwd: context.cwd,
    command: context.command,
    paths: context.paths,
    network: context.network,
    write: context.write,
    destructive: context.destructive
  });
}
