import type { Readable, Writable } from "node:stream";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  EVIDENCE_READ_CAPABILITIES,
  assertNoForbiddenCapability,
  type EvidenceReadSurface
} from "@agent-control-stack/evidence";
import { ZodError, z } from "zod";

/**
 * Standalone, attempt-scoped, READ-ONLY evidence MCP server (ADR 0015).
 *
 * The tool set is EXACTLY `EVIDENCE_READ_CAPABILITIES`. There is no
 * `tools/call` branch that writes, executes, approves, or transitions
 * anything. It is not routed through the gateway, so the public contract
 * surface is untouched, and reviewer auth is a separate `acs:evidence:read`
 * grant (see `authorize.ts`).
 */

const protocolVersion = "2024-11-05";

// Fail-closed guard: the advertised tool set must never contain a privileged
// capability. This is asserted here and again in tests.
{
  const violations = assertNoForbiddenCapability([...EVIDENCE_READ_CAPABILITIES]);
  if (violations.length > 0) {
    throw new Error(`evidence-mcp advertises a privileged capability: ${JSON.stringify(violations)}`);
  }
}

export const EVIDENCE_MCP_TOOL_NAMES = [...EVIDENCE_READ_CAPABILITIES] as const;

type JsonRpcId = string | number | null;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional()
});

const toolsCallSchema = z.object({
  name: z.enum(EVIDENCE_READ_CAPABILITIES),
  arguments: z.record(z.string(), z.unknown()).default({})
});

function result(id: JsonRpcId, value: unknown): unknown {
  return { jsonrpc: "2.0", id, result: value };
}
function errorResponse(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOL_DESCRIPTIONS: Record<(typeof EVIDENCE_READ_CAPABILITIES)[number], string> = {
  work_item_info: "Read-only summary of the work item.",
  attempt_info: "Read-only summary of the execution attempt (status, phase, fencing).",
  workspace_info: "Read-only summary of the attempt's workspace allocation.",
  read_file: "Read a text file inside the attempt workspace (contained, redacted).",
  search_workspace: "Substring search over workspace files (read-only).",
  list_directory: "List a directory inside the attempt workspace (read-only).",
  git_status: "git status --porcelain of the attempt workspace.",
  git_diff: "git diff of the attempt workspace against HEAD.",
  git_changed_files: "Changed file list for the attempt workspace.",
  test_runs: "The recorded validation run for the attempt.",
  test_output: "Recorded validation-check output for the attempt.",
  execution_summary: "Execution/desktop-commander audit events for the work item.",
  sandbox_summary: "Sandbox + network profile from the evidence manifest.",
  policy_decision: "Recorded policy.decided events for the work item.",
  approval_summary: "Recorded approval events for the work item.",
  audit_excerpt: "A bounded excerpt of the canonical audit chain for the work item.",
  evidence_manifest: "The ACS-owned content-addressed evidence manifest for the attempt."
};

export async function handleEvidenceMcpRequest(
  surface: EvidenceReadSurface,
  body: unknown
): Promise<unknown | undefined> {
  const request = requestSchema.parse(body);
  if (request.id === undefined) return undefined;
  const id = request.id;

  try {
    switch (request.method) {
      case "initialize":
        return result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "acs-evidence-mcp", version: "0.1.0" }
        });
      case "tools/list":
        return result(id, {
          tools: EVIDENCE_READ_CAPABILITIES.map((name) => ({
            name,
            description: TOOL_DESCRIPTIONS[name],
            inputSchema: { type: "object", additionalProperties: true }
          }))
        });
      case "tools/call": {
        const call = toolsCallSchema.parse((request.params ?? {}) as unknown);
        // Dispatch is a pure lookup into the read surface. There is no branch
        // that could mutate anything.
        const capability = surface[call.name];
        const value = await (capability as (input: unknown) => Promise<unknown>)(call.arguments);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value
        });
      }
      case "ping":
        return result(id, {});
      default:
        return errorResponse(id, -32601, `method not found: ${request.method}`);
    }
  } catch (error) {
    if (error instanceof ZodError) return errorResponse(id, -32602, error.message);
    if (error instanceof ControlStackError) return errorResponse(id, -32000, `${error.code}: ${error.message}`);
    return errorResponse(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function contentLength(header: string): number {
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error("missing Content-Length header");
  return Number(match[1]);
}

export function frameMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export class EvidenceMcpServer {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly surface: EvidenceReadSurface
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
      const length = contentLength(this.buffer.subarray(0, headerEnd).toString("utf8"));
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      const response = await handleEvidenceMcpRequest(this.surface, JSON.parse(body));
      if (response) this.output.write(frameMessage(response));
    }
  }
}
