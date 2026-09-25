import { createHash } from "node:crypto";
import { tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import { AcsError, type AcsApi, type DispatchOutcome, type ExecutionResult, type WorkItem } from "./acs-client.js";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") && !p.includes("\0"), "absolute path required");
const specs = [
  {
    name: "list_directory",
    description:
      "List one directory level on the ACS-authorized device. Pass depth > 1 only when nested contents are required.",
    schema: z.object({ path, depth: z.number().int().min(1).max(8).optional() }).strict(),
    write: false
  },
  {
    name: "read_file",
    description: "Read a text file on the ACS-authorized device.",
    schema: z
      .object({
        path,
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(1_000_000).optional()
      })
      .strict(),
    write: false
  },
  {
    name: "write_file",
    description: "Write a text file through ACS policy and human approval when required.",
    schema: z
      .object({ path, content: z.string().max(100_000), mode: z.enum(["rewrite", "append"]).optional() })
      .strict(),
    write: true
  }
] as const;

type Pending = {
  fingerprint: string;
  round: number;
  workItemId?: string;
  dispatchedAt?: number;
  result?: ExecutionResult;
  denial?: string;
};
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const FAILED = new Set(["blocked", "rejected", "cancelled", "failed", "quarantined", "unknown"]);

export interface AcsToolTiming {
  /** Interval between ACS status reads while an approved call executes. */
  pollMs: number;
  /** Bounded wait for execution before pausing the run (never an unbounded loop). */
  waitMs: number;
  /** Re-dispatch an approved-but-unclaimed item after this long (dispatch is idempotent). */
  redispatchMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const defaultTiming: AcsToolTiming = {
  pollMs: 500,
  waitMs: 60_000,
  redispatchMs: 15_000,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Process-scoped ledger: one Strands tool call maps to exactly one ACS
 * invocation (ACS-side idempotency is keyed by sessionId + invocationId), so
 * SDK re-entry after an interrupt resumes the same work item and never submits
 * a second action. ACS -- not the interrupt response -- decides approval.
 */
export class AcsToolProvider {
  private readonly calls = new Map<string, Pending>();
  private readonly timing: AcsToolTiming;
  constructor(
    private readonly api: AcsApi,
    readonly sessionId: string,
    timing: Partial<AcsToolTiming> = {}
  ) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new AcsError("invalid_session_configuration");
    this.timing = { ...defaultTiming, ...timing };
  }
  readonly tools = specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.schema,
      callback: async (args, context) => {
        if (!context) throw new AcsError("missing_tool_context");
        // Desktop Commander defaults to a recursive depth of 2, which floods the
        // context on large trees. Make the shallow listing explicit so ACS
        // authorizes exactly what runs.
        const effective = spec.name === "list_directory" && !("depth" in args) ? { ...args, depth: 1 } : args;
        return this.execute(spec.name, effective, context);
      }
    })
  );

  private async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const toolUseId = context.toolUse.toolUseId;
    const digest = fingerprint({ name, args });
    const invocationId = fingerprint({ domain: "strands.invocation.v1", toolUseId }).slice(0, 64);
    const correlationId = `strands:${this.sessionId}:${invocationId}`;
    const request = { sessionId: this.sessionId, invocationId, tool: name, arguments: args };
    // Interrupt names depend only on the round, so on resume the first pause
    // reached consumes the operator's response whatever ACS state changed.
    // context.interrupt() throws to pause and returns only once resumed.
    const interrupt = (call: Pending, reason: Record<string, unknown>) => {
      context.interrupt({
        name: `acs.pause.${call.round}`,
        reason: { ...reason, sessionId: this.sessionId, correlationId }
      });
      call.round += 1;
    };
    const deny = (code: string, workItemId?: string) =>
      JSON.stringify({ ok: false, code, correlationId, ...(workItemId ? { workItemId } : {}) });

    let call = this.calls.get(toolUseId);
    if (call && call.fingerprint !== digest) throw new AcsError("invocation_binding_mismatch");
    if (!call) {
      call = { fingerprint: digest, round: 0 };
      this.calls.set(toolUseId, call);
    }
    if (call.denial) return deny(call.denial, call.workItemId);
    if (call.result) return JSON.stringify({ ok: true, correlationId, ...call.result });

    while (!call.workItemId) {
      try {
        const created = await this.api.createInvocation(request);
        if (created.correlationId !== correlationId) throw new AcsError("acs_binding_mismatch");
        call.workItemId = created.workItemId;
      } catch (error) {
        if (error instanceof AcsError && /^acs_http_4\d\d$/.test(error.code)) {
          call.denial = error.code; // authorization/validation denial, not transport
          return deny(error.code);
        }
        if (error instanceof AcsError && error.code === "acs_binding_mismatch") throw error;
        // Ambiguous: pause. On resume the same invocationId is re-sent and ACS
        // returns the existing item instead of creating a second one.
        interrupt(call, { code: "acs_submission_unknown" });
      }
    }
    const workItemId = call.workItemId;

    let deadline = this.timing.now() + this.timing.waitMs;
    for (;;) {
      let item: WorkItem | undefined;
      try {
        item = await this.api.get(workItemId);
      } catch {
        item = undefined;
      }
      if (item) {
        if (
          item.id !== workItemId ||
          item.metadata.correlationId !== correlationId ||
          item.requestedActions.length !== 1 ||
          item.requestedActions[0].params.tool !== name
        ) {
          throw new AcsError("acs_binding_mismatch");
        }
        if (FAILED.has(item.status)) {
          call.denial = `acs_${item.status}`;
          return deny(call.denial, workItemId);
        }
        if (item.status === "succeeded") {
          let result: ExecutionResult;
          try {
            result = await this.api.result(workItemId);
          } catch {
            interrupt(call, { code: "acs_result_unavailable", workItemId });
            continue;
          }
          if (
            result.workItemId !== workItemId ||
            result.toolName !== name ||
            result.executionMode !== "desktop_commander"
          ) {
            throw new AcsError("acs_result_binding_mismatch");
          }
          call.result = result;
          return JSON.stringify({ ok: true, correlationId, ...result });
        }
        const due =
          call.dispatchedAt === undefined || this.timing.now() - call.dispatchedAt >= this.timing.redispatchMs;
        if ((item.status === "approved" || item.status === "needs_approval") && due) {
          let outcome: DispatchOutcome | undefined;
          try {
            outcome = await this.api.dispatch(workItemId, request);
          } catch (error) {
            if (error instanceof AcsError && error.code === "acs_binding_mismatch") throw error;
            outcome = undefined; // transient; the next read retries an idempotent dispatch
          }
          if (outcome === "require_approval") {
            // First-class paused state: a human approves in ACS, then resumes.
            interrupt(call, { code: "require_approval", workItemId });
            continue;
          }
          if (outcome === "dispatched") call.dispatchedAt = this.timing.now();
        }
      }
      if (this.timing.now() >= deadline) {
        interrupt(call, { code: item ? "awaiting_execution" : "acs_read_unavailable", workItemId });
        deadline = this.timing.now() + this.timing.waitMs; // fresh bounded wait after resume
        continue;
      }
      await this.timing.sleep(this.timing.pollMs);
    }
  }
}
