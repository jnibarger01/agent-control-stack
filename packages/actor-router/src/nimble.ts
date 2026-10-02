import { performance } from "node:perf_hooks";
import { redactValue } from "@agent-control-stack/shared";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { routeActor, type ActorRoutingCandidate, type ActorRoutingDecision, type ActorRoutingInput } from "./index.js";

export const DEFAULT_NIMBLE_ROUTING_URL = "http://127.0.0.1:11434/v1/systemone";
export const DEFAULT_NIMBLE_ROUTING_MODEL = "nimble:latest";
export const DEFAULT_NIMBLE_ROUTING_THRESHOLD = 0.8;
export const DEFAULT_NIMBLE_ROUTING_TIMEOUT_MS = 1_200;
export const DEFAULT_NIMBLE_ROUTING_MAX_CANDIDATES = 8;
export const DEFAULT_NIMBLE_ROUTING_CONCURRENCY = 4;
export const NIMBLE_ROUTING_ALGORITHM_VERSION = "nimble.noul.highest-score.v1";
export const NIMBLE_ROUTING_QUESTION =
  "Is this candidate a strong, specific fit for the requested work? Answer yes only when its stated role, expertise, and capabilities directly match the work item's goal and requested actions; answer no when the fit is generic, adjacent, or unrelated.";
const MAX_NIMBLE_REQUEST_BYTES = 16_384;
const MAX_NIMBLE_RESPONSE_BYTES = 16_384;
const SCORE_TIE_EPSILON = 1e-9;

export type SemanticCandidateStatus = "MATCH" | "NO_MATCH" | "DEGRADED";
export type NimbleRoutingState =
  | "SELECTED"
  | "NO_SEMANTIC_MATCH"
  | "NO_ELIGIBLE_CANDIDATES"
  | "CANDIDATE_LIMIT_EXCEEDED"
  | "MODEL_TIMEOUT"
  | "MODEL_UNAVAILABLE"
  | "MODEL_INVALID_RESPONSE"
  | "REQUEST_TOO_LARGE";

export interface NimbleCandidateResult {
  agentId: string;
  score?: number;
  status: SemanticCandidateStatus;
  model?: string;
  modelVersion?: string;
  latencyMs: number;
  failureReason?: "timeout" | "unavailable" | "malformed_response" | "model_mismatch" | "request_too_large";
}

export interface NimbleRoutingStateInput {
  title: string;
  intent: string;
  requestedActionKinds: string[];
  requestedActionDescriptions: string[];
  targetServices: string[];
  targetRepositories: string[];
  candidateAgentId: string;
  candidateRole: string;
  candidateDescription: string;
  candidateCapabilities: string[];
}

export interface NimbleClientOptions {
  url?: string;
  model?: string;
  modelVersion?: string;
  threshold?: number;
  timeoutMs?: number;
  maxCandidates?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

export interface ActorNimbleRoutingInput extends ActorRoutingInput {
  agents: RegistryAgentDetail[];
  stateForAgent: (agent: RegistryAgentDetail) => NimbleRoutingStateInput;
  onEligibility?: (eligible: readonly string[], excluded: Readonly<Record<string, string[]>>) => void;
  onCandidate?: (candidate: NimbleCandidateResult) => void;
}

export interface ActorNimbleRoutingResult {
  decision: ActorRoutingDecision;
  selectedAgentId?: string;
  candidates: NimbleCandidateResult[];
  state: NimbleRoutingState;
}

export interface ValidatedNimbleOptions {
  url: string;
  model: string;
  modelVersion: string;
  threshold: number;
  timeoutMs: number;
  maxCandidates: number;
  concurrency: number;
}

export function validateNimbleRoutingOptions(options: NimbleClientOptions = {}): ValidatedNimbleOptions {
  const url = options.url ?? DEFAULT_NIMBLE_ROUTING_URL;
  const parsed = new URL(url);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "localhost";
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Nimble routing URL must be a loopback HTTP(S) endpoint without credentials, query, or fragment");
  }
  const threshold = options.threshold ?? DEFAULT_NIMBLE_ROUTING_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Nimble routing threshold must be between 0 and 1");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_NIMBLE_ROUTING_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Nimble routing timeout must be an integer between 1 and 30000 milliseconds");
  }
  const maxCandidates = options.maxCandidates ?? DEFAULT_NIMBLE_ROUTING_MAX_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32) {
    throw new Error("Nimble routing max candidates must be an integer between 1 and 32");
  }
  const concurrency = options.concurrency ?? DEFAULT_NIMBLE_ROUTING_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Nimble routing concurrency must be an integer between 1 and 8");
  }
  const model = options.model ?? DEFAULT_NIMBLE_ROUTING_MODEL;
  if (!model.trim() || model.length > 128) throw new Error("Nimble routing model is invalid");
  const modelVersion = options.modelVersion ?? model;
  if (!modelVersion.trim() || modelVersion.length > 128) throw new Error("Nimble model version is invalid");
  return { url, model, modelVersion, threshold, timeoutMs, maxCandidates, concurrency };
}

/** Evaluate one already-eligible candidate with only bounded semantic context. */
export async function evaluateNimbleCandidate(
  state: NimbleRoutingStateInput,
  options: NimbleClientOptions & { agentId: string }
): Promise<NimbleCandidateResult> {
  const config = validateNimbleRoutingOptions(options);
  const startedAt = performance.now();
  const failure = (failureReason: NimbleCandidateResult["failureReason"]): NimbleCandidateResult => ({
    agentId: options.agentId,
    status: "DEGRADED",
    model: config.model,
    modelVersion: config.modelVersion,
    latencyMs: Math.max(0, performance.now() - startedAt),
    failureReason
  });
  const safeState = sanitizeNimbleState(state);
  const requestBody = JSON.stringify({
    model: config.model,
    state: safeState,
    questions: { appropriate: { type: "noul", instructions: NIMBLE_ROUTING_QUESTION } }
  });
  if (Buffer.byteLength(requestBody, "utf8") > MAX_NIMBLE_REQUEST_BYTES) return failure("request_too_large");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    });
    if (!response.ok) return failure("unavailable");
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_NIMBLE_RESPONSE_BYTES) return failure("malformed_response");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_NIMBLE_RESPONSE_BYTES) return failure("malformed_response");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure("malformed_response");
    }
    if (!isRecord(body) || typeof body.model !== "string" || body.model !== config.model || !isRecord(body.answers)) {
      return failure("model_mismatch");
    }
    const answer = body.answers.appropriate;
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      return failure("malformed_response");
    }
    const latencyMs = Math.max(0, performance.now() - startedAt);
    return {
      agentId: options.agentId,
      score: answer.noul,
      status: answer.noul >= config.threshold ? "MATCH" : "NO_MATCH",
      model: body.model,
      modelVersion: config.modelVersion,
      latencyMs
    };
  } catch (error) {
    return failure(error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/** ACS determines eligibility first; Nimble's score is the authoritative semantic rank. */
export async function routeNimbleActor(
  input: ActorNimbleRoutingInput,
  client: NimbleClientOptions
): Promise<ActorNimbleRoutingResult> {
  const config = validateNimbleRoutingOptions(client);
  const eligibility = routeActor(input.agents, input);
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const eligibleAgentIds = [...eligibility.eligible].sort((left, right) => left.localeCompare(right));
  const emptyDecision: ActorRoutingDecision = { ...eligibility, eligible: eligibleAgentIds, selected: undefined };
  input.onEligibility?.(eligibleAgentIds, eligibility.excluded);
  if (eligibleAgentIds.length === 0) {
    return { decision: emptyDecision, candidates: [], state: "NO_ELIGIBLE_CANDIDATES" };
  }
  if (eligibleAgentIds.length > config.maxCandidates) {
    return { decision: emptyDecision, candidates: [], state: "CANDIDATE_LIMIT_EXCEEDED" };
  }

  const candidates = await mapBounded(eligibleAgentIds, config.concurrency, async (agentId) => {
    const agent = byId.get(agentId);
    if (!agent) return degradedCandidate(agentId, config, "unavailable");
    let result: NimbleCandidateResult;
    try {
      result = await evaluateNimbleCandidate(input.stateForAgent(agent), { ...client, agentId });
    } catch {
      result = degradedCandidate(agentId, config, "unavailable");
    }
    input.onCandidate?.(result);
    return result;
  });

  const failure = candidates.find((candidate) => candidate.status === "DEGRADED");
  if (failure) {
    const state: NimbleRoutingState =
      failure.failureReason === "timeout"
        ? "MODEL_TIMEOUT"
        : failure.failureReason === "request_too_large"
          ? "REQUEST_TOO_LARGE"
          : failure.failureReason === "malformed_response" || failure.failureReason === "model_mismatch"
            ? "MODEL_INVALID_RESPONSE"
            : "MODEL_UNAVAILABLE";
    return { decision: emptyDecision, candidates, state };
  }

  const matches = candidates
    .filter((candidate): candidate is NimbleCandidateResult & { score: number } => candidate.status === "MATCH")
    .sort((left, right) => {
      const delta = right.score - left.score;
      return Math.abs(delta) <= SCORE_TIE_EPSILON ? left.agentId.localeCompare(right.agentId) : delta;
    });
  const winner = matches[0];
  if (!winner) return { decision: emptyDecision, candidates, state: "NO_SEMANTIC_MATCH" };

  const semanticCandidates: ActorRoutingCandidate[] = candidates
    .filter((candidate): candidate is NimbleCandidateResult & { score: number } => candidate.score !== undefined)
    .sort((left, right) => {
      const delta = right.score - left.score;
      return Math.abs(delta) <= SCORE_TIE_EPSILON ? left.agentId.localeCompare(right.agentId) : delta;
    })
    .map((candidate) => ({
      id: candidate.agentId,
      score: Math.round(candidate.score * 10_000),
      reasons: [`Nimble semantic score ${(candidate.score * 100).toFixed(4)}%`]
    }));
  const decision: ActorRoutingDecision = {
    ...eligibility,
    eligible: eligibleAgentIds,
    selected: winner.agentId,
    candidates: semanticCandidates,
    scores: Object.fromEntries(
      candidates.flatMap((candidate) =>
        candidate.score === undefined ? [] : [[candidate.agentId, Math.round(candidate.score * 10_000)]]
      )
    )
  };
  return { decision, selectedAgentId: winner.agentId, candidates, state: "SELECTED" };
}

function sanitizeNimbleState(state: NimbleRoutingStateInput): Record<string, unknown> {
  const clean = (value: string, maximum: number): string => {
    let result = String(redactValue(value)).slice(0, maximum);
    for (const pattern of secretPatterns) result = result.replace(pattern, "[REDACTED]");
    return result;
  };
  return {
    title: clean(state.title, 2_048),
    intent: clean(state.intent, 2_048),
    requested_action_kinds: state.requestedActionKinds.slice(0, 16).map((value) => clean(value, 128)),
    requested_action_descriptions: state.requestedActionDescriptions.slice(0, 16).map((value) => clean(value, 1_024)),
    target_services: state.targetServices.slice(0, 16).map((value) => clean(value, 256)),
    target_repositories: state.targetRepositories.slice(0, 16).map((value) => clean(value, 256)),
    candidate_agent_id: clean(state.candidateAgentId, 128),
    candidate_role: clean(state.candidateRole, 128),
    candidate_description: clean(state.candidateDescription, 1_024),
    candidate_capabilities: state.candidateCapabilities.slice(0, 32).map((value) => clean(value, 128))
  };
}

function degradedCandidate(
  agentId: string,
  config: ValidatedNimbleOptions,
  failureReason: NimbleCandidateResult["failureReason"]
): NimbleCandidateResult {
  return {
    agentId,
    status: "DEGRADED",
    model: config.model,
    modelVersion: config.modelVersion,
    latencyMs: 0,
    failureReason
  };
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      result[index] = await worker(items[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const secretPatterns: readonly RegExp[] = [
  /\b(?:password|passwd|secret|credential|authorization|bearer|api[_-]?key|private[_-]?key|token)\s*[:=]\s*[^\s,;"']+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gu,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/gu
];
