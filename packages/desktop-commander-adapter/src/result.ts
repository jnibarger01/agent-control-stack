import { redactValue, stableHash } from "@agent-control-stack/shared";
import type { McpToolCallResult } from "./mcp-stdio-client.js";

/**
 * Phase 11 - bounded + redacted result capture.
 *
 * The raw MCP result is normalised into a fixed shape: text content is
 * extracted, NUL/binary bytes are stripped, secrets are redacted with the
 * shared `redactValue`, and the payload is capped. Non-text content blocks
 * (images, resources) are summarised, never inlined. Result-storage failure
 * upstream must never be reported as success - this module only produces the
 * bounded value; the worker decides lifecycle.
 */

/**
 * Payload-free summary of the post-execution result screening (see
 * `@agent-control-stack/mcp-result-screen`). Present on every
 * `MachineExecutionResult` produced from a real upstream MCP call. A
 * `quarantine` verdict means the upstream payload was withheld: `output` is
 * empty and `isError` is true.
 */
export interface ResultScreenSummary {
  verdict: "accept" | "quarantine";
  withheld: boolean;
  findingCodes: readonly string[];
  provenanceHash: string;
  evidenceHash: string;
  /** true when the observed upstream schema differs from the pinned/accepted set. */
  schemaDrift: boolean;
  /** true only when this tool has a pinned upstream schema fingerprint (drift is then quarantining). */
  schemaPinEnforced: boolean;
  /** Canonical fingerprint of the upstream-advertised `inputSchema` this call saw. */
  observedSchemaFingerprint: string;
}

export interface MachineExecutionResult {
  toolName: string;
  invocationFingerprint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Desktop Commander flagged the call as an error, OR ACS screening withheld the result. */
  isError: boolean;
  /** Bounded + redacted textual output. Empty when the result was quarantined. */
  output: string;
  /** Bounded + redacted error text when `isError`. */
  error?: string;
  /** Whether `output` was truncated to fit the byte cap. */
  truncated: boolean;
  /** Deterministic hash of the normalised result for replay detection. */
  resultHash: string;
  /** Count of non-text content blocks that were summarised out. */
  omittedBlocks: number;
  /** Post-execution screening outcome. Absent only on transport failure before any result. */
  screen?: ResultScreenSummary;
}

function stripBinary(value: string): string {
  // Remove NUL and C0 control chars except tab/newline/carriage-return.
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    cleaned += char;
  }
  return cleaned;
}

const TRUNCATION_MARKER = "\n[truncated]";

function boundBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  // Slice on a byte boundary, then drop a trailing partial UTF-8 sequence.
  let sliced = buffer.subarray(0, budget).toString("utf8");
  if (sliced.endsWith("�")) sliced = sliced.slice(0, -1);
  return { text: `${sliced}${TRUNCATION_MARKER}`, truncated: true };
}

const MAX_REDACT_LINE_LEN = 4096;

/**
 * Redact line-by-line with a per-line length cap. The shared `redactValue`
 * regex set contains alternations that backtrack quadratically on very long
 * lines of adversary-controlled output, so we never feed it an unbounded line.
 */
function redactText(value: string): string {
  const out: string[] = [];
  for (const rawLine of value.split("\n")) {
    const line = rawLine.length > MAX_REDACT_LINE_LEN ? `${rawLine.slice(0, MAX_REDACT_LINE_LEN)}…` : rawLine;
    const redacted = redactValue(line);
    out.push(typeof redacted === "string" ? redacted : String(redacted));
  }
  return out.join("\n");
}

export interface NormalizeResultOptions {
  toolName: string;
  invocationFingerprint: string;
  startedAt: Date;
  completedAt: Date;
  maxResultBytes: number;
}

export function normalizeToolResult(raw: McpToolCallResult, options: NormalizeResultOptions): MachineExecutionResult {
  const blocks = Array.isArray(raw?.content) ? raw.content : [];
  const textParts: string[] = [];
  let omittedBlocks = 0;
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else {
      omittedBlocks += 1;
    }
  }
  // Bound BEFORE redaction so the redaction regexes never see an unbounded
  // blob, then redact, then bound again in case redaction changed the length.
  const stripped = stripBinary(textParts.join("\n"));
  const prebound = boundBytes(stripped, options.maxResultBytes);
  const redacted = redactText(prebound.text);
  const finalBound = boundBytes(redacted, options.maxResultBytes);
  const text = finalBound.text;
  const truncated = prebound.truncated || finalBound.truncated;
  const isError = raw?.isError === true;

  const resultHash = stableHash({
    domain: "acs.desktop-commander-result.v1",
    toolName: options.toolName,
    invocationFingerprint: options.invocationFingerprint,
    isError,
    output: text,
    truncated,
    omittedBlocks
  });

  return {
    toolName: options.toolName,
    invocationFingerprint: options.invocationFingerprint,
    startedAt: options.startedAt.toISOString(),
    completedAt: options.completedAt.toISOString(),
    durationMs: Math.max(0, options.completedAt.getTime() - options.startedAt.getTime()),
    isError,
    output: text,
    ...(isError ? { error: text.length > 0 ? text : "Desktop Commander reported an error" } : {}),
    truncated,
    resultHash,
    omittedBlocks
  };
}
