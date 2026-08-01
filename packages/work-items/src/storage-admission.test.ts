import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseStorage } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";

describe("SQLite storage admission", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("rejects mutations before BEGIN and preserves audit atomicity", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-storage-admission-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const freeBytes = Number(statfsSync(directory).bavail) * Number(statfsSync(directory).bsize);
    const store = new SqliteWorkItemStore(dbPath, {
      storagePolicy: { rejectFreeBytes: freeBytes + 1, recoveryFreeBytes: freeBytes + 1 }
    });

    expect(() =>
      store.create({
        title: "blocked",
        requester: "user",
        intent: "verify storage admission",
        requestedActions: [{ kind: "manual", description: "blocked" }],
        risk: "low"
      })
    ).toThrow("storage capacity is unsafe");
    expect(store.readEvents()).toHaveLength(0);
    store.close();
  });

  it("recovers from read-only mode after the recovery reserve is met", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-storage-recovery-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const freeBytes = Number(statfsSync(directory).bavail) * Number(statfsSync(directory).bsize);
    const policy = {
      warnFreeBytes: 0,
      rejectFreeBytes: freeBytes + 1,
      recoveryFreeBytes: 0,
      walCheckpointBytes: Number.MAX_SAFE_INTEGER,
      walRejectBytes: Number.MAX_SAFE_INTEGER
    };
    expect(inspectDatabaseStorage(dbPath, policy)).toMatchObject({ ok: false, diagnostics: { mode: "read_only" } });
    // The same policy models space returning: recovery is below any possible free-space reading.
    expect(inspectDatabaseStorage(dbPath, policy, "read_only")).toMatchObject({
      ok: true,
      diagnostics: { mode: "normal" }
    });
    const store = new SqliteWorkItemStore(dbPath, {
      storagePolicy: { warnFreeBytes: 0, rejectFreeBytes: 0, recoveryFreeBytes: 0 }
    });
    expect(() =>
      store.create({
        title: "recovered",
        requester: "user",
        intent: "recovered",
        requestedActions: [{ kind: "manual", description: "recovered" }],
        risk: "low"
      })
    ).not.toThrow();
    store.close();
  });
});
