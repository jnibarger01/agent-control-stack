import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, WORKER_PROTOCOL_VERSION } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { executeApprovedWorkItem } from "./execute-approved.js";

const transition = { via: "domain_service" as const };

describe("Phase 2 Slice 1 approved execution dispatcher", () => {
  it("does not claim or execute until the complete V2 result path exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-v2-boundary-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    const execute = vi.fn(async () => ({ ok: true as const, executionMode: "dry_run" as const, output: "unused" }));
    try {
      const item = store.create({
        title: "Approved dispatcher item",
        requester: "agent",
        intent: "prove the legacy dispatcher remains disabled",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "simulate", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(item.id, transition);

      const result = await executeApprovedWorkItem({
        store,
        workerId: "legacy-dispatcher",
        execute
      });

      expect(result).toEqual({
        executed: false,
        reason: `${WORKER_PROTOCOL_VERSION} result acceptance is not available in Phase 2 Slice 1`
      });
      expect(execute).not.toHaveBeenCalled();
      expect(store.get(item.id)?.status).toBe("approved");
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
      expect(store.readEvents().map((event) => event.name)).not.toContain("work_item.running");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
