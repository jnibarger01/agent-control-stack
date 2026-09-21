import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  GATEWAY_SHUTTING_DOWN_CODE,
  installGracefulShutdown,
  ShutdownController,
  waitForLeaseDrain,
  type GatewayProcess
} from "./lifecycle.js";

describe("ShutdownController", () => {
  it("rejects claims once shutting down but leaves renew/submit callers unblocked", () => {
    const controller = new ShutdownController();
    expect(controller.isShuttingDown()).toBe(false);
    controller.assertAcceptingClaims();
    controller.assertAcceptingMutatingIntake();

    expect(controller.beginShutdown()).toBe(true);
    expect(controller.beginShutdown()).toBe(false);
    expect(controller.isShuttingDown()).toBe(true);

    expect(() => controller.assertAcceptingClaims()).toThrow(ControlStackError);
    try {
      controller.assertAcceptingClaims();
    } catch (error) {
      expect(error).toBeInstanceOf(ControlStackError);
      expect((error as ControlStackError).code).toBe(GATEWAY_SHUTTING_DOWN_CODE);
    }
    expect(() => controller.assertAcceptingMutatingIntake()).toThrow(ControlStackError);
    // Renew/submit do not call the claim/intake asserts — in-flight work stays allowed.
  });
});

describe("waitForLeaseDrain", () => {
  it("returns early when leases drain to zero", async () => {
    let active = 2;
    const result = await waitForLeaseDrain({
      drainTimeoutMs: 1_000,
      drainPollMs: 5,
      countActiveLeases: () => active,
      failExpiredLeases: () => {
        active = Math.max(0, active - 1);
      },
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })()
    });
    expect(result.timedOut).toBe(false);
    expect(result.activeLeases).toBe(0);
  });

  it("force-finishes after the configured drain timeout while leases remain", async () => {
    const result = await waitForLeaseDrain({
      drainTimeoutMs: 30,
      drainPollMs: 5,
      countActiveLeases: () => 3,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          const current = t;
          t += 10;
          return current;
        };
      })()
    });
    expect(result.timedOut).toBe(true);
    expect(result.activeLeases).toBe(3);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
  });
});

describe("gateway process lifecycle", () => {
  it("closes once and exits cleanly on SIGTERM", async () => {
    const runtime = new EventEmitter() as EventEmitter & GatewayProcess;
    runtime.exit = vi.fn(() => {
      throw new Error("unexpected forced exit");
    }) as never;
    const close = vi.fn(async () => undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    installGracefulShutdown({ close, log } as never, runtime, 100);
    runtime.emit("SIGTERM");
    runtime.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(runtime.exitCode).toBe(0);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "gateway shutdown complete");
  });

  it("rejects new claims during drain while still closing after drain timeout", async () => {
    const runtime = new EventEmitter() as EventEmitter & GatewayProcess;
    runtime.exit = vi.fn(() => {
      throw new Error("unexpected forced exit");
    }) as never;
    const close = vi.fn(async () => undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const controller = new ShutdownController();
    const onDrainStart = vi.fn();
    const onDrainFinish = vi.fn();
    let activeLeases = 1;
    let now = 0;

    installGracefulShutdown({ close, log } as never, {
      runtime,
      timeoutMs: 200,
      drainTimeoutMs: 40,
      drainPollMs: 5,
      shutdownController: controller,
      countActiveLeases: () => activeLeases,
      onDrainStart,
      onDrainFinish,
      sleep: async () => undefined,
      now: () => {
        const current = now;
        now += 10;
        return current;
      }
    });

    runtime.emit("SIGTERM");
    expect(controller.isShuttingDown()).toBe(true);
    expect(() => controller.assertAcceptingClaims()).toThrow(ControlStackError);

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(onDrainStart).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", activeLeases: 1, drainTimeoutMs: 40 })
    );
    expect(onDrainFinish).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", timedOut: true, activeLeases: 1 })
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", activeLeases: 1 }),
      "gateway shutdown drain timed out; force-closing"
    );
    expect(runtime.exitCode).toBe(0);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("finishes drain early when active leases clear before the timeout", async () => {
    const runtime = new EventEmitter() as EventEmitter & GatewayProcess;
    runtime.exit = vi.fn(() => {
      throw new Error("unexpected forced exit");
    }) as never;
    const close = vi.fn(async () => undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const onDrainFinish = vi.fn();
    let activeLeases = 2;
    let now = 0;

    installGracefulShutdown({ close, log } as never, {
      runtime,
      timeoutMs: 500,
      drainTimeoutMs: 200,
      drainPollMs: 5,
      countActiveLeases: () => activeLeases,
      failExpiredLeases: () => {
        activeLeases = 0;
      },
      onDrainFinish,
      sleep: async () => undefined,
      now: () => {
        const current = now;
        now += 5;
        return current;
      }
    });

    runtime.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(onDrainFinish).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGINT", timedOut: false, activeLeases: 0 })
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(runtime.exitCode).toBe(0);
  });
});
