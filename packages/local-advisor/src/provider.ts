export type ProviderErrorKind =
  | "unavailable"
  | "aborted"
  | "digest_mismatch"
  | "model_not_installed"
  | "malformed_response";

/** A provider failure. Failures are never converted into a review verdict by the advisor. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface GenerateInput {
  readonly system: string;
  readonly user: string;
  /** JSON Schema the model output must satisfy (enforced by the inference server and re-validated by the advisor). */
  readonly format: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface GenerateResult {
  readonly text: string;
  /** Exact model identity the provider verified before generating. */
  readonly modelId: string;
  readonly digest: `sha256:${string}`;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface AdvisorProvider {
  readonly providerId: "ollama";
  generate(input: GenerateInput): Promise<GenerateResult>;
}
