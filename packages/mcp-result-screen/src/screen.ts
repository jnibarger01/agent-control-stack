import { redactValue, stableHash } from "@agent-control-stack/shared";
import { bindProvenance, provenanceMismatch, type McpResultProvenance, type ProvenanceExpectation } from "./provenance.js";

/**
 * Deterministic screening of an upstream MCP tool result.
 *
 * Every upstream result is untrusted input. The screened path is:
 *
 *   raw upstream result
 *     -> structural validation
 *     -> provenance binding
 *     -> deterministic screening (malformed / secret / injection / provenance /
 *        schema-drift)
 *     -> quarantine | accept
 *     -> (accept only) a bounded, redacted, normalised result for the caller
 *
 * Rules:
 *   - Instruction-like content stays DATA. `injection_pattern` is recorded as
 *     evidence; it never becomes control input and (alone) never quarantines,
 *     because ACS never executes result text as instructions.
 *   - Malformed structure, secret-bearing output, provenance mismatch, result
 *     payload/hash mismatch, and (for a protected tool) unaccepted schema drift
 *     all QUARANTINE: the payload is withheld and cannot reach a caller or
 *     become trusted evidence.
 *   - Screening never lowers a policy decision and never turns denied/untrusted
 *     content into allowed content. It is a post-execution trust boundary, not
 *     a policy engine.
 *   - Evidence is deterministic and payload-free: finding codes, bounded finding
 *     details (never the matched secret or text), hashes, and sizes.
 */

export type ScreenCode =
  | "structure_invalid"
  | "secret_bearing"
  | "injection_pattern"
  | "provenance_mismatch"
  | "result_hash_mismatch"
  | "schema_drift";

export type ScreenVerdict = "accept" | "quarantine";

/** Codes that force quarantine. `injection_pattern` is intentionally absent. */
const QUARANTINE_CODES: ReadonlySet<ScreenCode> = new Set<ScreenCode>([
  "structure_invalid",
  "secret_bearing",
  "provenance_mismatch",
  "result_hash_mismatch",
  "schema_drift"
]);

export interface ScreenFinding {
  readonly code: ScreenCode;
  /** Bounded, payload-free explanation. Never contains the matched secret/text. */
  readonly detail: string;
}

export interface ScreenedResult {
  /** Bounded, binary-stripped, secret-redacted text. */
  readonly text: string;
  readonly isError: boolean;
  readonly truncated: boolean;
  readonly omittedBlocks: number;
  readonly byteLength: number;
}

export interface ScreenEvidence {
  readonly schemaVersion: "acs.mcp-screen-evidence.v1";
  readonly verdict: ScreenVerdict;
  readonly findingCodes: readonly ScreenCode[];
  readonly provenanceHash: string;
  readonly resultHash: string;
  readonly observedToolSchemaFingerprint: string;
  readonly expectedToolSchemaFingerprint: string;
  readonly schemaDrift: boolean;
  readonly upstreamTextByteLength: number;
  readonly withheld: boolean;
  readonly screenedAt: string;
  /** Digest over every other field, so the evidence row is tamper-evident. */
  readonly evidenceHash: string;
}

export interface ScreenOutcome {
  readonly verdict: ScreenVerdict;
  readonly findings: readonly ScreenFinding[];
  readonly provenance: McpResultProvenance;
  readonly evidence: ScreenEvidence;
  /** Present ONLY when verdict === "accept". A quarantined outcome carries no payload. */
  readonly result?: ScreenedResult;
}

export interface ScreenInput {
  /** Untrusted upstream `tools/call` result. */
  readonly raw: unknown;
  /** Bound by ACS from boundary state, never read from the payload. */
  readonly binding: {
    readonly invocationId: string;
    readonly upstreamId: string;
    readonly toolName: string;
    readonly actionFingerprint: string | null;
  };
  readonly expected: ProvenanceExpectation & {
    /** The schema fingerprint ACS relies on for this tool. */
    readonly toolSchemaFingerprint: string;
    /** The fingerprint of the schema the upstream advertised this session. */
    readonly observedToolSchemaFingerprint: string;
    /** Fingerprints an operator has explicitly accepted (never auto-populated). */
    readonly acceptedToolSchemaFingerprints?: readonly string[];
  };
  /** A protected tool fails closed on unaccepted schema drift. */
  readonly protectedTool: boolean;
  readonly maxTextBytes?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;
const MAX_REDACT_LINE_LEN = 4096;
const TRUNCATION_MARKER = "\n[truncated]";

const INJECTION_PATTERNS: ReadonlyArray<{ group: string; re: RegExp }> = [
  { group: "instruction-override", re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions/gi },
  { group: "instruction-override", re: /disregard\s+(?:the\s+)?(?:above|previous|prior|system|earlier)/gi },
  { group: "role-reassignment", re: /you\s+are\s+now\s+(?:a|an|the)\b/gi },
  { group: "role-reassignment", re: /\bnew\s+(?:instructions|system\s+prompt)\s*:/gi },
  { group: "system-frame", re: /(?:^|\n)\s*(?:system|assistant|developer)\s*:/gi },
  { group: "system-frame", re: /<\s*\/?\s*(?:system|assistant|tool_call|function_call)\b/gi },
  { group: "system-frame", re: /"role"\s*:\s*"(?:system|developer)"/gi },
  { group: "tool-call-bait", re: /"(?:tool_calls|function_call)"\s*:/gi }
];

const SECRET_LIKE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP `tools/call` result: `{ content?: Block[], structuredContent?, isError? }`. */
function validateStructure(raw: unknown): { ok: true } | { ok: false; detail: string } {
  if (!isPlainObject(raw)) return { ok: false, detail: "result is not an object" };
  if ("content" in raw && raw.content !== undefined && !Array.isArray(raw.content)) {
    return { ok: false, detail: "content is present but not an array" };
  }
  if (Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (!isPlainObject(block) || typeof block.type !== "string") {
        return { ok: false, detail: "a content block is missing a string 'type'" };
      }
      if (block.type === "text" && typeof block.text !== "string") {
        return { ok: false, detail: "a text block has a non-string 'text'" };
      }
    }
  }
  if ("isError" in raw && raw.isError !== undefined && typeof raw.isError !== "boolean") {
    return { ok: false, detail: "isError is present but not a boolean" };
  }
  return { ok: true };
}

function stripBinary(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code === 0) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

function boundBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return { text: value, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  let sliced = buf.subarray(0, budget).toString("utf8");
  if (sliced.endsWith("�")) sliced = sliced.slice(0, -1);
  return { text: `${sliced}${TRUNCATION_MARKER}`, truncated: true };
}

function redactLines(value: string): { text: string; hits: number; lines: number } {
  const out: string[] = [];
  let hits = 0;
  let lines = 0;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.length > MAX_REDACT_LINE_LEN ? `${rawLine.slice(0, MAX_REDACT_LINE_LEN)}…` : rawLine;
    const redacted = redactValue(line);
    const redactedLine = typeof redacted === "string" ? redacted : String(redacted);
    if (redactedLine !== line || SECRET_LIKE.test(line)) {
      hits += 1;
      lines += 1;
    }
    out.push(redactedLine.replace(SECRET_LIKE, "[redacted]"));
  }
  return { text: out.join("\n"), hits, lines };
}

function detectInjection(value: string): ScreenFinding[] {
  const byGroup = new Map<string, number>();
  for (const { group, re } of INJECTION_PATTERNS) {
    const matches = value.match(re);
    if (matches && matches.length > 0) byGroup.set(group, (byGroup.get(group) ?? 0) + matches.length);
  }
  return [...byGroup.entries()].map(([group, count]) => ({
    code: "injection_pattern" as const,
    detail: `matched pattern group '${group}' (${count} occurrence${count === 1 ? "" : "s"})`
  }));
}

function resultPayloadHash(input: {
  toolName: string;
  isError: boolean;
  text: string;
  truncated: boolean;
  omittedBlocks: number;
  structuredContent: unknown;
}): string {
  return stableHash({
    domain: "acs.mcp-result-payload.v1",
    toolName: input.toolName,
    isError: input.isError,
    text: input.text,
    truncated: input.truncated,
    omittedBlocks: input.omittedBlocks,
    structuredContent: input.structuredContent ?? null
  });
}

/**
 * Screen one upstream MCP result. Pure and deterministic: the same `raw` +
 * `binding` + `expected` always yields the same `ScreenOutcome` (modulo the
 * injected clock), so a cache hit and a live response traverse identical
 * enforcement.
 */
export function screenMcpResult(input: ScreenInput): ScreenOutcome {
  const now = (input.now ?? (() => new Date()))();
  const maxBytes = input.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const findings: ScreenFinding[] = [];

  // 1. structural validation
  const structure = validateStructure(input.raw);
  const raw = structure.ok ? (input.raw as Record<string, unknown>) : {};
  if (!structure.ok) findings.push({ code: "structure_invalid", detail: structure.detail });

  // normalise text (bound -> redact -> bound), payload-free from here on
  const blocks = Array.isArray(raw.content) ? (raw.content as Array<Record<string, unknown>>) : [];
  const textParts: string[] = [];
  let omittedBlocks = 0;
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    else omittedBlocks += 1;
  }
  const stripped = stripBinary(textParts.join("\n"));
  const upstreamTextByteLength = Buffer.byteLength(stripped, "utf8");
  const prebound = boundBytes(stripped, maxBytes);
  const redaction = redactLines(prebound.text);
  const finalBound = boundBytes(redaction.text, maxBytes);
  const text = finalBound.text;
  const truncated = prebound.truncated || finalBound.truncated;
  const isError = raw.isError === true;

  // 2. secret screening (on the pre-redaction content)
  if (redaction.hits > 0) {
    findings.push({
      code: "secret_bearing",
      detail: `${redaction.hits} redaction hit(s) across ${redaction.lines} line(s)`
    });
  }

  // 3. injection screening — recorded as evidence; content still flows as DATA
  findings.push(...detectInjection(prebound.text));

  // 4. schema drift
  const accepted = new Set(input.expected.acceptedToolSchemaFingerprints ?? []);
  const schemaDrift =
    input.expected.observedToolSchemaFingerprint !== input.expected.toolSchemaFingerprint &&
    !accepted.has(input.expected.observedToolSchemaFingerprint);
  if (schemaDrift && input.protectedTool) {
    findings.push({
      code: "schema_drift",
      detail: "upstream tool schema fingerprint is neither the ACS-pinned value nor an accepted variant"
    });
  }

  // provenance binding + mismatch
  const resultHash = resultPayloadHash({
    toolName: input.binding.toolName,
    isError,
    text,
    truncated,
    omittedBlocks,
    structuredContent: raw.structuredContent
  });
  const provenance = bindProvenance(
    {
      invocationId: input.binding.invocationId,
      upstreamId: input.binding.upstreamId,
      toolName: input.binding.toolName,
      toolSchemaFingerprint: input.expected.toolSchemaFingerprint,
      actionFingerprint: input.binding.actionFingerprint,
      resultHash
    },
    now
  );
  const mismatched = provenanceMismatch(provenance, input.expected);
  for (const field of mismatched) {
    if (field === "resultHash") findings.push({ code: "result_hash_mismatch", detail: "result payload hash does not match the expected value" });
    else findings.push({ code: "provenance_mismatch", detail: `provenance field mismatch: ${field}` });
  }

  const verdict: ScreenVerdict = findings.some((f) => QUARANTINE_CODES.has(f.code)) ? "quarantine" : "accept";
  const withheld = verdict === "quarantine";

  const evidenceBase = {
    schemaVersion: "acs.mcp-screen-evidence.v1" as const,
    verdict,
    findingCodes: dedupe(findings.map((f) => f.code)),
    provenanceHash: provenance.provenanceHash,
    resultHash,
    observedToolSchemaFingerprint: input.expected.observedToolSchemaFingerprint,
    expectedToolSchemaFingerprint: input.expected.toolSchemaFingerprint,
    schemaDrift,
    upstreamTextByteLength,
    withheld,
    screenedAt: now.toISOString()
  };
  const evidence: ScreenEvidence = {
    ...evidenceBase,
    evidenceHash: stableHash({ domain: "acs.mcp-screen-evidence.v1", ...evidenceBase })
  };

  return {
    verdict,
    findings,
    provenance,
    evidence,
    ...(verdict === "accept"
      ? { result: { text, isError, truncated, omittedBlocks, byteLength: Buffer.byteLength(text, "utf8") } }
      : {})
  };
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
