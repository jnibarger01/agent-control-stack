import { performance } from "node:perf_hooks";
import { redactValue } from "@agent-control-stack/shared";
import type {
  PrivilegedTransitionOptions,
  RecordActorRoutingDecisionInput,
  RegistryAgentDetail
} from "@agent-control-stack/work-items";
import {
  routeActor,
  type ActorRoutingDecision,
  type ActorRoutingInput,
  type ActorRoutingPersistence
} from "./index.js";

export const DEFAULT_NIMBLE_ROUTING_URL = "http://127.0.0.1:11434/v1/systemone";
export const DEFAULT_NIMBLE_ROUTING_MODEL = "nimble:latest";
export const DEFAULT_NIMBLE_ROUTING_THRESHOLD = 0.8;
export const NIMBLE_ROUTING_QUESTION = "Is this candidate agent semantically appropriate to own this work item?";

export type SemanticCandidateStatus = "MATCH" | "NO_MATCH" | "DEGRADED";

export interface NimbleCandidateResult {
  agentId: string;
  score?: number;
  status: SemanticCandidateStatus;
  model?: string;
  latencyMs: number;
  failureReason?: string;
}

export interface NimbleRoutingState {
  work_item_id: string;
  title: string;
  instructions: string;
  requested_action_kind: string;
  requested_action_description: string;
  target_service?: string;
  candidate_agent: string;
  candidate_role: string;
  candidate_capabilities: string[];
}

export interface NimbleClientOptions {
  url?: string;
  model?: string;
  threshold?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ActorNimbleRoutingInput extends ActorRoutingInput {
  agents: RegistryAgentDetail[];
  workItemId: string;
  stateForAgent: (agent: RegistryAgentDetail) => NimbleRoutingState;
  idempotencyKey: string;
  now?: Date;
  onCandidate?: (candidate: NimbleCandidateResult) => void;
}

export interface ActorNimbleRoutingResult {
  decision: ActorRoutingDecision;
  selectedAgentId?: string;
  candidates: NimbleCandidateResult[];
  state: "SELECTED" | "NO_SEMANTIC_MATCH" | "DEGRADED" | "NO_ELIGIBLE_AGENTS";
  persisted?: Awaited<ReturnType<ActorRoutingPersistence["recordActorRoutingDecision"]>>;
}

const defaultTimeoutMs = 750;
const inlineSecretPatterns: readonly RegExp[] = [
  /\b(?:password|passwd|secret|credential|authorization|bearer|api[_-]?key|private[_-]?key|token)\s*[:=]\s*[^\s,;"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g
];

export function validateNimbleRoutingOptions(
  options: NimbleClientOptions = {}
): Required<Pick<NimbleClientOptions, "url" | "model" | "threshold" | "timeoutMs">> {
  const url = options.url ?? DEFAULT_NIMBLE_ROUTING_URL;
  const parsedUrl = new URL(url);
  if (!(
    ["http:", "https:"].includes(parsedUrl.protocol) &&
    !parsedUrl.username &&
    !parsedUrl.password &&
    !parsedUrl.search &&
    !parsedUrl.hash
  )) {
    throw new Error("Nimble routing URL must be an HTTP(S) endpoint without credentials, query, or fragment");
  }
  const threshold = options.threshold ?? DEFAULT_NIMBLE_ROUTING_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Nimble routing threshold must be between 0 and 1");
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Nimble routing timeout must be an integer between 1 and 30000 milliseconds");
  }
  const model = options.model ?? DEFAULT_NIMBLE_ROUTING_MODEL;
  if (!model.trim() || model.length > 128) throw new Error("Nimble routing model is invalid");
  return { url, model, threshold, timeoutMs };
}

/** Evaluate exactly one ACS-eligible candidate using the local TypeSafe Noul contract. */
export async function evaluateNimbleCandidate(
  state: NimbleRoutingState,
  options: NimbleClientOptions & { agentId: string }
): Promise<NimbleCandidateResult> {
  const config = validateNimbleRoutingOptions(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const safeState = sanitizeNimbleState(redactValue(state)) as NimbleRoutingState;
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        state: safeState,
        questions: { appropriate: { type: "noul", instructions: NIMBLE_ROUTING_QUESTION } }
      }),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    });
    const latencyMs = Math.max(0, performance.now() - startedAt);
    if (!response.ok) {
      return {
        agentId: options.agentId,
        status: "DEGRADED",
        model: config.model,
        latencyMs,
        failureReason: `http_${response.status}`
      };
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 16_384) {
      return {
        agentId: options.agentId,
        status: "DEGRADED",
        model: config.model,
        latencyMs,
        failureReason: "response_too_large"
      };
    }
    const text = await response.text();
    if (text.length > 16_384) {
      return {
        agentId: options.agentId,
        status: "DEGRADED",
        model: config.model,
        latencyMs,
        failureReason: "response_too_large"
      };
    }
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
      return {
        agentId: options.agentId,
        status: "DEGRADED",
        model: config.model,
        latencyMs,
        failureReason: "malformed_response"
      };
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
      return {
        agentId: options.agentId,
        status: "DEGRADED",
        model: body.model,
        latencyMs,
        failureReason: "malformed_response"
      };
    }
    const score = answer.noul;
    return {
      agentId: options.agentId,
      score,
      status: score >= config.threshold ? "MATCH" : "NO_MATCH",
      model: body.model,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Math.max(0, performance.now() - startedAt);
    const failureReason = error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable";
    return { agentId: options.agentId, status: "DEGRADED", model: config.model, latencyMs, failureReason };
  } finally {
    clearTimeout(timer);
  }
}

/** ACS applies hard eligibility first, asks Nimble only about eligible agents, then uses routeActor to select and persist. */
export async function routeNimbleActor(
  input: ActorNimbleRoutingInput,
  client: NimbleClientOptions,
  persistence: ActorRoutingPersistence,
  transition: PrivilegedTransitionOptions
): Promise<ActorNimbleRoutingResult> {
  const config = validateNimbleRoutingOptions(client);
  const eligibility = routeActor(input.agents, input);
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const candidates: NimbleCandidateResult[] = [];
  for (const agentId of eligibility.eligible) {
    const agent = byId.get(agentId);
    if (!agent) continue;
    let result: NimbleCandidateResult;
    try {
      result = await evaluateNimbleCandidate(input.stateForAgent(agent), {
        ...client,
        agentId,
        threshold: config.threshold
      });
    } catch {
      result = {
        agentId,
        status: "DEGRADED",
        model: config.model,
        latencyMs: 0,
        failureReason: "invalid_configuration"
      };
    }
    candidates.push(result);
    input.onCandidate?.(result);
  }

  const matches = candidates
    .filter((candidate) => candidate.status === "MATCH")
    .map((candidate) => byId.get(candidate.agentId)!)
    .filter(Boolean);
  const selected = routeActor(matches, { ...input, now: input.now });
  const excluded = {
    ...eligibility.excluded,
    ...Object.fromEntries(
      candidates
        .filter((candidate) => candidate.status !== "MATCH")
        .map((candidate) => [
          candidate.agentId,
          [
            candidate.status === "NO_MATCH"
              ? "NO_SEMANTIC_MATCH"
              : `NIMBLE_DEGRADED:${candidate.failureReason ?? "unknown"}`
          ]
        ])
    )
  };
  const finalDecision = { ...selected, excluded };
  const persisted = persistence.recordActorRoutingDecision(
    {
      workItemId: input.workItemId,
      ...(selected.selected ? { selectedActorId: selected.selected } : {}),
      // Persist the ACS hard-eligible pool separately from model suitability.
      eligible: eligibility.eligible,
      excluded,
      scores: finalDecision.scores,
      idempotencyKey: input.idempotencyKey
    } satisfies RecordActorRoutingDecisionInput,
    transition
  );
  const state = finalDecision.selected
    ? "SELECTED"
    : eligibility.eligible.length === 0
      ? "NO_ELIGIBLE_AGENTS"
      : candidates.some((candidate) => candidate.status === "DEGRADED")
        ? "DEGRADED"
        : "NO_SEMANTIC_MATCH";
  return {
    decision: finalDecision,
    ...(finalDecision.selected ? { selectedAgentId: finalDecision.selected } : {}),
    candidates,
    state,
    persisted
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeNimbleState(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    let output = value.slice(0, 8_192);
    for (const pattern of inlineSecretPatterns) output = output.replace(pattern, "[REDACTED]");
    return output;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeNimbleState(entry, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([key, entry]) => [key.slice(0, 128), sanitizeNimbleState(entry, depth + 1)])
  );
}
