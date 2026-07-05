import { z } from "zod";

export const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const attributesSchema = z.record(z.string(), attributeValueSchema);
export const auditEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeUnixNano: z.string().regex(/^\d+$/),
  attributes: attributesSchema.default({}),
  body: z.record(z.string(), z.unknown()).default({})
});

export type AttributeValue = z.infer<typeof attributeValueSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
