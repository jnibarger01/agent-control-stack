import type { Readable, Writable } from "node:stream";
import { machineToolNames, type MachineController } from "@agent-control-stack/machine-controller";
import { ControlStackError } from "@agent-control-stack/shared";
import { ZodError, z } from "zod";

const protocolVersion = "2024-11-05";

type JsonRpcId = string | number | null;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional()
});

const toolsCallSchema = z.object({
  name: z.enum(machineToolNames),
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
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const length = contentLength(header);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      const response = await handleMcpRequest(this.controller, JSON.parse(body));
      if (response) {
        this.output.write(frameMessage(response));
      }
    }
  }
}

export async function handleMcpRequest(controller: MachineController, body: unknown): Promise<unknown | undefined> {
  const request = requestSchema.parse(body);
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

function contentLength(header: string): number {
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) {
    throw new Error("missing Content-Length header");
  }
  return Number(match[1]);
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
  return machineToolNames.map((name) => ({
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
  return { type: "object", properties: {} };
}
