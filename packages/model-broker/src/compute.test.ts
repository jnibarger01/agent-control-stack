import { describe, expect, it } from "vitest";
import { availableMemoryFromMeminfo, computeHash, parseGpuCsv, readComputeSnapshot, type ComputeProbes } from "./compute.js";
import { GiB } from "./fixtures.test-support.js";

const probes = (overrides: Partial<ComputeProbes> = {}): ComputeProbes => ({
  totalMemory: () => 32 * GiB,
  freeMemory: () => 2 * GiB,
  cores: () => 8,
  load1: () => 0.5,
  readMeminfo: async () => "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\n",
  queryGpu: async () => undefined,
  now: () => new Date("2026-10-11T12:00:00.000Z"),
  ...overrides
});

describe("availableMemoryFromMeminfo", () => {
  it("reads MemAvailable in bytes", () => {
    expect(availableMemoryFromMeminfo("MemFree: 1 kB\nMemAvailable:   2048 kB\n")).toBe(2048 * 1024);
  });
  it("is undefined when absent or malformed", () => {
    expect(availableMemoryFromMeminfo(undefined)).toBeUndefined();
    expect(availableMemoryFromMeminfo("MemFree: 1 kB\n")).toBeUndefined();
    expect(availableMemoryFromMeminfo("MemAvailable: lots kB\n")).toBeUndefined();
  });
});

describe("parseGpuCsv", () => {
  it("parses devices in MiB", () => {
    expect(parseGpuCsv("NVIDIA RTX 4090, 24564, 20000\n")).toEqual([
      { name: "NVIDIA RTX 4090", totalBytes: 24564 * 1024 * 1024, freeBytes: 20000 * 1024 * 1024 }
    ]);
  });
  it("returns an empty list for empty output", () => {
    expect(parseGpuCsv("\n")).toEqual([]);
  });
  it.each(["name only", "a, b, c", "a, 100, 200", "a, -1, -2", "a,1,2,3", ", 1, 1"])("rejects the malformed line %j", (line) => {
    expect(parseGpuCsv(line)).toBeUndefined();
  });
});

describe("readComputeSnapshot", () => {
  it("uses MemAvailable, not MemFree", async () => {
    expect((await readComputeSnapshot(probes())).memory).toEqual({ totalBytes: 32 * GiB, availableBytes: 16 * GiB });
  });
  it("falls back to free memory, and never exceeds total", async () => {
    expect((await readComputeSnapshot(probes({ readMeminfo: async () => undefined }))).memory.availableBytes).toBe(2 * GiB);
    expect(
      (await readComputeSnapshot(probes({ readMeminfo: async () => "MemAvailable: 999999999 kB\n" }))).memory.availableBytes
    ).toBe(32 * GiB);
  });
  it("reports the GPU as unknown, not absent, when it cannot be asked", async () => {
    expect((await readComputeSnapshot(probes())).gpus).toEqual({ status: "unknown", devices: [] });
  });
  it("reports unparseable GPU output as unknown", async () => {
    expect((await readComputeSnapshot(probes({ queryGpu: async () => "garbage" }))).gpus.status).toBe("unknown");
  });
  it("reports none only when the tool answered with no devices", async () => {
    expect((await readComputeSnapshot(probes({ queryGpu: async () => "" }))).gpus.status).toBe("none");
  });
  it("reports present devices", async () => {
    const snapshot = await readComputeSnapshot(probes({ queryGpu: async () => "GPU, 8000, 6000\n" }));
    expect(snapshot.gpus.status).toBe("present");
    expect(snapshot.gpus.devices[0]).toMatchObject({ name: "GPU", freeBytes: 6000 * 1024 * 1024 });
  });
});

describe("computeHash", () => {
  it("ignores load jitter but changes with a meaningful memory change", async () => {
    const a = await readComputeSnapshot(probes());
    const jitter = await readComputeSnapshot(probes({ load1: () => 7 }));
    const less = await readComputeSnapshot(probes({ readMeminfo: async () => "MemAvailable: 4194304 kB\n" }));
    expect(computeHash(jitter)).toBe(computeHash(a));
    expect(computeHash(less)).not.toBe(computeHash(a));
  });
});
