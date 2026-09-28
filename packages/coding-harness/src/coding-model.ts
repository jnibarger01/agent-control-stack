export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface AgentInput {
  taskId: string;
  goal: string;
  state: string;
  observations: readonly unknown[];
  iteration: number;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface AgentTurn {
  message?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}
export interface CodingModel {
  readonly provider: string;
  readonly model: string;
  generate(input: AgentInput): Promise<AgentTurn>;
}

export class OllamaCodingModel implements CodingModel {
  readonly provider = "ollama";
  constructor(
    readonly model: string,
    private readonly endpoint = "http://127.0.0.1:11434"
  ) {}

  async generate(input: AgentInput): Promise<AgentTurn> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        tools: [
          {
            type: "function",
            function: {
              name: "file.create",
              description: "Create a file in the authorized worktree.",
              parameters: {
                type: "object",
                required: ["path", "content"],
                properties: { path: { type: "string" }, content: { type: "string" } }
              }
            }
          },
          {
            type: "function",
            function: {
              name: "file.patch",
              description: "Replace exact text in a file.",
              parameters: {
                type: "object",
                required: ["path", "old_string", "new_string"],
                properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }
              }
            }
          },
          {
            type: "function",
            function: {
              name: "file.read",
              description: "Read an authorized worktree file.",
              parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } }
            }
          },
          {
            type: "function",
            function: {
              name: "process.test",
              description: "Run the repository test command.",
              parameters: { type: "object", properties: {} }
            }
          },
          {
            type: "function",
            function: {
              name: "process.build",
              description: "Run the repository build command.",
              parameters: { type: "object", properties: {} }
            }
          }
        ],
        messages: [
          {
            role: "system",
            content:
              "Return JSON with optional message and toolCalls. Tool arguments must be an object. Never declare success."
          },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    });
    if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
    const payload = (await response.json()) as { message?: { content?: string } };
    if (!payload.message?.content) throw new Error("Ollama returned no JSON content");
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.message.content);
    } catch {
      throw new Error("Ollama returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Ollama response must be an object");
    const value = parsed as { message?: unknown; toolCalls?: unknown; name?: unknown; arguments?: unknown };
    if (value.message !== undefined && typeof value.message !== "string") throw new Error("message must be a string");
    if (value.toolCalls !== undefined && !Array.isArray(value.toolCalls)) throw new Error("toolCalls must be an array");
    const rawToolCalls = Array.isArray(value.toolCalls)
      ? value.toolCalls
      : typeof value.name === "string" && value.arguments !== undefined
        ? [{ name: value.name, arguments: value.arguments }]
        : [];
    const toolCalls: ToolCall[] = rawToolCalls.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("tool call must be an object");
      const call = entry as Record<string, unknown>;
      if (call.id !== undefined && typeof call.id !== "string") throw new Error("invalid tool call id");
      if (
        typeof call.name !== "string" ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)
      )
        throw new Error("invalid tool call");
      return {
        id:
          typeof call.id === "string"
            ? call.id
            : `${input.taskId}-${input.iteration}-${Math.random().toString(36).slice(2, 8)}`,
        name: call.name,
        arguments: call.arguments as Record<string, unknown>
      };
    });
    return { ...(typeof value.message === "string" ? { message: value.message } : {}), toolCalls };
  }
}
