import {
  DecisionModelUnavailable,
  doneProjection,
  nextOperationProjection,
  relevanceProjection,
  riskProjection,
  routeProjection,
  type DecisionQuestion,
  type NimbleDecisionModel
} from "@agent-control-stack/decision-engine";

export type NimbleCallEvidence = {
  readonly requestId: string;
  readonly modelRequested: string;
  readonly modelReported: string | null;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly httpStatus: number | null;
  readonly rawResponse: string | null;
  readonly unavailable: boolean;
  readonly reason: string | null;
};

export type NimbleAdapterConfig = {
  readonly url?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly acceptedModels?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly requestId?: () => string;
};

type AnswerInput = Parameters<NimbleDecisionModel["answer"]>[0];
type SystemOneQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

const RAW_LIMIT = 4000;
const RETRYABLE = new Set([429, 529]);

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function pick<K extends keyof NimbleAdapterConfig>(overrides: NimbleAdapterConfig, key: K, envName: string): NimbleAdapterConfig[K] {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return readEnv(envName) as NimbleAdapterConfig[K];
}

export function resolveNimbleAdapterConfig(overrides: NimbleAdapterConfig = {}): NimbleAdapterConfig & {
  readonly timeoutMs: number;
  readonly maxRetries: number;
} {
  return {
    url: pick(overrides, "url", "ACS_NIMBLE_URL"),
    model: pick(overrides, "model", "ACS_NIMBLE_MODEL"),
    apiKey: pick(overrides, "apiKey", "ACS_NIMBLE_API_KEY"),
    timeoutMs: overrides.timeoutMs ?? Number(readEnv("ACS_NIMBLE_TIMEOUT_MS") ?? 3000),
    maxRetries: overrides.maxRetries ?? 2,
    acceptedModels: overrides.acceptedModels,
    fetchImpl: overrides.fetchImpl,
    sleep: overrides.sleep,
    now: overrides.now,
    requestId: overrides.requestId
  };
}

export function toSystemOneQuestion(question: DecisionQuestion, state: AnswerInput["state"]): SystemOneQuestion {
  if (question.type === "route") {
    const projection = routeProjection(state, question.options);
    return { type: "choice", instructions: projection.instructions, criteria: projection.criteria };
  }
  if (question.type === "next_operation") {
    const projection = nextOperationProjection(state, question.options);
    return { type: "choice", instructions: projection.instructions, criteria: projection.criteria };
  }
  if (question.type === "done") return { type: "noul", instructions: doneProjection(state).instructions };
  if (question.type === "relevance") {
    const projection = relevanceProjection(state.goal, question.evidenceId);
    return { type: "score", instructions: projection.instructions, criteria: projection.criteria };
  }
  const projection = riskProjection(question.sideEffectClass, question.sideEffectClass);
  return { type: "score", instructions: projection.instructions, criteria: projection.criteria };
}

function unavailable(reason: string): never {
  throw new DecisionModelUnavailable(reason);
}

function clip(value: string): string {
  return value.length <= RAW_LIMIT ? value : value.slice(0, RAW_LIMIT);
}

function unit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionModelUnavailable("model confidence missing");
  }
  return value;
}

function mapAnswer(question: DecisionQuestion, raw: unknown, asked: SystemOneQuestion): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionModelUnavailable("model answer missing");
  }
  const body = raw as Record<string, unknown>;
  if (asked.type === "choice") {
    if (typeof body.choice !== "string") throw new DecisionModelUnavailable("model choice missing");
    return { id: question.id, choice: body.choice, confidence: unit(body.confidence) };
  }
  if (asked.type === "noul") {
    const noul = unit(body.noul);
    return { id: question.id, value: noul >= 0.5, confidence: Math.max(noul, 1 - noul) };
  }
  if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
    throw new DecisionModelUnavailable("model score missing");
  }
  const normalized = Math.min(1, Math.max(0, body.score / Math.max(1, asked.criteria.length - 1)));
  const confidence = unit(body.confidence);
  return question.type === "risk"
    ? { id: question.id, semanticRisk: normalized, confidence }
    : { id: question.id, score: normalized, confidence };
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header >= 0) return Math.min(10_000, header * 1000);
  return Math.min(10_000, 50 * 2 ** (attempt - 1));
}

export type NimbleAdapter = NimbleDecisionModel & {
  readonly evidence: () => NimbleCallEvidence | null;
};

export function createNimbleAdapter(overrides: NimbleAdapterConfig = {}): NimbleAdapter {
  const config = resolveNimbleAdapterConfig(overrides);
  let last: NimbleCallEvidence | null = null;
  const accepted = new Set(
    [config.model, ...(config.acceptedModels ?? [])].filter((model): model is string => typeof model === "string" && model.length > 0)
  );

  return {
    id: "nimble",
    version: config.model ?? "unconfigured",
    evidence: () => last,
    async answer(input) {
      const requestId = config.requestId?.() ?? crypto.randomUUID();
      const started = config.now?.() ?? Date.now();
      const elapsed = () => Math.max(0, (config.now?.() ?? Date.now()) - started);
      const fail = (
        reason: string,
        attempts: number,
        httpStatus: number | null,
        rawResponse: string | null,
        modelReported: string | null
      ): never => {
        last = {
          requestId,
          modelRequested: config.model ?? "",
          modelReported,
          latencyMs: elapsed(),
          attempts,
          httpStatus,
          rawResponse,
          unavailable: true,
          reason
        };
        throw new DecisionModelUnavailable(reason);
      };

      const configuredUrl = config.url;
      const configuredModel = config.model;
      if (typeof configuredUrl !== "string" || typeof configuredModel !== "string") {
        last = {
          requestId,
          modelRequested: "",
          modelReported: null,
          latencyMs: elapsed(),
          attempts: 0,
          httpStatus: null,
          rawResponse: null,
          unavailable: true,
          reason: "nimble transport is not configured"
        };
        throw new DecisionModelUnavailable("nimble transport is not configured");
      }
      const endpoint: string = configuredUrl;
      const modelName: string = configuredModel;
      const questions = Object.fromEntries(
        input.questions.map((question) => [question.id, toSystemOneQuestion(question, input.state)])
      );
      const doFetch = config.fetchImpl ?? fetch;
      const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      const maxAttempts = config.maxRetries + 1;
      let response: Response | null = null;
      let attempts = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attempts = attempt;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
            },
            body: JSON.stringify({ model: modelName, state: input.state, questions }),
            signal: controller.signal
          });
        } catch (error) {
          if (attempt === maxAttempts) {
            const timedOut = error instanceof Error && error.name === "AbortError";
            fail(timedOut ? "timeout" : "transport", attempts, null, null, null);
          }
          await sleep(50 * 2 ** (attempt - 1));
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) break;
        if (!RETRYABLE.has(response.status) || attempt === maxAttempts) {
          fail(`http ${response.status}`, attempts, response.status, clip(await response.text()), null);
        }
        await sleep(retryDelayMs(response, attempt));
      }
      if (response === null || !response.ok) fail("transport", attempts, response?.status ?? null, null, null);
      if (response === null || !response.ok) unavailable("transport");
      const settled = response;

      const rawText = clip(await settled.text());
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        fail("malformed response", attempts, settled.status, rawText, null);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("malformed response", attempts, settled.status, rawText, null);
      }
      const body = parsed as { model?: unknown; answers?: unknown };
      const modelReported = typeof body.model === "string" ? body.model : null;
      if (modelReported === null || !accepted.has(modelReported)) {
        fail("model identity mismatch", attempts, settled.status, rawText, modelReported);
      }
      if (body.answers === null || typeof body.answers !== "object" || Array.isArray(body.answers)) {
        fail("model answer missing", attempts, settled.status, rawText, modelReported);
      }
      const answerMap = body.answers as Record<string, unknown>;
      try {
        const mapped = input.questions.map((question) => {
          const asked = questions[question.id];
          if (asked === undefined) throw new DecisionModelUnavailable("model answer missing");
          return mapAnswer(question, answerMap[question.id], asked);
        });
        last = {
          requestId,
          modelRequested: modelName,
          modelReported,
          latencyMs: elapsed(),
          attempts,
          httpStatus: settled.status,
          rawResponse: rawText,
          unavailable: false,
          reason: null
        };
        return { answers: mapped };
      } catch (error) {
        if (error instanceof DecisionModelUnavailable) {
          last = {
            requestId,
            modelRequested: modelName,
            modelReported,
            latencyMs: elapsed(),
            attempts,
            httpStatus: settled.status,
            rawResponse: rawText,
            unavailable: true,
            reason: error.message
          };
        }
        throw error;
      }
    }
  };
}
