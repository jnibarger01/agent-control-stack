import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_ADMISSION_CONFIG,
  ExecutionAdmissionScheduler,
  classifyAdmissionTool,
  governedAdmissionToolNames,
  resolveExecutionAdmissionConfig,
  type AdmissionClock,
  type AdmissionRequest
} from "./index.js";

class FakeClock implements AdmissionClock {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    this.current += ms;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, timer] of [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= this.current) {
          this.timers.delete(id);
          timer.callback();
          progressed = true;
          break;
        }
      }
    }
  }
}

function request(
  clock: FakeClock,
  input: Partial<AdmissionRequest> & Pick<AdmissionRequest, "requestId" | "actorId">
): AdmissionRequest {
  return {
    requestId: input.requestId,
    lane: input.lane ?? "jc",
    executorId: input.executorId ?? "jc-executor",
    actorId: input.actorId,
    toolName: input.toolName ?? "read_file",
    executionClass: input.executionClass ?? "execution",
    enqueuedAt: clock.now(),
    deadlineAt: clock.now() + 30_000,
    signal: input.signal ?? new AbortController().signal
  };
}

describe("execution admission config", () => {
  it("uses documented defaults", () => {
    expect(resolveExecutionAdmissionConfig({})).toEqual(DEFAULT_EXECUTION_ADMISSION_CONFIG);
  });

  it.each([
    ["ACS_EXECUTION_MAX_INFLIGHT", "0"],
    ["ACS_EXECUTOR_MAX_INFLIGHT", "-1"],
    ["ACS_EXECUTION_QUEUE_MAX", "nope"],
    ["ACS_EXECUTION_QUEUE_TIMEOUT_MS", "1.5"],
    ["ACS_WAIT_MAX_INFLIGHT", "NaN"]
  ])("fails closed for invalid %s=%s", (name, value) => {
    expect(() => resolveExecutionAdmissionConfig({ [name]: value })).toThrow(/positive integer/);
  });
});

describe("execution admission scheduling", () => {
  it("bounds global and per-executor execution concurrency", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 4,
        executorMaxInflight: 2,
        queueMax: 32,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const first = await scheduler.acquire(request(clock, { requestId: "1", actorId: "a", executorId: "jc" }));
    const second = await scheduler.acquire(request(clock, { requestId: "2", actorId: "b", executorId: "jc" }));
    const thirdPromise = scheduler.acquire(request(clock, { requestId: "3", actorId: "c", executorId: "jc" }));
    expect(scheduler.snapshot()).toMatchObject({ global: { active: 2, queued: 1 } });
    first.release();
    const third = await thirdPromise;
    expect(scheduler.snapshot().global.active).toBe(2);
    second.release();
    third.release();
    expect(scheduler.snapshot().global.active).toBe(0);
  });

  it("allows independent executors to run concurrently", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({ clock });
    const jc = await scheduler.acquire(request(clock, { requestId: "jc", actorId: "a", executorId: "jc" }));
    const dc = await scheduler.acquire(request(clock, { requestId: "dc", actorId: "b", lane: "dc", executorId: "dc" }));
    expect(scheduler.snapshot().global.active).toBe(2);
    jc.release();
    dc.release();
  });

  it("enforces global capacity across otherwise independent executors", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 2,
        executorMaxInflight: 2,
        queueMax: 8,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const first = await scheduler.acquire(request(clock, { requestId: "one", actorId: "a", executorId: "worker-a" }));
    const second = await scheduler.acquire(request(clock, { requestId: "two", actorId: "b", executorId: "worker-b" }));
    const thirdPromise = scheduler.acquire(
      request(clock, { requestId: "three", actorId: "c", executorId: "worker-c" })
    );
    expect(scheduler.snapshot().global).toMatchObject({ active: 2, queued: 1 });
    first.release();
    const third = await thirdPromise;
    expect(scheduler.snapshot().global.active).toBe(2);
    second.release();
    third.release();
  });

  it("bounds the queue and returns deterministic queue_full", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 1,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const active = await scheduler.acquire(request(clock, { requestId: "active", actorId: "a" }));
    void scheduler.acquire(request(clock, { requestId: "queued", actorId: "b" }));
    await expect(scheduler.acquire(request(clock, { requestId: "overflow", actorId: "c" }))).rejects.toMatchObject({
      code: "queue_full"
    });
    expect(scheduler.snapshot().global.queued).toBe(1);
    active.release();
  });

  it("cancels queued requests without later admitting them", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 4,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const active = await scheduler.acquire(request(clock, { requestId: "active", actorId: "a" }));
    const controller = new AbortController();
    const queued = scheduler.acquire(
      request(clock, { requestId: "cancelled", actorId: "b", signal: controller.signal })
    );
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "admission_cancelled" });
    active.release();
    expect(scheduler.snapshot().global).toMatchObject({ active: 0, queued: 0 });
  });

  it("times out queued requests without acquiring capacity", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: { executionMaxInflight: 1, executorMaxInflight: 1, queueMax: 4, queueTimeoutMs: 50, waitMaxInflight: 1 }
    });
    const active = await scheduler.acquire(request(clock, { requestId: "active", actorId: "a" }));
    const queued = scheduler.acquire(
      request(clock, { requestId: "timeout", actorId: "b", deadlineAt: clock.now() + 50 })
    );
    clock.advance(50);
    await expect(queued).rejects.toMatchObject({ code: "executor_busy" });
    expect(scheduler.snapshot().global).toMatchObject({ active: 1, queued: 0 });
    active.release();
  });

  it("is round-robin fair across actors while preserving per-actor FIFO", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 8,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const active = await scheduler.acquire(request(clock, { requestId: "hold", actorId: "hold" }));
    const admitted: string[] = [];
    const promises = [
      ["a1", "a"],
      ["a2", "a"],
      ["b1", "b"],
      ["a3", "a"],
      ["b2", "b"]
    ].map(([requestId, actorId]) =>
      scheduler.acquire(request(clock, { requestId, actorId })).then((permit) => {
        admitted.push(requestId);
        return permit;
      })
    );
    active.release();

    for (let i = 0; i < promises.length; i += 1) {
      await vi.waitFor(() => expect(admitted.length).toBe(i + 1));
      // Release whichever request the round-robin scheduler admitted.
      const index = ["a1", "a2", "b1", "a3", "b2"].indexOf(admitted[i]!);
      (await promises[index]!).release();
    }
    expect(admitted).toEqual(["a1", "b1", "a2", "b2", "a3"]);
  });

  it("isolates WAIT capacity from normal execution", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 8,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const wait = await scheduler.acquire(
      request(clock, { requestId: "wait", actorId: "a", executionClass: "wait", toolName: "read_process_output" })
    );
    const normal = await scheduler.acquire(
      request(clock, { requestId: "normal", actorId: "a", toolName: "read_file" })
    );
    expect(scheduler.snapshot()).toMatchObject({
      saturated: true,
      global: { active: 1 },
      wait: { active: 1 }
    });
    normal.release();
    expect(scheduler.snapshot()).toMatchObject({
      saturated: false,
      global: { active: 0 },
      wait: { active: 1 }
    });
    wait.release();
  });

  it("makes double release harmless and never drives accounting negative", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({ clock });
    const permit = await scheduler.acquire(request(clock, { requestId: "one", actorId: "a" }));
    permit.release();
    permit.release();
    expect(scheduler.snapshot().global.active).toBe(0);
  });

  it("rejects queued and new admission on shutdown while keeping active permits", async () => {
    const clock = new FakeClock();
    const scheduler = new ExecutionAdmissionScheduler({
      clock,
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 4,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const active = await scheduler.acquire(request(clock, { requestId: "active", actorId: "a" }));
    const queued = scheduler.acquire(request(clock, { requestId: "queued", actorId: "b" }));
    scheduler.shutdown();
    await expect(queued).rejects.toMatchObject({ code: "gateway_shutting_down" });
    await expect(scheduler.acquire(request(clock, { requestId: "new", actorId: "c" }))).rejects.toMatchObject({
      code: "gateway_shutting_down"
    });
    expect(scheduler.snapshot().global.active).toBe(1);
    active.release();
    expect(scheduler.snapshot().global.active).toBe(0);
  });
});

describe("manifest classification", () => {
  it.each(["jc", "dc"] as const)("classifies every governed %s tool deterministically", (lane) => {
    const names = governedAdmissionToolNames(lane);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(["execution", "wait"]).toContain(classifyAdmissionTool(lane, name));
    }
  });

  it("classifies canonical polling operations as WAIT and unknown tools as execution", () => {
    expect(classifyAdmissionTool("jc", "read_process_output")).toBe("wait");
    expect(classifyAdmissionTool("dc", "read_process_output")).toBe("wait");
    expect(classifyAdmissionTool("jc", "definitely_unknown")).toBe("execution");
    expect(classifyAdmissionTool("dc", "definitely_unknown")).toBe("execution");
  });
});
