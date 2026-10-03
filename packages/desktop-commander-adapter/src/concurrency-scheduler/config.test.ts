import { describe, expect, it } from "vitest";
import { desktopCommanderSchedulerConfigFromEnv } from "./config.js";

describe("desktopCommanderSchedulerConfigFromEnv", () => {
  it("uses conservative production defaults", () => {
    const config = desktopCommanderSchedulerConfigFromEnv({});
    expect(config.laneLimits).toEqual({ read: 8, search: 3, process: 3, mutation: 8 });
    expect(config.maxQueued).toBe(200);
    expect(config.maxQueuedPerAgent).toBe(25);
    expect(config.maxQueuedPerSession).toBe(50);
    expect(config.maxOutstandingPerAgent).toBe(16);
    expect(config.queueTimeoutMs).toBe(30_000);
    expect(config.lockTimeoutMs).toBe(20_000);
  });

  it("accepts explicit positive integer overrides", () => {
    const config = desktopCommanderSchedulerConfigFromEnv({
      ACS_DESKTOP_COMMANDER_SCHEDULER_READ_CONCURRENCY: "12",
      ACS_DESKTOP_COMMANDER_SCHEDULER_PROCESS_CONCURRENCY: "4",
      ACS_DESKTOP_COMMANDER_SCHEDULER_MAX_QUEUED: "300",
      ACS_DESKTOP_COMMANDER_SCHEDULER_LOCK_TIMEOUT_MS: "9000"
    });
    expect(config.laneLimits.read).toBe(12);
    expect(config.laneLimits.process).toBe(4);
    expect(config.maxQueued).toBe(300);
    expect(config.lockTimeoutMs).toBe(9000);
  });

  it("fails closed on invalid values", () => {
    expect(() =>
      desktopCommanderSchedulerConfigFromEnv({
        ACS_DESKTOP_COMMANDER_SCHEDULER_MUTATION_CONCURRENCY: "0"
      })
    ).toThrowError(expect.objectContaining({ code: "scheduler_config_invalid" }));
  });
});
