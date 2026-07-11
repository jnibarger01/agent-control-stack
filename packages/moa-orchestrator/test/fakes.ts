import type {
  AcsClient,
  AuditSink,
  CreateWorkItemInput,
  ExecutableGrant,
  ExecutableGrantRequest,
  ExecutionRequest,
  ModelCaller,
  ModelRequest,
  MoaAuditEvent,
  Redactor
} from "../src/index.js";
import type { TaskEnvelope } from "../src/index.js";

export const ADVISOR_JSON = JSON.stringify({
  verdict: "risky",
  key_risks: ["gateway auth bypass"],
  recommended_next_steps: ["gate mutation behind approval"],
  do_not_do: ["dispatch from advisor output"],
  confidence: 0.7
});

export function aggReadOnly(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "read_only_answer",
    advisor_synthesis: { consensus: "No mutation required.", disagreements: [], ignored_advice: [] },
    risk: "low",
    proposed_action: null,
    acs_work_item: null,
    user_response: "Read-only answer.",
    ...extra
  });
}

export function aggCreate(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "create_work_item",
    advisor_synthesis: { consensus: "Patch needed.", disagreements: [], ignored_advice: [] },
    risk: "high",
    proposed_action: { category: "gateway_auth", summary: "Patch bearer validation", requires_mutation: true },
    acs_work_item: null,
    user_response: "Routing through ACS.",
    ...extra
  });
}

export function aggExecute(workItemId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "execute_approved_work",
    advisor_synthesis: { consensus: "Approved item is ready.", disagreements: [], ignored_advice: [] },
    risk: "medium",
    proposed_action: { category: "filesystem_write", summary: "Apply approved patch", requires_mutation: true },
    acs_work_item: { work_item_id: workItemId },
    user_response: "Execute approved item.",
    ...extra
  });
}

export class FakeCaller implements ModelCaller {
  calls: Array<{ phase: "advisor" | "aggregator"; request: ModelRequest; rawKeys: string[] }> = [];
  signals: AbortSignal[] = [];
  constructor(
    private readonly opts: {
      advisorReply?: string;
      aggregatorReply?: string;
      advisorDelayMs?: number;
    } = {}
  ) {}

  async complete(request: ModelRequest): Promise<string> {
    const phase = request.system.startsWith("You are the aggregator") ? "aggregator" : "advisor";
    this.calls.push({ phase, request, rawKeys: Object.keys(request) });
    if (request.signal) this.signals.push(request.signal);
    if (phase === "advisor" && this.opts.advisorDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.advisorDelayMs));
    }
    return phase === "advisor" ? this.opts.advisorReply ?? ADVISOR_JSON : this.opts.aggregatorReply ?? aggReadOnly();
  }
}

export class FakeAcs implements AcsClient {
  createWorkItemCalls: CreateWorkItemInput[] = [];
  getGrantCalls: ExecutableGrantRequest[] = [];
  requestExecutionCalls: ExecutionRequest[] = [];
  constructor(private readonly opts: { grant?: ExecutableGrant; grantError?: Error; dispatch?: boolean } = {}) {}
  async createWorkItem(input: CreateWorkItemInput) {
    this.createWorkItemCalls.push(input);
    return { work_item_id: `wrk_${this.createWorkItemCalls.length}`, status: "pending_approval" as const };
  }
  async getExecutableGrant(input: ExecutableGrantRequest) {
    this.getGrantCalls.push(input);
    if (this.opts.grantError) throw this.opts.grantError;
    return this.opts.grant ?? { grant_id: "grant-1", lease_token: "lease-1", action_hash: input.expected_action_hash };
  }
  async requestExecution(input: ExecutionRequest) {
    this.requestExecutionCalls.push(input);
    return { dispatched: this.opts.dispatch ?? true };
  }
  async policySummary(_task: TaskEnvelope) {
    return "ACS policy owns approval, lease, claim, audit, and execution.";
  }
}

export class FakeAudit implements AuditSink {
  events: MoaAuditEvent[] = [];
  record(event: MoaAuditEvent): void {
    this.events.push(event);
  }
  byType(type: MoaAuditEvent["type"]) {
    return this.events.filter((event) => event.type === type);
  }
}

export class PassthroughRedactor implements Redactor {
  redact(text: string): string {
    return text;
  }
}

export function makeTask(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    task_id: "task_20260708_001",
    origin: "test",
    session_id: "session-a",
    user_id: "claimed-user",
    risk: "high",
    kind: "code_review",
    goal: "Review auth; OPENAI_API_KEY=sk-test-leak password=hunter2",
    context: {
      repo: "/home/jacen/agent-control-stack",
      branch: "main",
      files: ["apps/gateway/src/mcp.ts"],
      snippets: []
    },
    constraints: { no_mutation: true, max_advisor_tokens: 500, require_citations: false },
    ...overrides
  };
}
