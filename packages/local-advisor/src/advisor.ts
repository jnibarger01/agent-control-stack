import { type ReviewVerdict } from "@agent-control-stack/advisory";
import {
  ADVISOR_SCHEMA_VERSION,
  type AdvisorReason,
  type AdvisorRequest,
  type AdvisorResponse,
  AdvisorRequestError,
  advisorRequestSchema,
  advisorResponseSchema,
  type ModelReviewOutput,
  modelReviewOutputSchema
} from "./contracts.js";
import { buildPrompt, MODEL_OUTPUT_JSON_SCHEMA } from "./prompt.js";
import { ProviderError, type AdvisorProvider } from "./provider.js";
import { redactText } from "./redact.js";
import { canonicalJson, randomNonce, sha256Ref } from "./util.js";

export interface RunAdvisorOptions {
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

interface RedactedEvidence {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly sha256: `sha256:${string}`;
}

/** Deterministic checks the model output must pass before it is allowed to become a review. */
export function findModelOutputViolation(output: ModelReviewOutput, evidenceIds: ReadonlySet<string>): string | undefined {
  for (const finding of output.findings) {
    if (finding.evidenceIds.length === 0) return "finding cites no evidence";
    if (finding.evidenceIds.some((id) => !evidenceIds.has(id))) return "finding cites unknown evidence id";
  }
  if (output.verdict === "PASS" && output.findings.some((f) => f.severity === "high" || f.severity === "critical")) {
    return "PASS with high or critical finding";
  }
  if (output.verdict === "BLOCK" && output.findings.length === 0) return "BLOCK without findings";
  return undefined;
}

/**
 * Runs one advisory operation. Invariants:
 * - a request that fails `advisor.v1` throws `AdvisorRequestError` (caller error, never a review);
 * - no evidence means no inference and status `insufficient_evidence`;
 * - only a verified, schema-valid, coherent model output can produce a verdict (status `completed`);
 * - every failure is an explicit non-completed status with no verdict.
 */
export async function runAdvisor(
  input: unknown,
  provider: AdvisorProvider,
  options: RunAdvisorOptions = {}
): Promise<AdvisorResponse> {
  const parsed = advisorRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AdvisorRequestError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  const request: AdvisorRequest = parsed.data;
  const clock = options.now ?? Date.now;
  const started = clock();

  // Redact BEFORE hashing or inference so secrets never reach the model, the hashes, or telemetry.
  const evidence: RedactedEvidence[] = request.context.evidence.map((item) => {
    const redacted = redactText(item.content);
    return { id: item.id, kind: item.kind, text: redacted.text, sha256: sha256Ref(redacted.text) };
  });
  const evidenceHashes = Object.fromEntries(evidence.map((item) => [item.id, item.sha256]));
  const inputHash = sha256Ref(
    canonicalJson({
      schemaVersion: ADVISOR_SCHEMA_VERSION,
      operation: request.operation,
      mission: request.mission,
      objective: request.context.objective,
      constraints: request.context.constraints,
      evidence: evidence.map(({ id, sha256 }) => ({ id, sha256 }))
    })
  );

  const finish = (partial: Partial<AdvisorResponse> & Pick<AdvisorResponse, "status">, promptTokens?: number, completionTokens?: number) =>
    advisorResponseSchema.parse({
      schemaVersion: ADVISOR_SCHEMA_VERSION,
      requestId: request.requestId,
      missionId: request.mission.id,
      operation: request.operation,
      findings: [],
      recommendedActions: [],
      model: null,
      inputHash,
      evidenceHashes,
      ...partial,
      usage: {
        latencyMs: Math.max(0, clock() - started),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens })
      }
    });

  if (evidence.length === 0) {
    return finish({ status: "insufficient_evidence", reason: "no_evidence" satisfies AdvisorReason });
  }

  const nonce = randomNonce();
  const prompt = buildPrompt({
    operation: request.operation,
    objective: request.context.objective,
    constraints: request.context.constraints,
    evidence,
    nonce
  });

  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.budget.timeoutMs);

  try {
    let generated;
    try {
      generated = await provider.generate({
        system: prompt.system,
        user: prompt.user,
        format: MODEL_OUTPUT_JSON_SCHEMA,
        maxOutputTokens: request.budget.maxOutputTokens,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.kind === "aborted") {
          return timedOut
            ? finish({ status: "timeout", reason: "provider_timeout" })
            : finish({ status: "unavailable", reason: "cancelled" });
        }
        if (error.kind === "memory_pressure") return finish({ status: "unavailable", reason: "memory_pressure" });
        if (error.kind === "digest_mismatch") return finish({ status: "unavailable", reason: "model_digest_mismatch" });
        if (error.kind === "model_not_installed") return finish({ status: "unavailable", reason: "model_not_installed" });
        if (error.kind === "malformed_response") {
          return finish({ status: "invalid_output", reason: "model_output_invalid" });
        }
        return finish({ status: "unavailable", reason: "provider_unavailable" });
      }
      throw error;
    }

    const model = { provider: "ollama" as const, id: generated.modelId, digest: generated.digest };
    const usage = [generated.promptTokens, generated.completionTokens] as const;

    if (timedOut) return finish({ status: "timeout", reason: "provider_timeout", model }, ...usage);

    let raw: unknown;
    try {
      raw = JSON.parse(generated.text);
    } catch {
      return finish({ status: "invalid_output", reason: "model_output_invalid", model }, ...usage);
    }
    const output = modelReviewOutputSchema.safeParse(raw);
    if (!output.success) {
      return finish({ status: "invalid_output", reason: "model_output_schema_violation", model }, ...usage);
    }
    const violation = findModelOutputViolation(output.data, new Set(evidence.map((item) => item.id)));
    if (violation !== undefined) {
      return finish({ status: "invalid_output", reason: "model_output_incoherent", model }, ...usage);
    }

    const recommendedActions = output.data.recommendedActions;
    if (output.data.verdict === "INSUFFICIENT_EVIDENCE") {
      return finish(
        { status: "insufficient_evidence", reason: "model_reports_insufficient_evidence", model, recommendedActions },
        ...usage
      );
    }

    return finish(
      {
        status: "completed",
        verdict: output.data.verdict as ReviewVerdict,
        findings: output.data.findings.map((finding) => ({
          category: finding.category,
          severity: finding.severity,
          summary: finding.summary,
          evidenceRefs: finding.evidenceIds
        })),
        recommendedActions,
        model
      },
      ...usage
    );
  } finally {
    clearTimeout(timer);
  }
}
