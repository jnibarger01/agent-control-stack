/** Audit read model: server-redacted, bounded, newest first. The browser never redacts. */
import { z } from "zod";
import type { Parsed } from "./queue-trace.js";

const attrValue = z.union([z.string().max(300), z.number(), z.boolean()]);

export const auditEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    id: z.string().min(1),
    name: z.string().min(1).max(160),
    at: z.string().min(1),
    attributes: z.record(z.string().max(120), attrValue),
    /** Present only for policy.decided events: the recorded decision, in the policy's words. */
    policy: z
      .object({
        decision: z.string().max(40),
        reason: z.string().max(400).optional(),
        matchedRules: z.array(z.string().max(120)).max(32),
        requiredApprover: z.string().max(120).optional()
      })
      .strict()
      .optional(),
    eventHash: z.string().max(128),
    previousHash: z.string().max(128)
  })
  .strict();

export const auditReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    events: z.array(auditEventSchema).max(200),
    /** Pass as `beforeSequence` to fetch the next older page; null when there is no older page. */
    nextBefore: z.number().int().nonnegative().nullable()
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditReadModel = z.infer<typeof auditReadModelSchema>;

export function parseAuditReadModel(input: unknown): Parsed<AuditReadModel> {
  const r = auditReadModelSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: `schema_invalid:${r.error.issues[0]?.path.join(".") ?? ""}` };
}
