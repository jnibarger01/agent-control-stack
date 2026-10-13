import { assertLoopback } from "@agent-control-stack/model-broker";
import { type AdvisorProvider, type GenerateInput, type GenerateResult, ProviderError } from "./provider.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;

export interface OllamaProviderOptions {
  /** Ollama model name, e.g. `qwen2.5-coder:7b`. Must already be installed; this provider never pulls models. */
  readonly model: string;
  readonly baseUrl?: string;
  /** If set, the installed digest must equal this value or generation is refused. */
  readonly expectedDigest?: `sha256:${string}`;
  readonly fetchImpl?: typeof fetch;
  /** Concurrent generations allowed against this endpoint. Bounded to protect GPU/RAM residency. */
  readonly maxConcurrency?: number;
  /** Retries after an `unavailable` failure only. Timeouts and cancellations are never retried. */
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("aborted", "aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ProviderError("aborted", "aborted"));
      },
      { once: true }
    );
  });
}

/**
 * Ollama provider. Hard constraints:
 * - endpoint must be loopback (reuses `@agent-control-stack/model-broker` `assertLoopback`), so there is no cloud fallback;
 * - all requests are built from one fixed base URL and `redirect: "error"`, so there is no redirect-based egress;
 * - the installed model digest is read from `/api/tags` before EVERY generation and compared to the expected digest;
 * - no model pulls, no shell, no filesystem access.
 */
export class OllamaProvider implements AdvisorProvider {
  readonly providerId = "ollama" as const;
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: Semaphore;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: OllamaProviderOptions) {
    if (!MODEL_NAME.test(options.model)) throw new Error("invalid Ollama model name");
    if (options.expectedDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(options.expectedDigest)) {
      throw new Error("expectedDigest must be sha256:<64 hex>");
    }
    const maxConcurrency = options.maxConcurrency ?? 1;
    const retries = options.retries ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
      throw new Error("maxConcurrency must be an integer 1..4");
    }
    if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error("retries must be an integer 0..3");
    this.base = assertLoopback(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = new Semaphore(maxConcurrency);
    this.retries = retries;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    return this.limiter.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const identity = await this.verifyModel(input.signal);
          const body = await this.post(
            "/api/chat",
            {
              model: this.options.model,
              stream: false,
              format: input.format,
              messages: [
                { role: "system", content: input.system },
                { role: "user", content: input.user }
              ],
              options: { temperature: 0, num_predict: input.maxOutputTokens }
            },
            input.signal
          );
          const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
          if (typeof content !== "string") throw new ProviderError("malformed_response", "missing message content");
          const counts = body as { prompt_eval_count?: unknown; eval_count?: unknown };
          return {
            text: content,
            modelId: `ollama:${this.options.model}`,
            digest: identity,
            promptTokens: typeof counts.prompt_eval_count === "number" ? counts.prompt_eval_count : undefined,
            completionTokens: typeof counts.eval_count === "number" ? counts.eval_count : undefined
          };
        } catch (error) {
          if (!(error instanceof ProviderError) || error.kind !== "unavailable" || attempt >= this.retries) throw error;
          await sleep(this.retryBaseDelayMs * 2 ** attempt, input.signal);
        }
      }
    });
  }

  /** Reads the installed digest and refuses to continue unless it matches the expectation (when one is pinned). */
  private async verifyModel(signal: AbortSignal): Promise<`sha256:${string}`> {
    const tags = (await this.get("/api/tags", signal)) as { models?: unknown };
    const list = Array.isArray(tags.models) ? (tags.models as { name?: unknown; model?: unknown; digest?: unknown }[]) : [];
    const wanted = this.options.model.includes(":") ? this.options.model : `${this.options.model}:latest`;
    const entry = list.find((item) => item.name === this.options.model || item.name === wanted);
    if (!entry || typeof entry.digest !== "string" || !HEX64.test(entry.digest)) {
      throw new ProviderError("model_not_installed", "model is not installed locally or reports no digest");
    }
    const digest = `sha256:${entry.digest}` as const;
    if (this.options.expectedDigest !== undefined && digest !== this.options.expectedDigest) {
      throw new ProviderError("digest_mismatch", "installed model digest does not match the pinned digest");
    }
    return digest;
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(path, { method: "GET" }, signal);
    return this.json(response);
  }

  private async post(path: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(
      path,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
      signal
    );
    return this.json(response);
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      // `new URL(path, base)` with a fixed loopback base; `redirect: "error"` refuses any redirect target.
      response = await this.fetchImpl(new URL(path, this.base), { ...init, signal, redirect: "error" });
    } catch {
      if (signal.aborted) throw new ProviderError("aborted", "request aborted");
      throw new ProviderError("unavailable", "endpoint unreachable or redirected");
    }
    if (!response.ok) throw new ProviderError("unavailable", `endpoint returned HTTP ${response.status}`);
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ProviderError("malformed_response", "endpoint returned non-JSON");
    }
  }
}
