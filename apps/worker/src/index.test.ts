import { exec, fork, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, WORKER_PROTOCOL_VERSION } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { runWorkerOnce, workerResultIdempotencyKey } from "./index.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  fork: vi.fn(),
  spawn: vi.fn()
}));

const domainTransition = { via: "domain_service" } as const;

describe("Phase 2 Slice 1 worker boundary", () => {
  it("keeps the production one-shot worker non-executing until V2 result acceptance exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-v2-boundary-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Approved but not dispatchable",
        requester: "agent",
        intent: "prove the legacy one-shot worker cannot claim after schema v6",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      store.close();
      vi.clearAllMocks();

      const result = await runWorkerOnce({ dbPath, workerId: "legacy-one-shot-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result).toEqual({
          executed: false,
          reason: `${WORKER_PROTOCOL_VERSION} result acceptance is not available in Phase 2 Slice 1`
        });
        expect(check.get(workItem.id)?.status).toBe("approved");
        expect(check.readEvents().map((event) => event.name)).not.toContain("work_item.running");
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(fork).not.toHaveBeenCalled();
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the historical idempotency helper deterministic", () => {
    expect(workerResultIdempotencyKey("wrk_1", "lease_1", "worker_1")).toBe(
      workerResultIdempotencyKey("wrk_1", "lease_1", "worker_1")
    );
    expect(workerResultIdempotencyKey("wrk_1", "lease_1", "worker_1")).not.toBe(
      workerResultIdempotencyKey("wrk_1", "lease_2", "worker_1")
    );
  });

  it("uses ACS_DB_PATH without enabling execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-env-path-"));
    const dbPath = join(directory, "control.db");
    vi.stubEnv("ACS_DB_PATH", dbPath);
    try {
      await expect(runWorkerOnce()).resolves.toEqual({
        executed: false,
        reason: `${WORKER_PROTOCOL_VERSION} result acceptance is not available in Phase 2 Slice 1`
      });
      const check = new SqliteWorkItemStore(dbPath);
      check.close();
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
