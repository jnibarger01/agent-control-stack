import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Strands harness -> managed DC bridge hand-off.
 *
 * The harness never talks to Desktop Commander. It creates a DC-shaped work
 * item (same binding as POST /dc/capability/issue), waits for ACS approval,
 * then asks ACS to dispatch it. The managed bridge -- the single executor-lease
 * holder -- pulls dispatched invocations and replays them through its normal
 * /dc/capability/issue path bound to that exact work item. Execution is
 * at-most-once because ACS claims the approved item exactly once.
 *
 * The queue is deliberately in-memory: raw arguments are never persisted in
 * work-item or audit-visible fields. A gateway restart drops queued entries;
 * the harness re-dispatches (ACS re-verifies the invocation binding) and the
 * work item's claim state keeps execution at most once.
 */

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const toolName = z.string().min(1).max(128);
const toolArguments = z.record(z.string(), z.unknown());

export const harnessDcInvocationSchema = z
  .object({
    sessionId: identifier,
    invocationId: identifier,
    tool: toolName,
    arguments: toolArguments
  })
  .strict();
export type HarnessDcInvocation = z.infer<typeof harnessDcInvocationSchema>;

export const HARNESS_SUBJECT_PREFIX = "strands:";

/** Least privilege: only the tools the Strands runtime exposes. Policy still decides each call. */
export const HARNESS_DC_TOOLS: ReadonlySet<string> = new Set(["list_directory", "read_file", "write_file"]);

/**
 * Per-invocation DC actor. Derived by ACS from the authenticated mutation actor
 * so a harness cannot choose or collide with another caller's subject, and one
 * logical tool call maps to exactly one binding (no cross-invocation reuse).
 */
export function harnessSubject(actor: string, sessionId: string, invocationId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ domain: "acs.strands-harness.subject.v1", actor, sessionId, invocationId }))
    .digest("hex")
    .slice(0, 48);
  return `${HARNESS_SUBJECT_PREFIX}${digest}`;
}

export function harnessCorrelationId(sessionId: string, invocationId: string): string {
  return `${HARNESS_SUBJECT_PREFIX}${sessionId}:${invocationId}`;
}

export function isHarnessSubject(subject: string | undefined | null): boolean {
  return typeof subject === "string" && subject.startsWith(HARNESS_SUBJECT_PREFIX);
}

export interface HarnessDispatchEntry {
  workItemId: string;
  actor: string;
  tool: string;
  arguments: Record<string, unknown>;
  enqueuedAt: number;
}

export class HarnessDispatchQueue {
  private readonly entries = new Map<string, HarnessDispatchEntry>();

  constructor(
    private readonly options: { maxEntries: number; ttlMs: number } = { maxEntries: 64, ttlMs: 5 * 60_000 },
    private readonly clock: () => number = Date.now
  ) {}

  /** Idempotent per work item: re-dispatch replaces the entry, never duplicates it. */
  enqueue(entry: Omit<HarnessDispatchEntry, "enqueuedAt">): "queued" | "full" {
    this.prune();
    if (!this.entries.has(entry.workItemId) && this.entries.size >= this.options.maxEntries) return "full";
    this.entries.delete(entry.workItemId);
    this.entries.set(entry.workItemId, {
      ...entry,
      arguments: structuredClone(entry.arguments),
      enqueuedAt: this.clock()
    });
    return "queued";
  }

  /** Removes and returns the oldest entry the caller still considers dispatchable. */
  takeNext(dispatchable: (entry: HarnessDispatchEntry) => boolean): HarnessDispatchEntry | undefined {
    this.prune();
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      if (dispatchable(entry)) return entry;
    }
    return undefined;
  }

  has(workItemId: string): boolean {
    this.prune();
    return this.entries.has(workItemId);
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.clock() - this.options.ttlMs;
    for (const [id, entry] of this.entries) if (entry.enqueuedAt < cutoff) this.entries.delete(id);
  }
}
