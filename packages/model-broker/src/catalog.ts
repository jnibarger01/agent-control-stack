import { z } from "zod";
import { PRIVACY_CLASSES, type CatalogEntry } from "./types.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const taskType = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.-]*$/u);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const entrySchema = z
  .object({
    providerId: id,
    model: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u),
    kind: z.enum(["local", "hosted"]),
    taskTypes: z.array(taskType).min(1).max(64),
    contextWindow: positiveInt.optional(),
    maxPrivacy: z.enum(PRIVACY_CLASSES).optional(),
    memoryBytes: positiveInt.optional(),
    needsGpu: z.boolean().optional(),
    vramBytes: positiveInt.optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    costMicroUsdPer1kTokens: z
      .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
      .strict()
      .optional()
  })
  .strict();

/**
 * Validates an operator-supplied catalog. Strict: an unknown field is an error, not ignored. Defaults are applied here and
 * nowhere else: local models may serve up to `restricted`, hosted models only up to `internal` (a hosted provider sees the
 * prompt, so the safe default is the lower clearance), and an entry with no `priority` sorts after those that have one.
 */
export function parseCatalog(input: unknown): CatalogEntry[] {
  const raw = z.array(entrySchema).max(512).parse(input);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const key = `${entry.providerId}\u0000${entry.model}`;
    if (seen.has(key)) throw new Error(`duplicate catalog entry ${entry.providerId}/${entry.model}`);
    seen.add(key);
    if (entry.kind === "hosted" && entry.memoryBytes !== undefined) {
      throw new Error(`hosted model ${entry.providerId}/${entry.model} cannot declare memoryBytes`);
    }
    if (entry.vramBytes !== undefined && entry.needsGpu === false) {
      throw new Error(`${entry.providerId}/${entry.model} declares vramBytes but needsGpu is false`);
    }
    return {
      providerId: entry.providerId,
      model: entry.model,
      kind: entry.kind,
      taskTypes: [...new Set(entry.taskTypes)].sort(),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      maxPrivacy: entry.maxPrivacy ?? (entry.kind === "local" ? "restricted" : "internal"),
      ...(entry.memoryBytes !== undefined ? { memoryBytes: entry.memoryBytes } : {}),
      needsGpu: entry.needsGpu ?? entry.vramBytes !== undefined,
      ...(entry.vramBytes !== undefined ? { vramBytes: entry.vramBytes } : {}),
      priority: entry.priority ?? 1_000_000 + index,
      ...(entry.costMicroUsdPer1kTokens ? { costMicroUsdPer1kTokens: entry.costMicroUsdPer1kTokens } : {})
    };
  });
}
