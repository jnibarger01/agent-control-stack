import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installRuntimeShutdown } from "./lifecycle.js";

describe("runtime lifecycle", () => {
  it("closes only once when shutdown signals repeat", async () => {
    const processRef = new EventEmitter() as EventEmitter & NodeJS.Process;
    const close = vi.fn(async () => undefined);
    installRuntimeShutdown({ status: {} as never, close }, processRef);

    processRef.emit("SIGTERM");
    processRef.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(processRef.exitCode).toBe(0);
  });
});
