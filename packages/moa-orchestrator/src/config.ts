import { z } from "zod";
import { MoaError } from "./errors.js";
import { HIGH_RISK_CATEGORIES, HighRiskCategorySchema } from "./types.js";

const localProviderPattern = /^(ollama|local):/i;
const externalProviderPattern = /^(openrouter|anthropic|openai):/i;

const ModelString = z
  .string()
  .min(1)
  .max(128)
  .refine((model) => !model.toLowerCase().startsWith("moa:"), {
    message: "model may not reference an MoA preset"
  });

const AdvisorConfigSchema = z.object({
  id: z.string().min(1).max(64),
  model: ModelString,
  max_tokens: z.number().int().min(64).max(2000)
}).strict();
export type AdvisorConfig = z.infer<typeof AdvisorConfigSchema>;

const AggregatorConfigSchema = z.object({
  id: z.string().min(1).max(64),
  model: ModelString,
  max_tokens: z.number().int().min(256).max(8192)
}).strict();
export type AggregatorConfig = z.infer<typeof AggregatorConfigSchema>;

const PresetSchema = z.object({
  advisors: z.array(AdvisorConfigSchema).min(1).max(8),
  aggregator: AggregatorConfigSchema,
  allow_advisor_tools: z.literal(false),
  require_acs_for_mutation: z.literal(true),
  local_only: z.boolean().default(false),
  require_human_approval_for: z.array(HighRiskCategorySchema).default([...HIGH_RISK_CATEGORIES])
}).strict().superRefine((preset, ctx) => {
  const ids = preset.advisors.map((advisor) => advisor.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "advisor ids must be unique" });
  }
  if (preset.local_only) {
    for (const model of [preset.aggregator.model, ...preset.advisors.map((advisor) => advisor.model)]) {
      if (!localProviderPattern.test(model) || externalProviderPattern.test(model)) {
        ctx.addIssue({ code: "custom", message: `local-only preset cannot use external model provider: ${model}` });
      }
    }
  }
});
export type MoaPreset = z.infer<typeof PresetSchema>;

export const MoaConfigSchema = z.object({
  default: z.string().min(1),
  presets: z.record(z.string().regex(/^[a-z][a-z0-9_-]{1,32}$/), PresetSchema)
}).strict().superRefine((config, ctx) => {
  if (!config.presets[config.default]) {
    ctx.addIssue({ code: "custom", message: `default preset "${config.default}" not found in presets` });
  }
  const names = new Set(Object.keys(config.presets));
  for (const [name, preset] of Object.entries(config.presets)) {
    for (const [kind, model] of [["aggregator", preset.aggregator.model], ...preset.advisors.map((advisor) => [`advisor ${advisor.id}`, advisor.model])] as Array<[string, string]>) {
      if (names.has(model)) {
        ctx.addIssue({ code: "custom", message: `preset "${name}": ${kind} model may not be another MoA preset` });
      }
    }
  }
});
export type MoaConfig = z.infer<typeof MoaConfigSchema>;

export function loadMoaConfig(raw: unknown): MoaConfig {
  const parsed = MoaConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MoaError("CONFIG_INVALID", "CONFIG_INVALID: MoA config rejected (fail closed)", parsed.error.issues);
  }
  return parsed.data;
}

export function isExternalModel(model: string): boolean {
  return externalProviderPattern.test(model);
}

export const DEFAULT_MOA_CONFIG: MoaConfig = loadMoaConfig({
  default: "fast",
  presets: {
    fast: {
      advisors: [
        { id: "implementation-reviewer", model: "openai-codex:gpt-5.5", max_tokens: 350 },
        { id: "test-reviewer", model: "openrouter:deepseek/deepseek-v4-pro", max_tokens: 350 }
      ],
      aggregator: { id: "aggregator", model: "openai-codex:gpt-5.5", max_tokens: 4096 },
      allow_advisor_tools: false,
      require_acs_for_mutation: true
    },
    security: {
      advisors: [
        { id: "security-reviewer", model: "openai-codex:gpt-5.5", max_tokens: 500 },
        { id: "implementation-reviewer", model: "openai-codex:gpt-5.5", max_tokens: 500 },
        { id: "test-reviewer", model: "openrouter:deepseek/deepseek-v4-pro", max_tokens: 500 }
      ],
      aggregator: { id: "senior-aggregator", model: "openai-codex:gpt-5.5", max_tokens: 4096 },
      allow_advisor_tools: false,
      require_acs_for_mutation: true,
      require_human_approval_for: [...HIGH_RISK_CATEGORIES]
    },
    cheap: {
      advisors: [{ id: "local-reviewer", model: "ollama:qwen3:8b", max_tokens: 250 }],
      aggregator: { id: "aggregator", model: "ollama:qwen3:8b", max_tokens: 3072 },
      allow_advisor_tools: false,
      require_acs_for_mutation: true,
      local_only: true
    }
  }
});
