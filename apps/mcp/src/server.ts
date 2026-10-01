import type { Readable, Writable } from "node:stream";
import { machineToolNames, type MachineController } from "@agent-control-stack/machine-controller";
import { ControlStackError } from "@agent-control-stack/shared";
import { ZodError, z } from "zod";

const protocolVersion = "2024-11-05";
const standaloneMcpToolNames = machineToolNames.filter((name) => name !== "test.agent.run");

// Framing bounds: a broken or hostile client must not be able to grow the read buffer
// without limit, and a declared body larger than this is refused instead of buffered.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

type JsonRpcId = string | number | null;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional()
});

const toolsCallSchema = z.object({
  name: z.enum(standaloneMcpToolNames),
  arguments: z.unknown().default({})
});

export class McpStdioServer {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly controller: MachineController
  ) {}

  start(): void {
    this.input.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      // Framing and request errors are handled per frame inside drain(); this last-resort
      // catch keeps an unexpected failure from becoming an unhandled rejection that would
      // take the stdio server down with the client still attached.
      void this.drain().catch((error: unknown) => {
        process.stderr.write(`acs-mcp: read loop failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
  }

  private async drain(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        // No header terminator yet. Garbage far past any real header means the stream
        // cannot be resynchronised from content, so drop it rather than buffer forever.
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.respond(failure(null, -32700, `MCP frame header exceeds ${MAX_HEADER_BYTES} bytes`));
        }
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const bodyStart = headerEnd + 4;
      const length = contentLength(header);
      if (length === null || length > MAX_FRAME_BYTES) {
        // The body length is unknown or unacceptable, so drop just the header and resync:
        // a following well-formed frame in the same chunk is still served.
        this.buffer = this.buffer.subarray(bodyStart);
        this.respond(
          failure(
            null,
            -32700,
            length === null ? "missing Content-Length header" : `MCP frame exceeds ${MAX_FRAME_BYTES} bytes`
          )
        );
        continue;
      }
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.respond(failure(null, -32700, "invalid JSON in MCP frame body"));
        continue;
      }

      const response = await this.handleRequest(parsed);
      if (response) {
        this.respond(response);
      }
    }
  }

  /** A malformed request must answer with an error, never abort the read loop. */
  private async handleRequest(body: unknown): Promise<unknown | undefined> {
    try {
      return await handleMcpRequest(this.controller, body);
    } catch (error) {
      return failure(requestId(body), -32603, errorMessage(error));
    }
  }

  private respond(message: unknown): void {
    this.output.write(frameMessage(message));
  }
}

export async function handleMcpRequest(controller: MachineController, body: unknown): Promise<unknown | undefined> {
  const parsedRequest = requestSchema.safeParse(body);
  if (!parsedRequest.success) {
    // An invalid request envelope is answered with -32600 (Invalid Request); the id is
    // echoed when the raw body carries a usable one so the client can correlate it.
    return failure(requestId(body), -32600, `invalid MCP request: ${errorMessage(parsedRequest.error)}`);
  }
  const request = parsedRequest.data;
  if (request.id === undefined) {
    return undefined;
  }

  try {
    switch (request.method) {
      case "initialize":
        return result(request.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "personal-machine-controller", version: "0.1.0" }
        });
      case "tools/list":
        return result(request.id, { tools: toolDefinitions() });
      case "tools/call": {
        const parsed = toolsCallSchema.parse(request.params);
        const structuredContent = await controller.callTool(parsed.name, parsed.arguments);
        return result(request.id, {
          content: [{ type: "text", text: `${parsed.name} completed.` }],
          structuredContent
        });
      }
      default:
        return failure(request.id, -32601, `unsupported MCP method: ${request.method}`);
    }
  } catch (error) {
    return failure(request.id, errorCode(error), errorMessage(error));
  }
}

export function frameMessage(message: unknown): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function contentLength(header: string): number | null {
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) {
    return null;
  }
  const length = Number(match[1]);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/** Recover a JSON-RPC id from an unvalidated body so errors can still be correlated. */
function requestId(body: unknown): JsonRpcId {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorCode(error: unknown): number {
  if (error instanceof ZodError) return -32602;
  if (error instanceof ControlStackError) return -32000;
  return -32603;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown MCP server error";
}

function toolDefinitions() {
  return standaloneMcpToolNames.map((name) => ({
    name,
    description: toolDescription(name),
    inputSchema: toolInputSchema(name)
  }));
}

function toolDescription(name: string): string {
  switch (name) {
    case "system.status":
      return "Return local machine health and MCP server metadata.";
    case "fs.list":
      return "List files under an allowlisted directory.";
    case "fs.stat":
      return "Return metadata for an allowlisted path.";
    case "fs.read":
      return "Read a text file under an allowlisted directory with line numbers and redaction.";
    case "fs.search_name":
      return "Search allowlisted paths by file or directory name.";
    case "cmd.preview":
      return "Classify a command without executing it.";
    case "cmd.run":
      return "Run a read-only allowlisted command with timeout, output caps, and audit logging.";
    case "test.agent.run":
      return "Run one allowed agent once from a clean JSON payload. Defaults to read-only and rejects write-capable direct runs.";
    default:
      return "Unknown tool.";
  }
}

function toolInputSchema(name: string): Record<string, unknown> {
  if (name.startsWith("fs.")) {
    return {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        max_depth: { type: "number" },
        start_line: { type: "number" },
        end_line: { type: "number" },
        query: { type: "string" },
        limit: { type: "number" }
      }
    };
  }
  if (name.startsWith("cmd.")) {
    return {
      type: "object",
      required: ["cwd", "command"],
      properties: {
        cwd: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } }
      }
    };
  }
  if (name === "test.agent.run") {
    return {
      type: "object",
      required: ["agent", "prompt"],
      additionalProperties: true,
      properties: {
        agent: { type: "string", enum: ["pi", "openclaw", "codex", "claude", "gemini", "opencode"] },
        prompt: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1 },
        permissionMode: { type: "string", enum: ["read-only", "readonly", "read_only"], default: "read-only" }
      }
    };
  }
  return { type: "object", properties: {} };
}
