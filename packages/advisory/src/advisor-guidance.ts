import { ZodError, z } from "zod";
import {
  advisorOutputDigest,
  type AdvisorCheckpoint,
  type AdvisorDisposition,
  type AdvisorModelId
} from "./advisor-consultation.js";

/**
 * Guidance text for the executor (ADR 0027).
 *
 * Authority packages must not import this module. Completion and policy use the
 * disposition view in `advisor-consultation.ts`.
 */

export const ADVISOR_SYSTEM_PROMPT = `You are an advisor consulted by an execution agent.

You are NOT the acting agent.
You cannot call tools, run commands, edit files, approve work, grant capabilities, or mark work complete.
Return ONLY a single JSON object with disposition "reviewed" or "declined".
When reviewed, include guidance. When declined, include declineReason.
Do not include approval, success, policy, routing, or lease fields.`;

export const ADVISOR_MAX_TOKENS = 2_000;

const reviewedSchema = z
  .object({
    disposition: z.literal("reviewed"),
    guidance: z.string().min(1).max(4_000)
  })
  .strict();

const declinedSchema = z
  .object({
    disposition: z.literal("declined"),
    declineReason: z.string().min(1).max(1_000)
  })
  .strict();

const advisorOutputSchema = z.union([reviewedSchema, declinedSchema]);

export interface AdvisorModelRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AdvisorModelResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AdvisorModelCaller {
  complete(request: AdvisorModelRequest): Promise<string | AdvisorModelResult>;
}

export function buildAdvisorModelRequest(input: {
  transportModel: string;
  checkpoint: AdvisorCheckpoint;
  projectionText: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): AdvisorModelRequest {
  return {
    model: input.transportModel,
    system: ADVISOR_SYSTEM_PROMPT,
    user: `CHECKPOINT ${input.checkpoint}\n\n${input.projectionText}\n\nAdvise the executor. JSON only.`,
    maxTokens: ADVISOR_MAX_TOKENS,
    timeoutMs: input.timeoutMs,
    signal: input.signal
  };
}

export type ParsedAdvisorOutput =
  | { disposition: "reviewed"; guidance: string; outputSha256: string }
  | { disposition: "declined"; declineReason: string; outputSha256: string };

export function parseAdvisorOutput(raw: string): ParsedAdvisorOutput {
  const parsed = advisorOutputSchema.parse(JSON.parse(raw) as unknown);
  if (parsed.disposition === "reviewed") {
    return {
      disposition: "reviewed",
      guidance: parsed.guidance,
      outputSha256: advisorOutputDigest("reviewed", parsed.guidance)
    };
  }
  return {
    disposition: "declined",
    declineReason: parsed.declineReason,
    outputSha256: advisorOutputDigest("declined", parsed.declineReason)
  };
}

export interface AdvisorConsultationDraft {
  disposition: AdvisorDisposition;
  guidance: string | null;
  declineReason: string | null;
  errorCode: string | null;
  outputSha256: string;
  inputTokens: number | null;
  outputTokens: number | null;
  advisorModelId: AdvisorModelId;
  transportModel: string;
}

function asResult(value: string | AdvisorModelResult): AdvisorModelResult {
  return typeof value === "string" ? { text: value } : value;
}

function unavailable(errorCode: string, model: AdvisorModelId, transportModel: string): AdvisorConsultationDraft {
  return {
    disposition: "unavailable",
    guidance: null,
    declineReason: null,
    errorCode,
    outputSha256: advisorOutputDigest("unavailable", errorCode),
    inputTokens: null,
    outputTokens: null,
    advisorModelId: model,
    transportModel
  };
}

export async function consultAdvisorModel(input: {
  caller: AdvisorModelCaller;
  advisorModelId: AdvisorModelId;
  transportModel: string;
  checkpoint: AdvisorCheckpoint;
  projectionText: string;
  timeoutMs?: number;
}): Promise<AdvisorConsultationDraft> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = buildAdvisorModelRequest({
      transportModel: input.transportModel,
      checkpoint: input.checkpoint,
      projectionText: input.projectionText,
      timeoutMs,
      signal: controller.signal
    });
    const result = asResult(await input.caller.complete(request));
    const parsed = parseAdvisorOutput(result.text);
    return {
      disposition: parsed.disposition,
      guidance: parsed.disposition === "reviewed" ? parsed.guidance : null,
      declineReason: parsed.disposition === "declined" ? parsed.declineReason : null,
      errorCode: null,
      outputSha256: parsed.outputSha256,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      advisorModelId: input.advisorModelId,
      transportModel: input.transportModel
    };
  } catch (error) {
    const code =
      error instanceof Error && error.name === "AbortError"
        ? "advisor_timeout"
        : error instanceof ZodError || error instanceof SyntaxError
          ? "advisor_output_invalid"
          : "advisor_unavailable";
    return unavailable(code, input.advisorModelId, input.transportModel);
  } finally {
    clearTimeout(timer);
  }
}
