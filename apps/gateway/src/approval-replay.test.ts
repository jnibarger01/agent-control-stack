import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("a replay returns 200 and appends exactly one approval.granted and one policy.decided for the approval", async () => {
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
        ((await app.inject({ method: "GET", url: `/work-items/${workItemId}`, headers: bearer })).json() as {
          events: Array<{ name: string }>;
        }).events;
      const count = (all: Array<{ name: string }>, name: string) => all.filter((e) => e.name === name).length;

      expect((await approve("first")).statusCode).toBe(200);
      const afterFirst = await events();
      expect((await approve("replay")).statusCode).toBe(200);
      const afterReplay = await events();

      expect(count(afterReplay, "approval.granted")).toBe(1);
      expect(count(afterReplay, "execution_plan_approval.granted")).toBe(1);
      expect(count(afterReplay, "work_item.approved")).toBe(1);
      expect(afterReplay).toHaveLength(afterFirst.length);
    } finally {
      await app.close();
    }
  });
});
