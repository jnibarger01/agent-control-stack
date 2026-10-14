import type { Readable, Writable } from "node:stream";
import {
  ADVISOR_SCHEMA_VERSION,
  AdvisorRequestError,
  MAX_TOTAL_EVIDENCE_CHARS,
  advisorRequestSchema,
  type AdvisorOperation,
  type AdvisorResponse
} from "@agent-control-stack/local-advisor";

/** MCP protocol versions this server understands. A supported requested version is echoed; otherwise PROTOCOL_VERSION is offered. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
export const PROTOCOL_VERSION = "2024-11-05";
/**
 * Sized to carry any schema-valid request: MAX_TOTAL_EVIDENCE_CHARS of evidence plus objective (4,000) and
 * constraints (50 x 500), even when every character is JSON-escaped to 6 bytes (~1.7 MiB), with headroom.
 */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const LSP_HEADER = "content-length";
const HEADER_START = /^[A-Za-z0-9!#$%&'*+.^_`|~-]$/u;
const WHITESPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);
// A frame boundary we can trust after a rejected header: an empty line immediately followed by a Content-Length header.
const RESYNC_MARKER = `\r\n\r\n${LSP_HEADER}`;
/** Tool calls held at once (running or queued behind the provider semaphore). Further calls are refused, not queued. */
export const MAX_PENDING_TOOL_CALLS = 8;

export type AdvisorRunner = (request: unknown, signal: AbortSignal) => Promise<AdvisorResponse>;

const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const text = (max: number) => ({ type: "string", minLength: 1, maxLength: max });

const REQUEST_PROPS = {
  requestId: id,
  mission: {
    type: "object",
    additionalProperties: false,
    required: ["id", "envelopeHash"],
    properties: {
      id,
      envelopeHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
    }
  },
  context: {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: {
      objective: text(4000),
      constraints: { type: "array", maxItems: 50, items: text(500) },
      evidence: {
        type: "array",
        maxItems: 64,
        description: `Total content across all evidence items is limited to ${MAX_TOTAL_EVIDENCE_CHARS} characters.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "content"],
          properties: {
            id,
            kind: { type: "string", enum: ["file", "log", "tool_result", "test_report", "diff", "other"] },
            content: { type: "string", maxLength: 65536 }
          }
        }
      }
    }
  },
  budget: {
    type: "object",
    additionalProperties: false,
    required: ["timeoutMs", "maxOutputTokens"],
    properties: {
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
      maxOutputTokens: { type: "integer", minimum: 64, maximum: 4096 }
    }
  }
} as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function tool(name: string, operation: AdvisorOperation, title: string, description: string) {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "mission", "context", "budget"],
      properties: REQUEST_PROPS
    },
    annotations: READ_ONLY,
    operation
  };
}

export const TOOL_DEFINITIONS = [
  tool(
    "advisor_review_plan",
    "review_plan",
    "Local advisor: review a plan",
    "Advisory review of a proposed plan. The result is an untrusted recommendation. It does not approve, grant, or execute anything. Failures are explicit statuses, never a passing verdict."
  ),
  tool(
    "advisor_diagnose_failure",
    "diagnose_failure",
    "Local advisor: diagnose a failure",
    "Advisory diagnosis of a failure from the supplied evidence. Untrusted recommendation only. No shell, no writes, no policy override."
  ),
  tool(
    "advisor_review_completion",
    "review_completion",
    "Local advisor: review a completion claim",
    "Advisory check of whether a completion claim is supported by evidence. Untrusted recommendation only. A model failure is not a pass."
  )
] as const;

type Json = Record<string, unknown>;

export class LocalAdvisorMcpServer {
  private buffer = Buffer.alloc(0);
  private framing: "lsp" | "ndjson" | null = null;
  private pending = 0;
  private toolCalls = 0;
  private readonly inflight = new Map<string, AbortController>();
  private stopped = false;
  /** Body bytes of a rejected frame (declared length within the limit) still to be discarded. */
  private skipBytes = 0;
  /** After a rejected frame with no usable length: discard until RESYNC_MARKER. */
  private resyncing = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly run: AdvisorRunner
  ) {}

  start(): void {
    this.input.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_FRAME_BYTES * 2) {
        this.buffer = Buffer.alloc(0);
        this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } });
        return;
      }
      this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  async idle(): Promise<void> {
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private drain(): void {
    for (;;) {
      if (this.framing === null) {
        // Whitespace before the first frame is consumed from the buffer itself (not just skipped in a peek), so any
        // amount of it is dropped as it arrives and framing is always decided on the first real bytes.
        let lead = 0;
        while (lead < this.buffer.length && WHITESPACE.has(this.buffer[lead]!)) lead++;
        if (lead > 0) this.buffer = this.buffer.subarray(lead);
        const head = this.buffer.subarray(0, LSP_HEADER.length).toString("utf8").toLowerCase();
        if (head.length === 0) return;
        // Stdio may split a write anywhere: stay undecided while the prefix could still become "content-length".
        if (head.length < LSP_HEADER.length && LSP_HEADER.startsWith(head)) return;
        this.framing = head.startsWith(LSP_HEADER) ? "lsp" : "ndjson";
      }
      const body = this.framing === "lsp" ? this.nextLspFrame() : this.nextLine();
      if (body === null) return;
      if (body.length === 0) continue;
      void this.handleRaw(body);
    }
  }

  private nextLspFrame(): string | null {
    // RFC 9112 2.2 (robustness) lets a recipient ignore empty lines before a message, so stray CR/LF between
    // frames is skipped. Leading spaces or tabs are NOT skipped: whitespace before a header field is obsolete line
    // folding / an invalid field name (RFC 9112 2.2 and 5.2 require rejecting it), and the LSP base protocol
    // defines headers as starting at the first byte of the message. Such a frame fails the header parse below.
    if (this.skipBytes > 0) {
      const n = Math.min(this.skipBytes, this.buffer.length);
      this.buffer = this.buffer.subarray(n);
      this.skipBytes -= n;
      if (this.skipBytes > 0) return null;
    }
    if (this.resyncing && !this.resync()) return null;
    let skip = 0;
    while (skip < this.buffer.length && (this.buffer[skip] === 0x0d || this.buffer[skip] === 0x0a)) skip++;
    if (skip > 0) this.buffer = this.buffer.subarray(skip);
    // A frame must start with a header field name (RFC 9110 token). Anything else (an NDJSON line, an indented
    // header) is refused at once instead of waiting for a "\r\n\r\n" that may never come.
    if (this.buffer.length > 0 && !HEADER_START.test(String.fromCharCode(this.buffer[0]!))) {
      this.resyncing = true;
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid or oversized frame" } });
      return "";
    }
    const sep = this.buffer.indexOf("\r\n\r\n");
    if (sep < 0) return null;
    const header = this.buffer.subarray(0, sep).toString("utf8");
    // Exactly one Content-Length header whose value is all digits; anything else is refused.
    const lengths = header.split("\r\n").filter((line) => /^content-length\s*:/iu.test(line));
    const declared = lengths.map((line) => /^content-length\s*:\s*(\d+)\s*$/iu.exec(line)?.[1]);
    const len = lengths.length === 1 && declared[0] !== undefined ? Number(declared[0]) : NaN;
    if (!Number.isFinite(len) || len > MAX_FRAME_BYTES) {
      // Never search the rejected frame's body for a header: that body is attacker-controlled and could carry a
      // smuggled frame. If every Content-Length agrees on a length within the limit, skip exactly that many body
      // bytes. Otherwise the body's extent is unknown, so discard until an empty line followed by a header.
      const agreed = declared.length > 0 && declared.every((value) => value !== undefined && value === declared[0]);
      const skip = agreed ? Number(declared[0]) : NaN;
      if (Number.isFinite(skip) && skip <= MAX_FRAME_BYTES) {
        this.buffer = this.buffer.subarray(sep + 4);
        this.skipBytes = skip;
      } else {
        // With no length at all, no body was claimed, so the rejected header's own empty line is a boundary. An
        // oversized or conflicting length claims a body we cannot measure; its bytes are never a trusted boundary.
        this.buffer = this.buffer.subarray(
          lengths.length === 0 || declared.every((v) => v === undefined) ? sep : sep + 4
        );
        this.resyncing = true;
      }
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid or oversized frame" } });
      // An empty body tells drain to keep going with whatever is still buffered.
      return "";
    }
    const end = sep + 4 + len;
    if (this.buffer.length < end) return null;
    const body = this.buffer.subarray(sep + 4, end).toString("utf8");
    this.buffer = this.buffer.subarray(end);
    return body;
  }

  /**
   * Discards bytes until RESYNC_MARKER and leaves the buffer at the header that follows it. A marker split across
   * writes is kept (only the longest suffix that could still start the marker survives), so it is never dropped.
   */
  private resync(): boolean {
    const text = this.buffer.toString("latin1").toLowerCase();
    const at = text.indexOf(RESYNC_MARKER);
    if (at >= 0) {
      this.buffer = this.buffer.subarray(at + 4);
      this.resyncing = false;
      return true;
    }
    let keep = Math.min(RESYNC_MARKER.length - 1, text.length);
    while (keep > 0 && !RESYNC_MARKER.startsWith(text.slice(text.length - keep))) keep--;
    this.buffer = this.buffer.subarray(this.buffer.length - keep);
    return false;
  }

  private nextLine(): string | null {
    const nl = this.buffer.indexOf("\n");
    if (nl < 0) return null;
    const line = this.buffer.subarray(0, nl).toString("utf8").trim();
    this.buffer = this.buffer.subarray(nl + 1);
    if (line.length > MAX_FRAME_BYTES) {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "oversized message" } });
      return "";
    }
    return line;
  }

  private send(message: Json): void {
    if (this.stopped) return;
    const text = JSON.stringify(message);
    if (this.framing === "ndjson") this.output.write(`${text}\n`);
    else this.output.write(`Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`);
  }

  private async handleRaw(text: string): Promise<void> {
    this.pending += 1;
    const controller = new AbortController();
    let key: string | null = null;
    let countedToolCall = false;
    try {
      let msg: Json;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        msg = parsed as Json;
      } catch {
        this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      const idValue = msg.id;
      const method = msg.method;
      const isNotification = idValue === undefined;
      // JSON-RPC 2.0: an id is a string, a number, or null. Anything else is an invalid request.
      if (
        !isNotification &&
        idValue !== null &&
        typeof idValue !== "string" &&
        !(typeof idValue === "number" && Number.isFinite(idValue))
      ) {
        this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request id" } });
        return;
      }
      if (idValue !== undefined && idValue !== null) {
        const candidate = inflightKey(idValue);
        if (this.inflight.has(candidate)) {
          // Never overwrite the live controller: cancellation must keep targeting the original request.
          this.send({ jsonrpc: "2.0", id: idValue as never, error: { code: -32600, message: "duplicate request id" } });
          return;
        }
        key = candidate;
        this.inflight.set(key, controller);
      }
      if (typeof method !== "string") {
        if (!isNotification)
          this.send({ jsonrpc: "2.0", id: idValue as never, error: { code: -32600, message: "invalid request" } });
        return;
      }
      if (method === "tools/call") {
        if (this.toolCalls >= MAX_PENDING_TOOL_CALLS) {
          if (!isNotification)
            this.send({
              jsonrpc: "2.0",
              id: idValue as never,
              error: { code: -32000, message: "server busy: too many pending tool calls" }
            });
          return;
        }
        this.toolCalls += 1;
        countedToolCall = true;
      }
      try {
        const result = await this.dispatch(method, (msg.params ?? {}) as Json, controller.signal);
        if (!isNotification && result !== undefined) this.send({ jsonrpc: "2.0", id: idValue as never, result });
      } catch (error) {
        if (isNotification) return;
        const message = error instanceof Error ? error.message : "internal error";
        this.send({ jsonrpc: "2.0", id: idValue as never, error: { code: -32603, message: message.slice(0, 200) } });
      }
    } finally {
      if (key) this.inflight.delete(key);
      if (countedToolCall) this.toolCalls -= 1;
      this.pending -= 1;
    }
  }

  private async dispatch(method: string, params: Json, signal: AbortSignal): Promise<Json | undefined> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const compatible =
          typeof requested !== "string" || (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested);
        return {
          // MCP lifecycle: when the requested revision is supported, answer with that same revision.
          protocolVersion: compatible && typeof requested === "string" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "acs-local-advisor", version: "0.1.0", contract: ADVISOR_SCHEMA_VERSION },
          compatibility: { requested: requested ?? null, compatible, supported: SUPPORTED_PROTOCOL_VERSIONS },
          instructions:
            "Advisory-only local reviews. Tools advisor_review_plan, advisor_diagnose_failure, advisor_review_completion. A response status other than completed has no verdict. completed is still not authorization."
        };
      }
      case "notifications/initialized":
        return undefined;
      case "notifications/cancelled": {
        const requestId = params.requestId ?? params.request_id;
        if (requestId !== undefined && requestId !== null) this.inflight.get(inflightKey(requestId))?.abort();
        return undefined;
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: TOOL_DEFINITIONS.map(({ operation: _operation, ...toolDef }) => toolDef)
        };
      case "tools/call":
        return this.callTool(params, signal);
      default:
        throw new Error(`method not found: ${method.slice(0, 80)}`);
    }
  }

  private async callTool(params: Json, signal: AbortSignal): Promise<Json> {
    const name = params.name;
    const args = params.arguments ?? {};
    const definition = TOOL_DEFINITIONS.find((toolDef) => toolDef.name === name);
    if (!definition) return toolError("UNKNOWN_TOOL", "unknown tool");
    if (!args || typeof args !== "object" || Array.isArray(args))
      return toolError("INVALID_REQUEST", "arguments must be an object");
    const raw = args as Json;
    const request = {
      ...raw,
      schemaVersion: ADVISOR_SCHEMA_VERSION,
      operation: definition.operation
    };
    const parsed = advisorRequestSchema.safeParse(request);
    if (!parsed.success) {
      return toolError(
        "INVALID_REQUEST",
        new AdvisorRequestError(parsed.error.issues.map((issue) => issue.message).join("; ")).message
      );
    }
    try {
      const response = await this.run(parsed.data, signal);
      const text = JSON.stringify(response);
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        return toolError("RESPONSE_TOO_LARGE", "advisor response exceeded the size bound");
      }
      return { content: [{ type: "text", text }], structuredContent: response, isError: false };
    } catch (error) {
      if (error instanceof AdvisorRequestError) return toolError("INVALID_REQUEST", error.message);
      const code =
        error instanceof Error && error.name === "ModelRouteError" ? "MODEL_NOT_INSTALLED" : "ADVISOR_FAILED";
      return toolError(code, "the advisor did not produce a review");
    }
  }
}

function toolError(code: string, message: string): Json {
  const body = { error: { code, message }, status: "unavailable", verdict: null };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

/** Distinguishes `1` from `"1"`: JSON-RPC ids are compared by type and value. */
function inflightKey(id: unknown): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}
