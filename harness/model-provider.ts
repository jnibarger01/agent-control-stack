export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelUsageReceipt extends ModelTokenUsage {
  model: string;
  costUsd: number;
}

export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  jsonSchema?: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  requestedModel: string;
  exactModels: string[];
  stopReason: string | null;
  refused: boolean;
  costUsd: number;
  durationMs: number;
  usage: ModelTokenUsage;
  modelUsage: ModelUsageReceipt[];
}

export interface ModelProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type ModelProviderErrorKind =
  | "api"
  | "budget"
  | "invalid_response"
  | "output_limit"
  | "process"
  | "timeout";

export class ModelProviderError extends Error {
  constructor(
    public readonly kind: ModelProviderErrorKind,
    message: string,
    public readonly exitCode?: number
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}
