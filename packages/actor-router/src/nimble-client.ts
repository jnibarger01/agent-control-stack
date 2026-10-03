import { redactValue } from "@agent-control-stack/shared";
import type { NimbleRoutingConfig } from "./nimble-config.js";

export interface NimbleChoiceRequest {
  missionId?: string;
  workItemId: string;
  operationType: string;
  requiredCapabilities: readonly string[];
  lane?: "jc" | "dc";
  priority?: string;
  retryCount?: number;
  candidates: ReadonlyArray<{
    id: string;
    role: string;
    kind: string;
    model?: string;
    capabilities: readonly string[];
  }>;
}

export interface NimbleChoiceSuccess {
  ok: true;
  executorId: string;
  confidence: number;
  model: string;
  probabilities: Record<string, number>;
  latencyMs: number;
}

export interface NimbleChoiceFailure {
  ok: false;
  reason: "timeout" | "unavailable" | "malformed_response" | "unknown_executor" | "low_confidence";
  model?: string;
  latencyMs: number;
  executorId?: string;
  confidence?: number;
}

export type NimbleChoiceResult = NimbleChoiceSuccess | NimbleChoiceFailure;

export async function askNimbleToChooseExecutor(
  request: NimbleChoiceRequest,
  config: Pick<NimbleRoutingConfig, "url" | "model" | "timeoutMs" | "confidenceThreshold">,
  fetchImpl: typeof fetch = fetch
): Promise<NimbleChoiceResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const criteria = Object.fromEntries(
      request.candidates.map((candidate) => [
        candidate.id,
        `${candidate.role}; kind ${candidate.kind}; capabilities ${candidate.capabilities.join(", ") || "none"}; model ${candidate.model ?? "unspecified"}`
      ])
    );
    const state = redactValue({
      mission_id: request.missionId ?? null,
      work_item_id: request.workItemId,
      operation_type: request.operationType,
      required_capabilities: request.requiredCapabilities,
      lane: request.lane ?? null,
      priority: request.priority ?? null,
      retry_count: request.retryCount ?? 0,
      candidates: request.candidates.map((candidate) => ({
        id: candidate.id,
        role: candidate.role,
        kind: candidate.kind,
        model: candidate.model ?? null,
        capabilities: candidate.capabilities
      }))
    });
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        state,
        questions: {
          executor: {
            type: "choice",
            instructions:
              "Which eligible executor should own this operation? Choose only from the supplied criteria. The criteria names are the executor ids.",
            criteria
          }
        }
      }),
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store"
    });
    const latencyMs = Math.max(0, Date.now() - started);
    if (!response.ok) {
      return { ok: false, reason: "unavailable", model: config.model, latencyMs };
    }
    const text = await response.text();
    if (text.length > 16_384) return { ok: false, reason: "malformed_response", model: config.model, latencyMs };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: "malformed_response", model: config.model, latencyMs };
    }
    const parsed = parseChoice(body, new Set(request.candidates.map((candidate) => candidate.id)));
    if (!parsed.ok) return { ...parsed, latencyMs };
    if (parsed.confidence < config.confidenceThreshold) {
      return {
        ok: false,
        reason: "low_confidence",
        executorId: parsed.executorId,
        confidence: parsed.confidence,
        model: parsed.model,
        latencyMs
      };
    }
    return { ...parsed, latencyMs };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - started);
    const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable";
    return { ok: false, reason, model: config.model, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeNimbleRouting(
  config: Pick<NimbleRoutingConfig, "url" | "model" | "timeoutMs">,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; latencyMs: number; model: string } | { ok: false; code: string; latencyMs: number }> {
  const result = await askNimbleToChooseExecutor(
    {
      workItemId: "readyz",
      operationType: "readiness",
      requiredCapabilities: [],
      candidates: [
        { id: "probe-a", role: "READINESS", kind: "probe", capabilities: [] },
        { id: "probe-b", role: "READINESS", kind: "probe", capabilities: [] }
      ]
    },
    { ...config, confidenceThreshold: 0 },
    fetchImpl
  );
  if (!result.ok) return { ok: false, code: result.reason, latencyMs: result.latencyMs };
  return { ok: true, latencyMs: result.latencyMs, model: result.model };
}

function parseChoice(
  body: unknown,
  allowed: ReadonlySet<string>
): Omit<NimbleChoiceSuccess, "latencyMs"> | Omit<NimbleChoiceFailure, "latencyMs"> {
  if (
    !isRecord(body) ||
    typeof body.model !== "string" ||
    !isRecord(body.answers) ||
    !isRecord(body.answers.executor)
  ) {
    return {
      ok: false,
      reason: "malformed_response",
      ...(typeof body === "object" && body && "model" in body ? {} : {})
    };
  }
  const answer = body.answers.executor;
  const model = body.model;
  if (answer.type !== "choice" || typeof answer.choice !== "string" || typeof answer.confidence !== "number") {
    return { ok: false, reason: "malformed_response", model };
  }
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    return { ok: false, reason: "malformed_response", model };
  }
  const probabilities = isRecord(answer.probabilities) ? numericProbabilities(answer.probabilities) : undefined;
  if (!probabilities) return { ok: false, reason: "malformed_response", model };
  if (!allowed.has(answer.choice)) {
    return { ok: false, reason: "unknown_executor", executorId: answer.choice, confidence: answer.confidence, model };
  }
  return { ok: true, executorId: answer.choice, confidence: answer.confidence, model, probabilities };
}

function numericProbabilities(value: Record<string, unknown>): Record<string, number> | undefined {
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "number" || !Number.isFinite(entry))) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
