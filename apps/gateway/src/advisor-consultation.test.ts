import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { handleMcpHttpRequest } from "./mcp.js";
import { runAdvisorConsultation, type AdvisorFlightReader } from "./advisor-consultation.js";
import type { AdvisorModelCaller, AdvisorModelRequest } from "@agent-control-stack/advisory/guidance";

const transition = { via: "domain_service" as const };

function claimedStore() {
  const directory = mkdtempSync(join(tmpdir(), "acs-advisor-gw-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({
    title: "Consult",
    requester: "agent",
    intent: "ask the advisor",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected a claim");
  store.enableAdvisorBinding(
    {
      subjectId: claimed.id,
      missionId: claimed.id,
      subjectKind: "work_item",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      advisorTransportModel: "ollama:advisor",
      requireBeforeCompletion: false
    },
    transition
  );
  return { directory, store, claimed };
}

function requestFor(claimed: { id: string; leaseId: string; workerId: string }) {
  return {
    checkpoint: "before_approach" as const,
    subject: {
      kind: "work_item" as const,
      workItemId: claimed.id,
      leaseId: claimed.leaseId,
      workerId: claimed.workerId,
      fencingEpoch: 0
    }
  };
}

describe("runAdvisorConsultation", () => {
  it("calls the advisor without tools and returns guidance to the executor", async () => {
    const { directory, store, claimed } = claimedStore();
    const seen: AdvisorModelRequest[] = [];
    const caller: AdvisorModelCaller = {
      async complete(request) {
        seen.push(request);
        return {
          text: JSON.stringify({ disposition: "reviewed", guidance: "GUIDANCE-keep-the-diff-small" }),
          inputTokens: 8,
          outputTokens: 9
        };
      }
    };
    const readFlight: AdvisorFlightReader = () => ({
      verdict: "verified",
      events: [{ seq: 1, kind: "note", body: { token: "super-secret", summary: "kept" } }]
    });
    try {
      const result = await runAdvisorConsultation({
        store,
        caller,
        readFlight,
        request: requestFor(claimed)
      });
      expect(result).toMatchObject({
        disposition: "reviewed",
        guidance: "GUIDANCE-keep-the-diff-small",
        checkpoint: "before_approach"
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty("tools");
      expect(seen[0]?.user).not.toContain("super-secret");
      expect(seen[0]?.user).toContain("[redacted]");
      const audit = JSON.stringify(
        store.readEvents().filter((event) => event.name === "advisory.advisor_consultation_recorded")
      );
      expect(audit).not.toContain("GUIDANCE-keep-the-diff-small");
      expect(audit).not.toContain("super-secret");
      expect(store.get(claimed.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not call the model for a tampered flight, a caller transcript, or a stale lease", async () => {
    const { directory, store, claimed } = claimedStore();
    let calls = 0;
    const caller: AdvisorModelCaller = {
      async complete() {
        calls += 1;
        return JSON.stringify({ disposition: "reviewed", guidance: "should not be stored" });
      }
    };
    try {
      const tampered = await runAdvisorConsultation({
        store,
        caller,
        readFlight: () => ({ verdict: "tampered", events: [{ seq: 1, kind: "note", body: { secret: "x" } }] }),
        request: requestFor(claimed)
      });
      expect(tampered).toMatchObject({
        disposition: "unavailable",
        guidance: null,
        errorCode: "advisor_flight_unverified"
      });
      await expect(
        runAdvisorConsultation({
          store,
          caller,
          readFlight: () => ({ verdict: "verified", events: [] }),
          request: { ...requestFor(claimed), transcript: "caller transcript", advisorModelId: "claude-opus-5-5" }
        })
      ).rejects.toThrow();
      await expect(
        runAdvisorConsultation({
          store,
          caller,
          readFlight: () => ({ verdict: "verified", events: [] }),
          request: {
            checkpoint: "before_approach",
            subject: { ...requestFor(claimed).subject, workerId: "worker-b" }
          }
        })
      ).rejects.toMatchObject({ code: "advisor_lease_stale" });
      expect(calls).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exposes consult_advisor through MCP and rejects a caller transcript", async () => {
    const { directory, store, claimed } = claimedStore();
    const caller: AdvisorModelCaller = {
      async complete(request) {
        expect(request).not.toHaveProperty("tools");
        return JSON.stringify({ disposition: "declined", declineReason: "DECLINE-need-a-smaller-diff" });
      }
    };
    const tools = {} as Parameters<typeof handleMcpHttpRequest>[0]["tools"];
    try {
      const ok = await handleMcpHttpRequest({
        body: {
          jsonrpc: "2.0",
          id: "consult",
          method: "tools/call",
          params: { name: "consult_advisor", arguments: requestFor(claimed) }
        },
        headers: { authorization: "Bearer mcp-token" },
        tools,
        store,
        auth: { localBearerToken: "mcp-token" },
        resolveActorId: () => "actor_system_bootstrap",
        advisor: { caller, readFlight: () => ({ verdict: "verified", events: [] }) }
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toMatchObject({
        result: {
          structuredContent: {
            disposition: "declined",
            declineReason: "DECLINE-need-a-smaller-diff",
            guidance: null
          }
        }
      });
      const rejected = await handleMcpHttpRequest({
        body: {
          jsonrpc: "2.0",
          id: "transcript",
          method: "tools/call",
          params: {
            name: "consult_advisor",
            arguments: { ...requestFor(claimed), transcript: stableHash({ leaked: true }) }
          }
        },
        headers: { authorization: "Bearer mcp-token" },
        tools,
        store,
        auth: { localBearerToken: "mcp-token" },
        resolveActorId: () => "actor_system_bootstrap",
        advisor: { caller, readFlight: () => ({ verdict: "verified", events: [] }) }
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
