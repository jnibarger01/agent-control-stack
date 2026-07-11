import type { ModelCaller, ModelRequest } from "@agent-control-stack/moa-orchestrator";
import { ControlStackError } from "@agent-control-stack/shared";

export interface ModelCallerEnv {
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  ollamaBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function modelCallerEnvFromProcess(env: NodeJS.ProcessEnv = process.env): ModelCallerEnv {
  return {
    openrouterApiKey: env.ACS_OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY,
    openrouterBaseUrl: env.ACS_OPENROUTER_BASE_URL,
    openaiApiKey: env.ACS_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    openaiBaseUrl: env.ACS_OPENAI_BASE_URL,
    ollamaBaseUrl: env.ACS_OLLAMA_BASE_URL ?? env.OLLAMA_BASE_URL
  };
}

export function createRoutingModelCaller(env: ModelCallerEnv = modelCallerEnvFromProcess()): ModelCaller {
  const fetchImpl = env.fetchImpl ?? fetch;
  return {
    async complete(request: ModelRequest): Promise<string> {
      const [provider, ...modelParts] = request.model.split(":");
      const model = modelParts.join(":");
      if (provider === "ollama") return completeOllama(fetchImpl, env.ollamaBaseUrl ?? "http://127.0.0.1:11434", model, request);
      if (provider === "openrouter") {
        return completeOpenAi(fetchImpl, env.openrouterBaseUrl ?? "https://openrouter.ai/api/v1", env.openrouterApiKey, model, request);
      }
      if (provider === "openai-codex") {
        return completeOpenAi(fetchImpl, env.openaiBaseUrl ?? "https://api.openai.com/v1", env.openaiApiKey, model, request);
      }
      throw new ControlStackError("moa_model_provider_unknown", `unknown MoA model provider: ${request.model}`);
    }
  };
}

async function completeOpenAi(fetchImpl: typeof fetch, baseUrl: string, apiKey: string | undefined, model: string, request: ModelRequest) {
  if (!apiKey) {
    throw new ControlStackError("moa_model_credentials_missing", `missing API key for ${request.model}`);
  }
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ]
    }),
    signal: request.signal
  });
  if (!response.ok) throw new ControlStackError("moa_model_call_failed", `model call failed: ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new ControlStackError("moa_model_output_invalid", "model returned no text");
  return text;
}

async function completeOllama(fetchImpl: typeof fetch, baseUrl: string, model: string, request: ModelRequest) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_predict: request.maxTokens },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ]
    }),
    signal: request.signal
  });
  if (!response.ok) throw new ControlStackError("moa_model_call_failed", `ollama call failed: ${response.status}`);
  const body = (await response.json()) as { message?: { content?: unknown } };
  const text = body.message?.content;
  if (typeof text !== "string") throw new ControlStackError("moa_model_output_invalid", "ollama returned no text");
  return text;
}
