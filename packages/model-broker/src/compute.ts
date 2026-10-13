import { readFile } from "node:fs/promises";
import os from "node:os";
import { runBoundedCommand, subprocessEnv } from "@agent-control-stack/machine-controller";
import { stableHash } from "@agent-control-stack/shared";
import type { ComputeSnapshot, GpuDevice } from "./types.js";

export interface ComputeProbes {
  totalMemory(): number;
  freeMemory(): number;
  cores(): number;
  load1(): number;
  /** Contents of /proc/meminfo, or undefined where it does not exist. */
  readMeminfo(): Promise<string | undefined>;
  /** Raw `nvidia-smi` CSV, or undefined if the tool is missing or failed. */
  queryGpu(): Promise<string | undefined>;
  now(): Date;
}

export function systemComputeProbes(): ComputeProbes {
  return {
    totalMemory: () => os.totalmem(),
    freeMemory: () => os.freemem(),
    cores: () => os.cpus().length,
    load1: () => os.loadavg()[0] ?? 0,
    now: () => new Date(),
    readMeminfo: async () => {
      try {
        return await readFile("/proc/meminfo", "utf8");
      } catch {
        return undefined;
      }
    },
    queryGpu: async () => {
      const result = await runBoundedCommand({
        cwd: process.cwd(),
        command: "nvidia-smi",
        args: ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
        env: subprocessEnv(),
        timeoutMs: 5_000,
        terminationGraceMs: 1_000,
        maxOutputBytes: 64 * 1024
      });
      // A missing tool (spawn error, null exit) or any non-zero exit is "could not ask", never "no GPU".
      return !result.timedOut && result.exitCode === 0 ? result.stdout : undefined;
    }
  };
}

/** MemAvailable is what can actually be allocated without swapping; MemFree undercounts page cache badly. */
export function availableMemoryFromMeminfo(meminfo: string | undefined): number | undefined {
  const match = meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/mu);
  if (!match) return undefined;
  const kib = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(kib) ? kib * 1024 : undefined;
}

const MIB = 1024 * 1024;

/** Parses nvidia-smi CSV. Any malformed line makes the whole answer unusable (returns undefined), never a guess. */
export function parseGpuCsv(csv: string): GpuDevice[] | undefined {
  const devices: GpuDevice[] = [];
  for (const line of csv.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 3 || !parts[0]) return undefined;
    const total = Number(parts[1]);
    const free = Number(parts[2]);
    if (!Number.isFinite(total) || !Number.isFinite(free) || total < 0 || free < 0 || free > total) return undefined;
    devices.push({ name: parts[0], totalBytes: Math.round(total * MIB), freeBytes: Math.round(free * MIB) });
  }
  return devices;
}

export async function readComputeSnapshot(probes: ComputeProbes = systemComputeProbes()): Promise<ComputeSnapshot> {
  const total = probes.totalMemory();
  const fromProc = availableMemoryFromMeminfo(await probes.readMeminfo());
  const available = Math.min(total, fromProc ?? probes.freeMemory());
  const csv = await probes.queryGpu();
  const devices = csv === undefined ? undefined : parseGpuCsv(csv);
  return {
    takenAt: probes.now().toISOString(),
    cpu: { cores: probes.cores(), load1: probes.load1() },
    memory: { totalBytes: total, availableBytes: available },
    gpus:
      devices === undefined
        ? { status: "unknown", devices: [] }
        : { status: devices.length === 0 ? "none" : "present", devices }
  };
}

/** Identifies the host state a decision saw. Load is bucketed so ordinary jitter does not change the hash. */
export function computeHash(snapshot: ComputeSnapshot): string {
  return stableHash({
    memoryAvailableMiB: Math.floor(snapshot.memory.availableBytes / MIB / 256) * 256,
    cores: snapshot.cpu.cores,
    gpus: snapshot.gpus.status,
    gpuFreeMiB: snapshot.gpus.devices.map((d) => Math.floor(d.freeBytes / MIB / 256) * 256)
  });
}
