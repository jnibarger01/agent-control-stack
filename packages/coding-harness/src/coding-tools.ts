import path from "node:path";
import { createHash } from "node:crypto";

export type CodingToolName =
  | "repo.status"
  | "repo.diff"
  | "repo.read"
  | "file.read"
  | "file.patch"
  | "file.create"
  | "process.test"
  | "process.build"
  | "verification.run";

export interface NormalizedToolRequest {
  tool: CodingToolName;
  dcTool: "read_file" | "write_file" | "edit_block" | "start_process";
  args: Record<string, unknown>;
  workspace: string;
}

export interface ToolObservation {
  ok: boolean;
  output: string;
  errorCode?: string;
  evidenceHash: string;
}
export interface AcsToolGateway {
  execute(request: NormalizedToolRequest, signal?: AbortSignal): Promise<ToolObservation>;
}

function text(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new TypeError(`${name} must be a bounded string`);
  return value;
}
function safePath(value: unknown, workspace: string): string {
  const input = text(value, "path", 4096);
  if (input.split(/[\\/]/).includes("..")) throw new TypeError("path traversal is forbidden");
  const resolved = path.resolve(workspace, input);
  if (resolved !== path.resolve(workspace) && !resolved.startsWith(`${path.resolve(workspace)}${path.sep}`))
    throw new TypeError("path escapes workspace");
  return resolved;
}
function processArgs(workspace: string, command: string, timeout = 120_000): Record<string, unknown> {
  return { command, cwd: path.resolve(workspace), timeout_ms: timeout };
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeCodingTool(name: string, raw: unknown, workspace: string): NormalizedToolRequest {
  if (typeof name !== "string" || !raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("tool arguments must be an object");
  const args = raw as Record<string, unknown>;
  if (name === "file.read" || name === "repo.read")
    return { tool: name, dcTool: "read_file", args: { path: safePath(args.path, workspace) }, workspace };
  if (name === "file.create")
    return {
      tool: name,
      dcTool: "write_file",
      args: { path: safePath(args.path, workspace), content: text(args.content, "content") },
      workspace
    };
  if (name === "file.patch")
    return {
      tool: name,
      dcTool: "edit_block",
      args: {
        file_path: safePath(args.path ?? args.file_path, workspace),
        old_string: text(args.old_string, "old_string"),
        new_string: text(args.new_string, "new_string")
      },
      workspace
    };
  if (name === "repo.status")
    return { tool: name, dcTool: "start_process", args: processArgs(workspace, "git status --short"), workspace };
  if (name === "repo.diff")
    return { tool: name, dcTool: "start_process", args: processArgs(workspace, "git diff --no-ext-diff"), workspace };
  if (name === "process.test")
    return { tool: name, dcTool: "start_process", args: processArgs(workspace, "npm test -- --runInBand"), workspace };
  if (name === "process.build")
    return { tool: name, dcTool: "start_process", args: processArgs(workspace, "npm run build"), workspace };
  if (name === "verification.run")
    return {
      tool: name,
      dcTool: "start_process",
      args: processArgs(workspace, text(args.command, "command", 1024), 300_000),
      workspace
    };
  throw new TypeError(`tool is not available: ${name}`);
}

export async function executeCodingTool(
  gateway: AcsToolGateway,
  request: NormalizedToolRequest,
  signal?: AbortSignal
): Promise<ToolObservation> {
  const observation = await gateway.execute(request, signal);
  return { ...observation, evidenceHash: observation.evidenceHash || hash(observation.output) };
}
