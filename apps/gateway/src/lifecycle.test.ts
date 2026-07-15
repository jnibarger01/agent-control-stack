import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type GatewayProcess } from "./lifecycle.js";

describe("gateway process lifecycle", () => {
  it("closes once and exits cleanly on SIGTERM", async () => {
    const runtime = new EventEmitter() as EventEmitter & GatewayProcess;
    runtime.exit = vi.fn(() => {
      throw new Error("unexpected forced exit");
    }) as never;
    const close = vi.fn(async () => undefined);
    const log = { info: vi.fn(), error: vi.fn() };

    installGracefulShutdown({ close, log } as never, runtime, 100);
    runtime.emit("SIGTERM");
    runtime.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(runtime.exitCode).toBe(0);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "gateway shutdown complete");
  });
});
