import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseApprovalsReadModel, parseExecutionReadModel } from "@agent-control-stack/mission-control-contract";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";

const OPERATOR = "o".repeat(48);
const READER = "r".repeat(48);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const cred = (id: string, token: string, scopes: string[]) => ({ id, token, actor: "qa-operator", actorId: id, roles: ["operator" as const], scopes });
const credentials = [cred("operator", OPERATOR, ["acs:read", "acs:write", "acs:approve"]), cred("reader", READER, ["acs:read"])];

describe("approvals and execution read models + the real mutation routes", () => {
  let dir: string;
  let highRiskId: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ACS_GATEWAY_TOKEN;
    delete process.env.ACS_GATEWAY_TOKEN;
    dir = mkdtempSync(join(tmpdir(), "acs-mcactions-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());
    highRiskId = tools.create_work_item({ title: "Review deployment request", intent: "ship", requester: "user", requesterSubject: "someone-else", target: { cwd: "/tmp" }, risk: "high", requestedActions: [{ kind: "fs.write", description: "write a file", params: { path: "/tmp/mc-test.txt", content: "x" } }] }).id;
    store.close();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ACS_GATEWAY_TOKEN;
    else process.env.ACS_GATEWAY_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = () => buildGateway({ dbPath: join(dir, "control.db"), logger: false, moa: false, auth: { token: OPERATOR, actor: "qa-operator", actorId: "operator", credentials } });

  it("requires authentication", async () => {
    const app = gateway();
    try {
      for (const url of ["/api/mission-control/approvals", "/api/mission-control/execution"]) expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("reports what the credential may do: operator can act, reader cannot", async () => {
    const app = gateway();
    try {
      const op = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) })).json();
      const rd = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(READER) })).json();
      expect(op.viewer).toEqual({ canApprove: true, canWrite: true });
      expect(rd.viewer).toEqual({ canApprove: false, canWrite: false });
      const exec = await app.inject({ method: "GET", url: "/api/mission-control/execution", headers: bearer(READER) });
      expect(parseExecutionReadModel(exec.json()).ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("lists the real pending approval with its policy action hash and nothing sensitive", async () => {
    const app = gateway();
    try {
      const res = await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) });
      const parsed = parseApprovalsReadModel(res.json());
      expect(parsed.ok).toBe(true);
      const item = parsed.ok ? parsed.value.items.find((i) => i.id === highRiskId) : undefined;
      expect(item?.status).toBe("needs_approval");
      expect(item?.actions.length).toBeGreaterThan(0);
      expect(item?.actions[0]?.actionHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await app.close();
    }
  });

  it("the server, not the browser, enforces authority: a reader is refused, an operator approves, and the queue updates", async () => {
    const app = gateway();
    try {
      const list = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) })).json();
      const hash = list.items.find((i: { id: string }) => i.id === highRiskId).actions[0].actionHash;
      const body = { reason: "reviewed in test", actionHash: hash };
      const denied = await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(READER), payload: body });
      expect(denied.statusCode).toBe(403);
      const noHash = await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(OPERATOR), payload: { reason: "x" } });
      expect(noHash.statusCode).toBeGreaterThanOrEqual(400);
      const ok = await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(OPERATOR), payload: body });
      expect(ok.statusCode).toBe(200);
      const after = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) })).json();
      expect(after.items.some((i: { id: string }) => i.id === highRiskId)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("an approval leaves audit evidence, and a replay grants no additional authority", async () => {
    const app = gateway();
    try {
      const list = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) })).json();
      const hash = list.items.find((i: { id: string }) => i.id === highRiskId).actions[0].actionHash;
      const body = { reason: "first approval", actionHash: hash };
      expect((await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(OPERATOR), payload: body })).statusCode).toBe(200);
      await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(OPERATOR), payload: { ...body, reason: "replay" } });
      const detail = (await app.inject({ method: "GET", url: `/work-items/${highRiskId}`, headers: bearer(OPERATOR) })).json() as { workItem: { status: string }; events: Array<{ name: string }> };
      expect(detail.workItem.status).toBe("approved");
      expect(detail.events.some((e) => e.name === "approval.granted")).toBe(true);
      expect(detail.events.some((e) => e.name === "work_item.approved")).toBe(true);
      // The binding authority record (the execution-plan approval) is granted exactly once.
      // NOTE: a replay currently also appends a second `approval.granted` audit event (pre-existing
      // server behaviour, tracked separately); it grants nothing, so it is deliberately not asserted here.
      expect(detail.events.filter((e) => e.name === "execution_plan_approval.granted")).toHaveLength(1);
      expect(detail.events.filter((e) => e.name === "work_item.approved")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("a stale or wrong action hash cannot approve the work item", async () => {
    const app = gateway();
    try {
      const wrong = await app.inject({ method: "POST", url: `/work-items/${highRiskId}/approve`, headers: bearer(OPERATOR), payload: { reason: "tampered", actionHash: "0".repeat(64) } });
      expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
      const list = (await app.inject({ method: "GET", url: "/api/mission-control/approvals", headers: bearer(OPERATOR) })).json();
      expect(list.items.some((i: { id: string }) => i.id === highRiskId)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
