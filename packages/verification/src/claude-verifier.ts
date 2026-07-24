import { spawn } from "node:child_process";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  verificationResultSchema,
  type CommandEvidence,
  type Verifier,
  type VerificationCriterion,
  type VerificationEvidence,
  type VerificationResult
} from "./types.js";

// Deliberately a fresh, self-contained allowlist rather than importing
// harness/claude-cli-provider.ts or packages/engine-adapter/src/env.ts:
// harness/ is not an npm workspace package (no package.json), so a
// packages/* package cannot depend on it without a relative import that
// reaches outside the workspace boundary every other package respects.
// Same deny-by-default shape as those two, independently maintained.
const claudeVerifierEnvAllowlist = ["HOME", "PATH", "SHELL", "TMPDIR", "USER", "ANTHROPIC_API_KEY"] as const;

function claudeVerifierEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of claudeVerifierEnvAllowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface ClaudeVerifierOptions {
  binary?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier. You did not produce the change under review and have no memory of producing it.

Evaluate only the supplied criteria and evidence. Evidence includes command
results (exit codes, stdout, stderr) that were captured by the harness, not
self-reported by the implementer - trust the command results over the
implementer's own claim about what happened when they disagree. If the
evidence is insufficient to judge a criterion either way, mark that
criterion unsatisfied and explain why in "observed" rather than guessing.

Return exactly one JSON object matching the required schema. No prose
outside the JSON. Do not request or infer the implementer's reasoning,
hidden state, or intentions - judge only what the evidence shows happened.`;

const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    summary: { type: "string" },
    criteriaResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterionId: { type: "string" },
          satisfied: { type: "boolean" },
          observed: { type: "string" }
        },
        required: ["criterionId", "satisfied", "observed"]
      }
    }
  },
  required: ["verdict", "summary", "criteriaResults"]
} as const;

export function buildClaudeVerifierArgs(model: string, maxBudgetUsd: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--system-prompt",
    VERIFIER_SYSTEM_PROMPT,
    "--json-schema",
    JSON.stringify(RESULT_JSON_SCHEMA)
  ];
}

interface ClaudeCliEnvelope {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
}

/**
 * Renders a verdict from evidence via a single, non-interactive, tools-
 * disabled Claude CLI call (--tools "" --permission-mode plan, matching
 * harness/claude-cli-provider.ts's proven invocation shape) - this engine
 * only ever reads evidence and judges it, it never touches the filesystem
 * or runs commands, which is exactly the shape an independent verifier
 * needs and the implementer engine (packages/engine-adapter's Codex
 * adapter) explicitly must not have.
 */
export class ClaudeVerifier implements Verifier {
  readonly engineId = "claude-cli-verifier" as const;
  private readonly binary: string;
  private readonly model: string;
  private readonly maxBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(options: ClaudeVerifierOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.model = options.model ?? "claude-sonnet-5";
    this.maxBudgetUsd = options.maxBudgetUsd ?? 0.5;
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 1_000;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async verify(criteria: VerificationCriterion[], evidence: VerificationEvidence): Promise<VerificationResult> {
    const started = Date.now();
    const prompt = buildVerificationPrompt(criteria, evidence);
    const raw = await this.invoke(prompt);
    const parsed = parseClaudeEnvelope(raw);
    const judged = JSON.parse(parsed) as unknown;
    return verificationResultSchema.parse({
      ...(judged as Record<string, unknown>),
      verifierEngineId: this.engineId,
      durationMs: Date.now() - started
    });
  }

  private invoke(prompt: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const args = buildClaudeVerifierArgs(this.model, this.maxBudgetUsd);
      const child = this.spawnFn(this.binary, args, {
        env: claudeVerifierEnv(),
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
        settle(() => reject(new ControlStackError("verifier_timeout", `verifier timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        settle(() => reject(new ControlStackError("verifier_process_error", error.message)));
      });
      child.on("close", (code) => {
        settle(() => {
          if (code !== 0) {
            reject(new ControlStackError("verifier_process_failed", `verifier exited with code ${code}`));
            return;
          }
          resolvePromise(stdout);
        });
      });

      child.stdin?.end(prompt, "utf8");
    });
  }
}

function buildVerificationPrompt(criteria: VerificationCriterion[], evidence: VerificationEvidence): string {
  return JSON.stringify({
    criteria,
    implementerClaim: evidence.implementerClaim,
    diffSummary: evidence.diffSummary,
    commandResults: evidence.commandResults satisfies CommandEvidence[]
  });
}

function parseClaudeEnvelope(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI returned invalid JSON");
  }
  const envelope = value as ClaudeCliEnvelope;
  if (envelope.type !== "result" || typeof envelope.subtype !== "string" || typeof envelope.is_error !== "boolean") {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI result is missing envelope fields");
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new ControlStackError("verifier_invalid_response", `verifier CLI call did not succeed (${envelope.subtype})`);
  }
  if (typeof envelope.result !== "string") {
    throw new ControlStackError("verifier_invalid_response", "verifier CLI result is missing the result field");
  }
  return envelope.result;
}
