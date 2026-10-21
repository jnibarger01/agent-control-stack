import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";

const OPERATOR = "o".repeat(48);
const bearer = { authorization: `Bearer ${OPERATOR}` };
const credentials = [
  {
    id: "operator",
    token: OPERATOR,
    actor: "qa-operator",
    actorId: "operator",
    roles: ["operator" as const],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  }
];

function grantSnapshot(dbPath: string, workItemId: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      approvalRecords: db
        .prepare(
          `SELECT action_hash, approved_by, reason, status, created_at, expires_at, consumed_at
           FROM approval_records WHERE work_item_id = ? ORDER BY action_hash`
        )
        .all(workItemId),
      planApprovals: db
        .prepare(
          `SELECT approval_id, approved_by_actor_id, reason, status, created_at, expires_at
           FROM execution_plan_approvals WHERE work_item_id = ? ORDER BY approval_id`
        )
        .all(workItemId)
    };
  } finally {
    db.close();
  }
}

describe("POST /work-items/:id/approve replay", () => {
  let dir: string;
  let workItemId: string;
  let actionHash: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ACS_GATEWAY_TOKEN;
    delete process.env.ACS_GATEWAY_TOKEN;
    dir = mkdtempSync(join(tmpdir(), "acs-approve-replay-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const workItem = createWorkItemTools(store, policy).create_work_item({
      title: "Replay target",
      intent: "approve twice",
      requester: "user",
      requesterSubject: "someone-else",
      target: { cwd: "/repo" },
      risk: "high",
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }]
    });
    workItemId = workItem.id;
    actionHash = policy.evaluateWorkItem(workItem, "qa-operator", "approve")[0]!.actionHash;
    store.close();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ACS_GATEWAY_TOKEN;
    else process.env.ACS_GATEWAY_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a replay returns 200 and appends no events and grants nothing new", async () => {
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      moa: false,
      auth: { token: OPERATOR, actor: "qa-operator", actorId: "operator", credentials }
    });
    try {
      const approve = (reason: string) =>
        app.inject({
          method: "POST",
          url: `/work-items/${workItemId}/approve`,
          headers: bearer,
          payload: { reason, actionHash }
        });
      const events = async () =>
        (
          (await app.inject({ method: "GET", url: `/work-items/${workItemId}`, headers: bearer })).json() as {
            events: Array<{ id: string; name: string }>;
          }
        ).events;
      // Every audit event in the store, not only the ones the work-item view returns.
      const allEventIds = () => {
        const db = new DatabaseSync(join(dir, "control.db"), { readOnly: true });
        try {
          return db.prepare("SELECT id FROM audit_events ORDER BY rowid").all();
        } finally {
          db.close();
        }
      };
      const count = (all: Array<{ name: string }>, name: string) => all.filter((e) => e.name === name).length;

      expect((await approve("first")).statusCode).toBe(200);
      const afterFirst = await events();
      const allBefore = allEventIds();
      const grantsBefore = grantSnapshot(join(dir, "control.db"), workItemId);
      expect(count(afterFirst, "approval.granted")).toBe(1);

      const replay = await approve("replay");
      expect(replay.statusCode).toBe(200);
      expect((replay.json() as { workItem: { status: string } }).workItem.status).toBe("approved");
      const afterReplay = await events();

      // Zero new events (work-item view and the whole audit log) and zero new grants.
      expect(afterReplay.map((event) => event.id)).toEqual(afterFirst.map((event) => event.id));
      expect(allEventIds()).toEqual(allBefore);
      expect(grantSnapshot(join(dir, "control.db"), workItemId)).toEqual(grantsBefore);

      expect(count(afterReplay, "approval.granted")).toBe(1);
      expect(count(afterReplay, "execution_plan_approval.granted")).toBe(1);
      expect(count(afterReplay, "work_item.approved")).toBe(1);
      expect(afterReplay).toHaveLength(afterFirst.length);
    } finally {
      await app.close();
    }
  });
});
