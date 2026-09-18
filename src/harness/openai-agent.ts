import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalMcpRuntime } from '../local-runtime.js';
import {
  getManagedAcsToolPolicy,
  listManagedAcsToolPolicies,
  type DesktopCommanderExecutionMode,
} from '../managed-acs.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6';
const DEFAULT_MAX_TOOL_ROUNDS = 24;
const MAX_TOOL_OUTPUT_CHARS = 120_000;

type JsonObject = Record<string, unknown>;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface HarnessRuntime {
  start(): Promise<void>;
  listTools(timeoutMs?: number): Promise<{ tools: McpTool[] }>;
  callTool(name: string, args?: JsonObject, timeoutMs?: number, meta?: JsonObject): Promise<unknown>;
  shutdown(): Promise<void>;
}
export interface ApprovalRequest {
  toolName: string;
  args: JsonObject;
}

export interface ToolMetaRequest extends ApprovalRequest {
  mode: DesktopCommanderExecutionMode;
}

export interface DesktopCommanderAgentOptions {
  apiKey?: string;
  model?: string;
  systemPath?: string;
  maxToolRounds?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  approveMutations?: boolean;
  mode?: DesktopCommanderExecutionMode;
  runtime?: HarnessRuntime;
  approval?: (request: ApprovalRequest) => Promise<boolean>;
  toolMetaProvider?: (request: ToolMetaRequest) => Promise<JsonObject | undefined>;
  fetchImpl?: typeof fetch;
}

interface FunctionCall extends JsonObject {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAIResponse {
  id: string;
  output?: Array<Record<string, unknown>>;
  error?: { message?: string };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function extractFunctionCalls(response: OpenAIResponse): FunctionCall[] {
  return (response.output ?? []).filter((item): item is FunctionCall => (
    item.type === 'function_call'
    && typeof item.call_id === 'string'
    && typeof item.name === 'string'
    && typeof item.arguments === 'string'
  ));
}

function extractOutputText(response: OpenAIResponse): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function serializeToolResult(result: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = JSON.stringify({ error: { code: 'TOOL_RESULT_NOT_SERIALIZABLE' } });
  }
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return serialized;
  return JSON.stringify({
    truncated: true,
    originalChars: serialized.length,
    output: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS),
  });
}
export async function resolveSystemPath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env.DESKTOP_COMMANDER_SYSTEM_MD,
    path.resolve(process.cwd(), 'SYSTEM.md'),
    fileURLToPath(new URL('../../SYSTEM.md', import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('SYSTEM.md was not found. Set --system or DESKTOP_COMMANDER_SYSTEM_MD.');
}

export async function loadSystemInstructions(explicitPath?: string): Promise<{ path: string; text: string }> {
  const systemPath = await resolveSystemPath(explicitPath);
  const text = await fs.readFile(systemPath, 'utf8');
  if (!text.trim()) throw new Error(`SYSTEM.md is empty: ${systemPath}`);
  return { path: systemPath, text };
}

export class DesktopCommanderAgent {
  private readonly options: Required<Pick<DesktopCommanderAgentOptions,
    'model' | 'maxToolRounds' | 'approveMutations' | 'mode'>> & DesktopCommanderAgentOptions;
  private readonly runtime: HarnessRuntime;
  private readonly fetchImpl: typeof fetch;
  private started = false;
  private instructions = '';
  private tools: Array<Record<string, unknown>> = [];
  private previousResponseId: string | undefined;
  constructor(options: DesktopCommanderAgentOptions = {}) {
    const mode = options.mode ?? 'standalone';
    this.options = {
      ...options,
      model: options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
      maxToolRounds: options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      approveMutations: options.approveMutations ?? false,
      mode,
    };
    this.runtime = options.runtime ?? createLocalMcpRuntime({ mode });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

    const system = await loadSystemInstructions(this.options.systemPath);
    await this.runtime.start();
    const listed = await this.runtime.listTools();
    const allowed = new Set(Object.keys(listManagedAcsToolPolicies()));

    this.instructions = system.text;
    this.tools = listed.tools
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description ?? `Desktop Commander tool: ${tool.name}`,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        strict: false,
      }));

    if (this.tools.length === 0) {
      await this.runtime.shutdown();
      throw new Error('Desktop Commander exposed no harness-allowlisted tools.');
    }
    this.started = true;
  }
  private async createResponse(input: unknown, previousResponseId?: string): Promise<OpenAIResponse> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY!;
    const body: JsonObject = {
      model: this.options.model,
      instructions: this.instructions,
      input,
      tools: this.tools,
      tool_choice: 'auto',
      store: true,
    };
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (this.options.reasoningEffort) {
      body.reasoning = { effort: this.options.reasoningEffort };
    }

    const response = await this.fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as OpenAIResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenAI Responses API failed with HTTP ${response.status}`);
    }
    if (!payload.id) throw new Error('OpenAI Responses API returned no response id.');
    return payload;
  }

  private async executeFunction(call: FunctionCall): Promise<string> {
    let args: JsonObject;
    try {
      const parsed = JSON.parse(call.arguments);
      if (!isRecord(parsed)) throw new Error('arguments must decode to an object');
      args = parsed;
    } catch (error) {
      return JSON.stringify({ error: { code: 'INVALID_TOOL_ARGUMENTS', message: String(error) } });
    }
    const policy = getManagedAcsToolPolicy(call.name);
    if (!policy) {
      return JSON.stringify({ error: { code: 'TOOL_NOT_ALLOWLISTED', toolName: call.name } });
    }

    if (policy.requiresApproval && !this.options.approveMutations) {
      const approved = this.options.approval
        ? await this.options.approval({ toolName: call.name, args })
        : false;
      if (!approved) {
        return JSON.stringify({ error: { code: 'USER_APPROVAL_REQUIRED', toolName: call.name } });
      }
    }

    let meta: JsonObject | undefined;
    if (this.options.mode === 'managed') {
      if (!this.options.toolMetaProvider) {
        return JSON.stringify({
          error: {
            code: 'ACS_METADATA_PROVIDER_REQUIRED',
            message: 'Managed mode requires a per-call ACS capability metadata provider.',
          },
        });
      }
      meta = await this.options.toolMetaProvider({ toolName: call.name, args, mode: this.options.mode });
      if (!meta) {
        return JSON.stringify({ error: { code: 'ACS_CAPABILITY_UNAVAILABLE', toolName: call.name } });
      }
    }

    try {
      return serializeToolResult(await this.runtime.callTool(call.name, args, undefined, meta));
    } catch (error) {
      return JSON.stringify({
        error: {
          code: 'DESKTOP_COMMANDER_TOOL_FAILED',
          toolName: call.name,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  async run(prompt: string): Promise<string> {
    if (!prompt.trim()) throw new Error('Prompt must not be empty.');
    await this.start();

    let response = await this.createResponse(prompt, this.previousResponseId);
    for (let round = 0; round <= this.options.maxToolRounds; round += 1) {
      const calls = extractFunctionCalls(response);
      if (calls.length === 0) {
        this.previousResponseId = response.id;
        const text = extractOutputText(response);
        return text || '[Model returned no text output]';
      }
      if (round === this.options.maxToolRounds) {
        throw new Error(`Tool loop exceeded ${this.options.maxToolRounds} rounds.`);
      }

      const outputs = [];
      for (const call of calls) {
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: await this.executeFunction(call),
        });
      }
      response = await this.createResponse(outputs, response.id);
    }
    throw new Error('Agent loop terminated unexpectedly.');
  }

  clearConversation(): void {
    this.previousResponseId = undefined;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.runtime.shutdown();
  }
}
