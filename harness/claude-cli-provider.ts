import { spawn } from "node:child_process";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ModelTokenUsage,
  ModelUsageReceipt
} from "./model-provider.js";
import { ModelProviderError } from "./model-provider.js";

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

// Mirrors packages/machine-controller/src/command.ts's subprocessEnvAllowlist:
// deny-by-default rather than redact-after-the-fact. ANTHROPIC_API_KEY is added
// because headless `claude` CLI auth needs it when no interactive session exists.
// HTTPS_PROXY/HTTP_PROXY/NO_PROXY/NODE_EXTRA_CA_CERTS/SSL_CERT_FILE are non-secret
// network configuration, not credentials - omitting them silently breaks the CLI
// in proxied or private-CA deployments (https://code.claude.com/docs/en/network-config).
export const claudeCliEnvAllowlist = [
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "ANTHROPIC_API_KEY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
] as const;

export function claudeCliSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of claudeCliEnvAllowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface ClaudeCliProviderOptions {
  binary?: string;
  cwd: string;
  maxOutputBytes?: number;
}

interface ClaudeCliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  stop_reason: string | null;
  duration_ms: number;
  total_cost_usd: number;
  modelUsage?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  terminal_reason?: string;
}

export function buildClaudeCliArgs(request: CompletionRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    request.model,
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
    "--exclude-dynamic-system-prompt-sections",
    "--max-budget-usd",
    String(request.maxBudgetUsd),
    "--system-prompt",
    request.system
  ];

  if (request.jsonSchema) {
    args.push("--json-schema", JSON.stringify(request.jsonSchema));
  }

  return args;
}

export function parseClaudeCliResult(raw: string, requestedModel: string): CompletionResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelProviderError("invalid_response", "Claude CLI returned invalid JSON");
  }

  if (!isRecord(value)) {
    throw new ModelProviderError("invalid_response", "Claude CLI result must be an object");
  }

  const parsed = value as unknown as ClaudeCliResult;
  if (parsed.type !== "result" || typeof parsed.subtype !== "string" || typeof parsed.is_error !== "boolean") {
    throw new ModelProviderError("invalid_response", "Claude CLI result is missing envelope fields");
  }

  if (parsed.is_error || parsed.subtype !== "success") {
    const budgetSignal = `${parsed.subtype} ${parsed.terminal_reason ?? ""}`.toLowerCase().includes("budget");
    throw new ModelProviderError(budgetSignal ? "budget" : "api", `Claude CLI call did not succeed (${parsed.subtype})`);
  }

  if (
    typeof parsed.result !== "string" ||
    (typeof parsed.stop_reason !== "string" && parsed.stop_reason !== null) ||
    !isFiniteNumber(parsed.duration_ms) ||
    !isFiniteNumber(parsed.total_cost_usd)
  ) {
    throw new ModelProviderError("invalid_response", "Claude CLI result is missing required fields");
  }

  const modelUsage = parseModelUsage(parsed.modelUsage);
  const usage = modelUsage.length > 0 ? sumUsage(modelUsage) : parseTopLevelUsage(parsed.usage);

  return {
    text: parsed.result,
    requestedModel,
    exactModels: modelUsage.map((entry) => entry.model).sort(),
    stopReason: parsed.stop_reason,
    refused: parsed.stop_reason === "refusal",
    costUsd: parsed.total_cost_usd,
    durationMs: parsed.duration_ms,
    usage,
    modelUsage
  };
}

export class ClaudeCliProvider implements ModelProvider {
  private readonly binary: string;
  private readonly cwd: string;
  private readonly maxOutputBytes: number;

  constructor(options: ClaudeCliProviderOptions) {
    this.binary = options.binary ?? "claude";
    this.cwd = options.cwd;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const raw = await this.invoke(request);
    return parseClaudeCliResult(raw, request.model);
  }

  private invoke(request: CompletionRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, buildClaudeCliArgs(request), {
        cwd: this.cwd,
        env: claudeCliSubprocessEnv(),
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
        finish(() => reject(new ModelProviderError("timeout", `Claude CLI timed out after ${request.timeoutMs}ms`)));
      }, request.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > this.maxOutputBytes) {
          child.kill("SIGTERM");
          finish(() => reject(new ModelProviderError("output_limit", "Claude CLI output exceeded the configured cap")));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        if (Buffer.byteLength(stderr, "utf8") <= 4_096) stderr += chunk;
      });
      child.on("error", (error) => {
        finish(() => reject(new ModelProviderError("process", `Claude CLI could not start: ${error.message}`)));
      });
      child.on("close", (code) => {
        finish(() => {
          if (code !== 0) {
            if (stdout.trim()) {
              try {
                parseClaudeCliResult(stdout, request.model);
              } catch (error) {
                if (error instanceof ModelProviderError) {
                  reject(error);
                  return;
                }
              }
            }
            const suffix = stderr.trim() ? ` (stderr ${Buffer.byteLength(stderr, "utf8")} bytes; content suppressed)` : "";
            reject(new ModelProviderError("process", `Claude CLI exited with code ${code}${suffix}`, code ?? undefined));
            return;
          }
          resolve(stdout);
        });
      });

      child.stdin.end(request.prompt, "utf8");
    });
  }
}

function parseModelUsage(value: unknown): ModelUsageReceipt[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([model, raw]) => {
    if (!isRecord(raw)) {
      throw new ModelProviderError("invalid_response", `Invalid model usage receipt for ${model}`);
    }
    return {
      model,
      inputTokens: requiredNumber(raw, "inputTokens"),
      outputTokens: requiredNumber(raw, "outputTokens"),
      cacheReadInputTokens: optionalNumber(raw, "cacheReadInputTokens"),
      cacheCreationInputTokens: optionalNumber(raw, "cacheCreationInputTokens"),
      costUsd: requiredNumber(raw, "costUSD")
    };
  });
}

function parseTopLevelUsage(value: unknown): ModelTokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  }
  return {
    inputTokens: optionalNumber(value, "input_tokens"),
    outputTokens: optionalNumber(value, "output_tokens"),
    cacheReadInputTokens: optionalNumber(value, "cache_read_input_tokens"),
    cacheCreationInputTokens: optionalNumber(value, "cache_creation_input_tokens")
  };
}

function sumUsage(receipts: ModelUsageReceipt[]): ModelTokenUsage {
  return receipts.reduce<ModelTokenUsage>(
    (sum, receipt) => ({
      inputTokens: sum.inputTokens + receipt.inputTokens,
      outputTokens: sum.outputTokens + receipt.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + receipt.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + receipt.cacheCreationInputTokens
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  );
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!isFiniteNumber(field)) {
    throw new ModelProviderError("invalid_response", `Missing numeric field ${key}`);
  }
  return field;
}

function optionalNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return field === undefined ? 0 : requiredNumber(value, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
