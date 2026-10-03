import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionScheduler } from "./scheduler.js";
import type { ExecutionIntent, ResourceClaim } from "./types.js";

function intent(
  requestId: string,
  agentId: string,
  lane: ExecutionIntent["lane"],
  resources: ResourceClaim[],
  priority: ExecutionIntent["priority"] = "normal"
): ExecutionIntent {
  return {
    requestId,
    agentId,
    sessionId: `session-${agentId}`,
    tool: lane === "mutation" ? "write_file" : "read_file",
    normalizedArguments: {},
    lane,
    effects: lane === "mutation" ? "workspace_mutation" : "read_only",
    resources,
    cost: { cpu: 1, memory: 1, io: 1 },
    priority
  };
}

afterEach(() => {
  vi.useRealTimers();
});
describe("ExecutionScheduler", () => {
  it("admits non-conflicting shared reads concurrently", async () => {
    const scheduler = new ExecutionScheduler();
    const first = await scheduler.enqueue(intent("a", "claude", "read", [{ key: "file:/repo/a.ts", mode: "shared" }]));
    const second = await scheduler.enqueue(
      intent("b", "chatgpt", "read", [{ key: "file:/repo/a.ts", mode: "shared" }])
    );

    expect(scheduler.snapshot().active).toHaveLength(2);
    first.release();
    second.release();
    expect(scheduler.snapshot().active).toHaveLength(0);
  });

  it("serializes an exclusive file mutation behind active readers", async () => {
    const scheduler = new ExecutionScheduler();
    const first = await scheduler.enqueue(
      intent("read-a", "claude", "read", [{ key: "file:/repo/a.ts", mode: "shared" }])
    );
    const second = await scheduler.enqueue(
      intent("read-b", "chatgpt", "read", [{ key: "file:/repo/a.ts", mode: "shared" }])
    );
    let admitted = false;
    const pending = scheduler
      .enqueue(intent("write", "grok", "mutation", [{ key: "file:/repo/a.ts", mode: "exclusive" }]))
      .then((value) => {
        admitted = true;
        return value;
      });

    await Promise.resolve();
    expect(admitted).toBe(false);
    first.release();
    await Promise.resolve();
    expect(admitted).toBe(false);
    second.release();
    const write = await pending;
    expect(admitted).toBe(true);
    write.release();
  });

  it("acquires multi-resource claims atomically and avoids AB/BA deadlock", async () => {
    const scheduler = new ExecutionScheduler();
    const first = await scheduler.enqueue(
      intent("first", "claude", "mutation", [
        { key: "file:/repo/a", mode: "exclusive" },
        { key: "file:/repo/b", mode: "exclusive" }
      ])
    );
    const secondPromise = scheduler.enqueue(
      intent("second", "grok", "mutation", [
        { key: "file:/repo/b", mode: "exclusive" },
        { key: "file:/repo/a", mode: "exclusive" }
      ])
    );
    expect(scheduler.snapshot().queued).toHaveLength(1);
    first.release();
    const second = await secondPromise;
    expect(scheduler.snapshot().active[0]?.requestId).toBe("second");
    second.release();
  });

  it("round-robins eligible work across agents", async () => {
    const scheduler = new ExecutionScheduler({
      laneLimits: { read: 1, search: 1, process: 1, mutation: 1 }
    });
    const first = await scheduler.enqueue(intent("a1", "claude", "read", [{ key: "file:/repo/1", mode: "shared" }]));
    const a2Promise = scheduler.enqueue(intent("a2", "claude", "read", [{ key: "file:/repo/2", mode: "shared" }]));
    const b1Promise = scheduler.enqueue(intent("b1", "chatgpt", "read", [{ key: "file:/repo/3", mode: "shared" }]));

    first.release();
    const b1 = await b1Promise;
    expect(scheduler.snapshot().active[0]?.requestId).toBe("b1");
    b1.release();
    const a2 = await a2Promise;
    a2.release();
  });

  it("does not let a later shared request bypass an earlier exclusive waiter", async () => {
    const scheduler = new ExecutionScheduler();
    const held = await scheduler.enqueue(intent("held", "claude", "read", [{ key: "file:/repo/a", mode: "shared" }]));
    const writerPromise = scheduler.enqueue(
      intent("writer", "grok", "mutation", [{ key: "file:/repo/a", mode: "exclusive" }])
    );
    const lateReadPromise = scheduler.enqueue(
      intent("late-read", "chatgpt", "read", [{ key: "file:/repo/a", mode: "shared" }])
    );

    expect(scheduler.snapshot().queued.map((entry) => entry.requestId)).toEqual(
      expect.arrayContaining(["writer", "late-read"])
    );
    held.release();
    const writer = await writerPromise;
    expect(scheduler.snapshot().queued.some((entry) => entry.requestId === "late-read")).toBe(true);
    writer.release();
    const lateRead = await lateReadPromise;
    lateRead.release();
  });

  it("allows different agents to mutate different files in the same repository concurrently", async () => {
    const scheduler = new ExecutionScheduler();
    const first = await scheduler.enqueue({
      ...intent("write-a", "claude", "mutation", [
        { key: "repo:/repo", mode: "shared" },
        { key: "file:/repo/a.ts", mode: "exclusive" }
      ]),
      effects: "workspace_mutation"
    });
    const second = await scheduler.enqueue({
      ...intent("write-b", "grok", "mutation", [
        { key: "repo:/repo", mode: "shared" },
        { key: "file:/repo/b.ts", mode: "exclusive" }
      ]),
      effects: "workspace_mutation"
    });

    expect(
      scheduler
        .snapshot()
        .active.map((entry) => entry.requestId)
        .sort()
    ).toEqual(["write-a", "write-b"]);
    first.release();
    second.release();
  });

  it("enforces the per-agent repository mutation quota without blocking another agent", async () => {
    const scheduler = new ExecutionScheduler({ maxMutationsPerRepoPerAgent: 1 });
    const first = await scheduler.enqueue({
      ...intent("claude-a", "claude", "mutation", [
        { key: "repo:/repo", mode: "shared" },
        { key: "file:/repo/a.ts", mode: "exclusive" }
      ]),
      effects: "workspace_mutation"
    });
    const sameAgent = scheduler.enqueue({
      ...intent("claude-b", "claude", "mutation", [
        { key: "repo:/repo", mode: "shared" },
        { key: "file:/repo/b.ts", mode: "exclusive" }
      ]),
      effects: "workspace_mutation"
    });
    const otherAgent = await scheduler.enqueue({
      ...intent("grok-b", "grok", "mutation", [
        { key: "repo:/repo", mode: "shared" },
        { key: "file:/repo/c.ts", mode: "exclusive" }
      ]),
      effects: "workspace_mutation"
    });

    expect(scheduler.snapshot().queued.some((entry) => entry.requestId === "claude-b")).toBe(true);
    otherAgent.release();
    first.release();
    (await sameAgent).release();
  });

  it("fails with scheduler_overloaded instead of accepting an unbounded queue", async () => {
    const scheduler = new ExecutionScheduler({
      maxQueued: 1,
      laneLimits: { read: 1, search: 1, process: 1, mutation: 1 }
    });
    const active = await scheduler.enqueue(
      intent("active", "claude", "read", [{ key: "file:/repo/active", mode: "shared" }])
    );
    const queued = scheduler.enqueue(intent("queued", "grok", "read", [{ key: "file:/repo/queued", mode: "shared" }]));
    await expect(
      scheduler.enqueue(intent("overflow", "chatgpt", "read", [{ key: "file:/repo/overflow", mode: "shared" }]))
    ).rejects.toMatchObject({
      code: "scheduler_overloaded",
      retryable: true
    });
    active.release();
    (await queued).release();
  });

  it("caps total outstanding work per agent across active and queued requests", async () => {
    const scheduler = new ExecutionScheduler({
      maxOutstandingPerAgent: 2,
      maxQueuedPerAgent: 5,
      laneLimits: { read: 1, search: 1, process: 1, mutation: 1 }
    });
    const active = await scheduler.enqueue(
      intent("active-agent", "claude", "read", [{ key: "file:/repo/active-agent", mode: "shared" }])
    );
    const queued = scheduler.enqueue(
      intent("queued-agent", "claude", "read", [{ key: "file:/repo/queued-agent", mode: "shared" }])
    );
    await expect(
      scheduler.enqueue(
        intent("overflow-agent", "claude", "read", [{ key: "file:/repo/overflow-agent", mode: "shared" }])
      )
    ).rejects.toMatchObject({ code: "scheduler_overloaded" });
    active.release();
    (await queued).release();
  });

  it("times queued work out without disturbing the active lock holder", async () => {
    vi.useFakeTimers();
    const scheduler = new ExecutionScheduler({
      queueTimeoutMs: 50,
      laneLimits: { read: 1, search: 1, process: 1, mutation: 1 }
    });
    const active = await scheduler.enqueue(
      intent("active", "claude", "read", [{ key: "file:/repo/a", mode: "shared" }])
    );
    const queued = scheduler.enqueue(
      intent("queued", "grok", "mutation", [{ key: "file:/repo/a", mode: "exclusive" }])
    );
    const assertion = expect(queued).rejects.toMatchObject({
      code: "scheduler_queue_timeout"
    });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(scheduler.snapshot().active[0]?.requestId).toBe("active");
    active.release();
  });

  it("fails a continuously lock-blocked request on lock timeout before queue timeout", async () => {
    vi.useFakeTimers();
    const scheduler = new ExecutionScheduler({
      queueTimeoutMs: 1_000,
      lockTimeoutMs: 50
    });
    const holder = await scheduler.enqueue(
      intent("lock-holder", "claude", "mutation", [{ key: "file:/repo/a.ts", mode: "exclusive" }])
    );
    const waiter = scheduler.enqueue(
      intent("lock-waiter", "grok", "mutation", [{ key: "file:/repo/a.ts", mode: "exclusive" }])
    );
    const assertion = expect(waiter).rejects.toMatchObject({
      code: "scheduler_lock_timeout",
      retryable: true
    });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(scheduler.metrics().lockTimeoutTotal).toBe(1);
    expect(scheduler.snapshot().active[0]?.requestId).toBe("lock-holder");
    holder.release();
  });

  it("records failed terminal outcomes and lock-wait metrics by resource type", async () => {
    const scheduler = new ExecutionScheduler();
    const holder = await scheduler.enqueue(
      intent("holder", "claude", "mutation", [{ key: "file:/repo/a.ts", mode: "exclusive" }])
    );
    const pending = scheduler.enqueue(
      intent("waiter", "grok", "mutation", [{ key: "file:/repo/a.ts", mode: "exclusive" }])
    );
    expect(scheduler.snapshot().queued).toHaveLength(1);
    holder.release();
    await pending;
    expect(scheduler.releaseRequest("waiter", "failed")).toBe(true);
    const metrics = scheduler.metrics();
    expect(metrics.failedTotal).toBe(1);
    expect(metrics.lockWaitMs.file).toBeDefined();
  });

  it("starts the execution timeout only when explicitly armed", async () => {
    vi.useFakeTimers();
    const scheduler = new ExecutionScheduler();
    const admission = await scheduler.enqueue({
      ...intent("armed-timeout", "claude", "mutation", [{ key: "file:/repo/armed.ts", mode: "exclusive" }]),
      executionTimeoutMs: 50
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(scheduler.snapshot().active[0]?.timedOut).toBe(false);

    expect(scheduler.armExecutionTimeout("armed-timeout")).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(scheduler.snapshot().active[0]?.timedOut).toBe(true);
    expect(scheduler.metrics().executionTimeoutTotal).toBe(1);

    admission.release();
    expect(scheduler.snapshot().active).toHaveLength(0);
  });

  it("does not auto-release an active lock when execution timeout is observed", async () => {
    const scheduler = new ExecutionScheduler();
    const active = await scheduler.enqueue(
      intent("active", "claude", "mutation", [{ key: "repo:/repo", mode: "exclusive" }])
    );
    expect(scheduler.markExecutionTimeout("active")).toBe(true);
    expect(scheduler.snapshot().active).toHaveLength(1);
    active.release();
  });

  it("resumes round-robin with the logical successor after the admitted agent drains", async () => {
    const scheduler = new ExecutionScheduler({
      laneLimits: { read: 1, search: 1, process: 1, mutation: 1 }
    });
    const holder = await scheduler.enqueue(
      intent("holder", "holder", "read", [{ key: "file:/repo/holder", mode: "shared" }])
    );
    const claudePromise = scheduler.enqueue(
      intent("claude-1", "claude", "read", [{ key: "file:/repo/1", mode: "shared" }])
    );
    const chatgptPromise = scheduler.enqueue(
      intent("chatgpt-1", "chatgpt", "read", [{ key: "file:/repo/2", mode: "shared" }])
    );
    const grokPromise = scheduler.enqueue(intent("grok-1", "grok", "read", [{ key: "file:/repo/3", mode: "shared" }]));

    holder.release();
    const claude = await claudePromise;
    expect(scheduler.snapshot().active[0]?.requestId).toBe("claude-1");
    claude.release();

    const chatgpt = await chatgptPromise;
    expect(chatgpt.requestId).toBe("chatgpt-1");
    expect(scheduler.snapshot().active[0]?.requestId).toBe("chatgpt-1");
    chatgpt.release();
    (await grokPromise).release();
  });
});
