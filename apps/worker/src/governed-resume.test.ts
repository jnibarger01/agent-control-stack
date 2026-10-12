import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("governed unit pass in the worker", () => {
  const keys = [
    "ACS_GOVERNED_WORKER_ACTORS",
    "ACS_GOVERNED_WORKER_ID",
    "ACS_GOVERNED_MAX_UNITS",
    "ACS_CODING_CHECKOUT_ROOT",
    "ACS_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN"
  ] as const;
  const previous = new Map<string, string | undefined>();
  let directory: string | undefined;

  function isolate() {
    for (const key of keys) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    directory = mkdtempSync(join(tmpdir(), "acs-worker-governed-"));
    return join(directory, "control.db");
  }

  afterEach(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("runs the governed pass once per cycle with the worker's database", async () => {
    const dbPath = isolate();
    const pass = vi.fn(async () => undefined);
    await runWorkerOnce({ dbPath, workerId: "governed-1", resumeGovernedUnits: pass });
    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith(dbPath);
  });

  it("is off by default and keeps the work-item loop running", async () => {
    const dbPath = isolate();
    const result = await runWorkerOnce({ dbPath, workerId: "governed-2" });
    expect(result.executed).toBe(false);
  });

  it("fails the cycle loudly on a malformed governed configuration instead of running ungoverned", async () => {
    const dbPath = isolate();
    process.env.ACS_GOVERNED_WORKER_ACTORS = "{not json";
    await expect(runWorkerOnce({ dbPath, workerId: "governed-3" })).rejects.toMatchObject({
      code: "governed_worker_config_invalid"
    });
  });
});
