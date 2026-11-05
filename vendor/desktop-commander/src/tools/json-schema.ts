import { z } from 'zod';

/** Describe caller inputs, before defaults and PDF-content preprocessing run. */
export function toolInputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
}
