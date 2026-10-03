import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("default coding mission resume", () => {
  const keys = ["ACS_CODING_CHECKOUT_ROOT", "ACS_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;
  const previous = new Map<string, string | undefined>();
  let directory: string | undefined;

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

  it("keeps the work-item loop running when coding mission config is absent", async () => {
    for (const key of keys) previous.set(key, process.env[key]);
    for (const key of keys) delete process.env[key];
    directory = mkdtempSync(join(tmpdir(), "acs-worker-coding-"));
    const result = await runWorkerOnce({ dbPath: join(directory, "control.db"), workerId: "coding-resume" });
    expect(result.executed).toBe(false);
  });
});
