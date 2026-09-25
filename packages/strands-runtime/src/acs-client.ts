import { z } from "zod";

export const workItemSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "draft",
    "pending_policy",
    "needs_approval",
    "approved",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "rejected",
    "unknown",
    "quarantined"
  ]),
  metadata: z.object({ correlationId: z.string() }),
  requestedActions: z.array(z.object({ kind: z.string(), params: z.record(z.string(), z.unknown()) }))
});
export type WorkItem = z.infer<typeof workItemSchema>;
export const resultSchema = z.object({
  workItemId: z.string(),
  resultId: z.string(),
  leaseId: z.string(),
  workerId: z.string(),
  actionHash: z.string(),
  payloadHash: z.string(),
  outcome: z.literal("succeeded"),
  output: z.string(),
  executionMode: z.literal("desktop_commander"),
  toolName: z.string(),
  requestId: z.string(),
  invocationFingerprint: z.string(),
  audit: z.object({
    authorizationEventId: z.string().min(1),
    capabilityEventId: z.string().min(1),
    completionEventId: z.string().min(1),
    policyDecisionHash: z.string().min(1),
    attemptId: z.string().min(1),
    runtimeId: z.string().min(1),
    capabilityRequestHash: z.string().min(1),
    keyId: z.string().min(1)
  })
});
export type ExecutionResult = z.infer<typeof resultSchema>;
export const invocationSchema = z.object({
  workItemId: z.string().min(1),
  status: workItemSchema.shape.status,
  correlationId: z.string().nullable()
});
export type Invocation = z.infer<typeof invocationSchema>;
export interface InvocationRequest {
  sessionId: string;
  invocationId: string;
  tool: string;
  arguments: Record<string, unknown>;
}
export type DispatchOutcome = "dispatched" | "require_approval" | "not_dispatchable";
export interface AcsApi {
  /** Idempotent per (credential, sessionId, invocationId): safe to retry after an ambiguous failure. */
  createInvocation(input: InvocationRequest): Promise<Invocation>;
  /** Idempotent: asks ACS to hand an approved invocation to the managed executor. */
  dispatch(workItemId: string, input: InvocationRequest): Promise<DispatchOutcome>;
  get(id: string): Promise<WorkItem>;
  result(id: string): Promise<ExecutionResult>;
}
export class AcsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Only the ACS work-item HTTP surface is reachable; no executor credentials. */
export class AcsClient implements AcsApi {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch
  ) {
    this.base = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname);
    if (
      (this.base.protocol !== "https:" && !(this.base.protocol === "http:" && loopback)) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/" ||
      !token
    ) {
      throw new AcsError("invalid_acs_configuration");
    }
  }
  private async send(path: string, body?: object): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.base), {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new AcsError(body ? "acs_submission_unknown" : "acs_unreachable");
    }
    let json: unknown;
    try {
      json = response.status === 204 ? null : await response.json();
    } catch {
      json = null;
    }
    // Do not expose server error text, which may include configuration or credentials.
    return { status: response.status, json };
  }
  private fail(status: number, post: boolean): never {
    throw new AcsError(post && status >= 500 ? "acs_submission_unknown" : `acs_http_${status}`);
  }
  async createInvocation(input: InvocationRequest): Promise<Invocation> {
    const { status, json } = await this.send("/harness/dc-invocations", input);
    if (status !== 200 && status !== 201) this.fail(status, true);
    const parsed = invocationSchema.safeParse(json);
    if (!parsed.success) throw new AcsError("acs_submission_unknown");
    return parsed.data;
  }
  async dispatch(workItemId: string, input: InvocationRequest): Promise<DispatchOutcome> {
    const { status, json } = await this.send(
      `/harness/dc-invocations/${encodeURIComponent(workItemId)}/dispatch`,
      input
    );
    if (status === 202) return "dispatched";
    const code = (json as { code?: unknown } | null)?.code;
    if (status === 409 && code === "require_approval") return "require_approval";
    if (status === 409 && code === "not_dispatchable") return "not_dispatchable";
    if (status === 409 || status === 404) throw new AcsError("acs_binding_mismatch");
    return this.fail(status, true);
  }
  async get(id: string): Promise<WorkItem> {
    const { status, json } = await this.send(`/work-items/${encodeURIComponent(id)}`);
    if (status !== 200) this.fail(status, false);
    return workItemSchema.parse((json as { workItem: unknown }).workItem);
  }
  async result(id: string): Promise<ExecutionResult> {
    const { status, json } = await this.send(`/work-items/${encodeURIComponent(id)}/execution-result`);
    if (status !== 200) this.fail(status, false);
    return resultSchema.parse(json);
  }
}
