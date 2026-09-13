import { describe, expect, it } from "vitest";
import {
  getHostBootId,
  getProcessStartTicks,
  parseStartedProcessPid,
  resolveCurrentProcessIdentity
} from "./process-identity.js";

describe("ADR-0016 Slice 5: process identity resolution", () => {
  it("getHostBootId returns a stable, non-empty value across calls", () => {
    const first = getHostBootId();
    const second = getHostBootId();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("getProcessStartTicks resolves a non-negative start time for the current process", () => {
    const ticks = getProcessStartTicks(process.pid);
    expect(Number.isInteger(ticks)).toBe(true);
    expect(ticks).toBeGreaterThanOrEqual(0);
    // Idempotent: the same live pid's start time never changes.
    expect(getProcessStartTicks(process.pid)).toBe(ticks);
  });

  it("getProcessStartTicks fails closed for a pid that does not exist", () => {
    // pid 1 always exists on Linux; pick a pid far outside any realistic
    // live range so this does not race a real process.
    const bogusPid = 2_000_000_000;
    expect(() => getProcessStartTicks(bogusPid)).toThrow(/desktop_commander_process_stat_unavailable|could not read/);
  });

  it("getProcessStartTicks rejects a non-positive pid before touching the filesystem", () => {
    expect(() => getProcessStartTicks(0)).toThrow();
    expect(() => getProcessStartTicks(-5)).toThrow();
  });

  it("resolveCurrentProcessIdentity returns the full triple for a live pid", () => {
    const identity = resolveCurrentProcessIdentity(process.pid);
    expect(identity.pid).toBe(process.pid);
    expect(identity.bootId).toBe(getHostBootId());
    expect(identity.procStartTicks).toBe(getProcessStartTicks(process.pid));
  });

  it("resolveCurrentProcessIdentity fails closed rather than guessing when the pid is gone", () => {
    expect(() => resolveCurrentProcessIdentity(2_000_000_000)).toThrow();
  });

  it("parseStartedProcessPid extracts a pid from typical Desktop Commander wording", () => {
    expect(parseStartedProcessPid("Process started with PID 4242")).toBe(4242);
    expect(parseStartedProcessPid("pid: 99")).toBe(99);
    expect(parseStartedProcessPid("Started process (pid=1234) successfully")).toBe(1234);
  });

  it("parseStartedProcessPid returns undefined rather than guessing when there is no confident match", () => {
    expect(parseStartedProcessPid("")).toBeUndefined();
    expect(parseStartedProcessPid("no numbers here at all")).toBeUndefined();
    expect(parseStartedProcessPid("this mentions rapid change but no pid field")).toBeUndefined();
  });
});
