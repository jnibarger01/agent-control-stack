import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway, type JevObservationWorkerLifecycle } from "./server.js";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acs-jev4-gateway-"));
  directories.push(directory);
  return join(directory, "control.db");
}

function lifecycle() {
  const start = vi.fn();
  const stop = vi.fn(async () => undefined);
  return { start, stop, worker: { start, stop } satisfies JevObservationWorkerLifecycle };
}

describe("JEV-4 gateway lifecycle", () => {
  it("starts and stops the observation worker when explicitly enabled", async () => {
    const fake = lifecycle();
    const createWorker = vi.fn(() => fake.worker);
    const app = buildGateway({
      dbPath: dbPath(),
      logger: false,
      acpAdapter: false,
      moa: false,
      jevObservation: { enabled: true, createWorker }
    });

    await app.ready();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);

    await app.close();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("uses ACS_JEV_ENABLED=1 as the production activation gate", async () => {
    vi.stubEnv("ACS_JEV_ENABLED", "1");
    const fake = lifecycle();
    const createWorker = vi.fn(() => fake.worker);
    const app = buildGateway({
      dbPath: dbPath(),
      logger: false,
      acpAdapter: false,
      moa: false,
      jevObservation: { createWorker }
    });

    await app.ready();
    expect(fake.start).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("keeps ACS ready when observational worker startup fails", async () => {
    const stop = vi.fn(async () => undefined);
    const app = buildGateway({
      dbPath: dbPath(),
      logger: false,
      acpAdapter: false,
      moa: false,
      jevObservation: {
        enabled: true,
        createWorker: () => ({
          start: () => {
            throw new Error("observer unavailable");
          },
          stop
        })
      }
    });

    await app.ready();
    await app.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("explicit disable wins even when ACS_JEV_ENABLED is set", async () => {
    vi.stubEnv("ACS_JEV_ENABLED", "1");
    const createWorker = vi.fn(() => lifecycle().worker);
    const app = buildGateway({
      dbPath: dbPath(),
      logger: false,
      acpAdapter: false,
      moa: false,
      jevObservation: { enabled: false, createWorker }
    });

    await app.ready();
    expect(createWorker).not.toHaveBeenCalled();
    await app.close();
  });
});
