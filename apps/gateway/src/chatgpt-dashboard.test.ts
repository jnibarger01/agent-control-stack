import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { dashboardOverview, executionDetail } from "./chatgpt-dashboard.js";
describe("ChatGPT dashboard data", () =>
  it("derives a read-only overview and detail from ACS state", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dashboard-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    try {
      const item = store.create({
        title: "Blocked",
        requester: "user",
        intent: "Inspect ACS",
        target: { cwd: "/repo" },
        requestedActions: [],
        risk: "low"
      });
      store.blockWorkItem(item.id);
      expect(dashboardOverview(store)).toMatchObject({ blockedExecutions: 1, findings: { total: 1 } });
      expect(executionDetail(store, item.id)).toMatchObject({
        execution: { id: item.id, intent: "Inspect ACS" },
        findings: ["Execution is blocked."]
      });
      expect(executionDetail(store, "missing")).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }));
