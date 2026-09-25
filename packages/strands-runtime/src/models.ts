import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { GoogleModel } from "@strands-agents/sdk/models/google";
import { AcsError } from "./acs-client.js";

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);

/** Optional OpenAI-compatible reasoning control; small local context windows usually want "none". */
function reasoningParams(env: NodeJS.ProcessEnv): { params?: Record<string, unknown> } {
  const effort = env.HARNESS_REASONING_EFFORT;
  if (effort === undefined || effort === "") return {};
  if (!REASONING_EFFORTS.has(effort)) throw new AcsError("invalid_HARNESS_REASONING_EFFORT");
  return { params: { reasoning_effort: effort } };
}

export function createModel(selection: string, env: NodeJS.ProcessEnv = process.env) {
  const split = selection.indexOf("/");
  const provider = selection.slice(0, split);
  const modelId = selection.slice(split + 1);
  if (split < 1 || !modelId) throw new AcsError("HARNESS_MODEL_requires_provider_and_model");
  switch (provider) {
    case "openai":
      return new OpenAIModel({
        modelId,
        ...reasoningParams(env),
        apiKey: env.OPENAI_API_KEY,
        clientConfig: {
          maxRetries: 0,
          ...(env.HARNESS_OPENAI_BASE_URL ? { baseURL: env.HARNESS_OPENAI_BASE_URL } : {})
        }
      });
    case "anthropic":
      return new AnthropicModel({ modelId, maxTokens: 4096, apiKey: env.ANTHROPIC_API_KEY });
    case "gemini":
    case "google":
      return new GoogleModel({ modelId, apiKey: env.GEMINI_API_KEY });
    // Ollama exposes an OpenAI-compatible chat/completions API. No host tools are involved.
    case "ollama":
      return new OpenAIModel({
        // Chat Completions keeps reasoning models' turns intact; the SDK's
        // Responses adapter drops reasoning blocks in multi-turn runs.
        api: "chat",
        modelId,
        ...reasoningParams(env),
        apiKey: env.OLLAMA_API_KEY ?? "ollama",
        clientConfig: { baseURL: env.HARNESS_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1", maxRetries: 0 }
      });
    default:
      throw new AcsError("unsupported_model_provider");
  }
}
