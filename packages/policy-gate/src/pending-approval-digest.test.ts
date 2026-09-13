import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { createPolicyEngine, type PolicyEngine, type PolicyEvaluation } from "./policy.js";
import {
  collectPendingApprovalDigest,
  deliverPendingApprovalDigest,
  loadPendingApprovalDigestConfig,
  runPendingApprovalDigestOnce
} from "./pending-approval-digest.js";
import { createWorkItemTools } from "./tools.js";

describe("pending-approval digest", () => {
  it("defaults to disabled (local-first)", () => {
    const config = loadPendingApprovalDigestConfig({});
    expect(config.enabled).toBe(false);
    expect(config.olderThanMinutes).toBe(30);
    expect(config.stdout).toBe(true);
  });

  it("fixture with stale pending items produces one digest; empty queue is silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-pending-digest-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);
    const lines: string[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch & {
      mock: { calls: Array<[unknown, RequestInit?]> };
    };

    try {
      const now = new Date("2026-09-13T17:00:00.000Z");
      const staleAt = new Date(now.getTime() - 45 * 60_000).toISOString();
      const freshAt = new Date(now.getTime() - 5 * 60_000).toISOString();

      const stale = tools.create_work_item({
        title: "Stale gated write",
        requester: "user",
        intent: "verify stale pending digest",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "high"
      });
      expect(stale.status).toBe("needs_approval");
      bumpUpdatedAt(store, stale.id, staleAt);

      const fresh = tools.create_work_item({
        title: "Fresh gated write",
        requester: "user",
        intent: "verify fresh pending is ignored",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["README.md"] } }],
        risk: "high"
      });
      expect(fresh.status).toBe("needs_approval");
      bumpUpdatedAt(store, fresh.id, freshAt);

      const empty = await runPendingApprovalDigestOnce({
        config: {
          enabled: true,
          olderThanMinutes: 30,
          stdout: true,
          dbPath: join(dir, "control.db"),
          actor: "ops-digest"
        },
        store: { list: () => [] },
        policy,
        now,
        log: (line) => lines.push(line),
        fetchImpl
      });
      expect(empty).toBeUndefined();
      expect(lines).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();

      const digest = await runPendingApprovalDigestOnce({
        config: {
          enabled: true,
          olderThanMinutes: 30,
          stdout: true,
          webhookUrl: "http://127.0.0.1:9/ops/pending-approvals",
          dbPath: join(dir, "control.db"),
          actor: "ops-digest"
        },
        store,
        policy,
        now,
        log: (line) => lines.push(line),
        fetchImpl
      });

      expect(digest).toBeDefined();
      expect(digest?.kind).toBe("pending_approval_digest");
      expect(digest?.count).toBe(1);
      expect(digest?.items).toHaveLength(1);
      expect(digest?.items[0]?.workItemId).toBe(stale.id);
      expect(digest?.items[0]?.actionHash).toMatch(/^[a-f0-9]{64}$/i);
      expect(digest?.items[0]?.updatedAt).toBe(staleAt);
      expect(JSON.stringify(digest)).not.toMatch(/secret|token|password|Bearer/i);
      expect(Object.keys(digest!.items[0]!).sort()).toEqual(["actionHash", "ageMinutes", "updatedAt", "workItemId"]);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(digest);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/ops/pending-approvals");
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(digest);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent when digest is disabled even if stale items exist", async () => {
    const lines: string[] = [];
    const digest = await runPendingApprovalDigestOnce({
      config: {
        enabled: false,
        olderThanMinutes: 1,
        stdout: true,
        dbPath: "unused.db",
        actor: "ops-digest"
      },
      store: {
        list: () => [
          fixtureWorkItem({
            id: "wrk_stale",
            status: "needs_approval",
            updatedAt: "2020-01-01T00:00:00.000Z"
          })
        ]
      },
      policy: fakeRequireApprovalPolicy("hash-a"),
      log: (line) => lines.push(line)
    });
    expect(digest).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("collects only require_approval action hashes for stale needs_approval items", () => {
    const now = new Date("2026-09-13T17:00:00.000Z");
    const digest = collectPendingApprovalDigest({
      workItems: [
        fixtureWorkItem({
          id: "wrk_old",
          status: "needs_approval",
          updatedAt: "2026-09-13T16:00:00.000Z"
        }),
        fixtureWorkItem({
          id: "wrk_approved",
          status: "approved",
          updatedAt: "2026-09-13T15:00:00.000Z"
        })
      ],
      policy: fakeRequireApprovalPolicy("abc123"),
      actor: "ops-digest",
      olderThanMinutes: 30,
      now
    });
    expect(digest).toEqual({
      kind: "pending_approval_digest",
      generatedAt: now.toISOString(),
      olderThanMinutes: 30,
      count: 1,
      items: [
        {
          workItemId: "wrk_old",
          actionHash: "abc123",
          updatedAt: "2026-09-13T16:00:00.000Z",
          ageMinutes: 60
        }
      ]
    });
  });

  it("deliverPendingApprovalDigest can be stdout-only without webhook", async () => {
    const lines: string[] = [];
    const digest = {
      kind: "pending_approval_digest" as const,
      generatedAt: "2026-09-13T17:00:00.000Z",
      olderThanMinutes: 30,
      count: 1,
      items: [
        {
          workItemId: "wrk_1",
          actionHash: "a".repeat(64),
          updatedAt: "2026-09-13T16:00:00.000Z",
          ageMinutes: 60
        }
      ]
    };
    const result = await deliverPendingApprovalDigest(digest, {
      stdout: true,
      log: (line) => lines.push(line)
    });
    expect(result).toEqual({ stdout: true, webhook: false });
    expect(lines).toHaveLength(1);
  });
});

function bumpUpdatedAt(store: SqliteWorkItemStore, workItemId: string, updatedAt: string): void {
  const db = (
    store as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
    }
  ).db;
  db.prepare(`UPDATE work_items SET updated_at = ? WHERE id = ?`).run(updatedAt, workItemId);
}

function fixtureWorkItem(overrides: Partial<WorkItem> & Pick<WorkItem, "id" | "status" | "updatedAt">): WorkItem {
  return {
    title: "fixture",
    requester: "user",
    intent: "fixture",
    target: {},
    requestedActions: [{ kind: "fs.write", description: "write", params: {} }],
    risk: "high",
    createdAt: overrides.updatedAt,
    ...overrides
  };
}

function fakeRequireApprovalPolicy(actionHash: string): PolicyEngine {
  return {
    evaluateWorkItem(): PolicyEvaluation[] {
      return [
        {
          action: { kind: "fs.write", description: "write", params: {} },
          actionHash,
          context: {
            workItemId: "wrk",
            actor: "ops-digest",
            operation: "approve",
            requester: "user",
            risk: "high",
            action: { kind: "fs.write", description: "write", params: {} }
          },
          decision: {
            decision: "require_approval",
            reason: "fixture",
            matchedRules: ["approval:fixture"],
            requiredApprover: "user"
          }
        }
      ];
    },
    summarize() {
      return {
        decision: "require_approval",
        reason: "fixture",
        matchedRules: ["approval:fixture"],
        requiredApprover: "user"
      };
    }
  };
}
