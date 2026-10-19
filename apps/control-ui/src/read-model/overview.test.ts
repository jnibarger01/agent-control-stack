import { describe, expect, it } from "vitest";
import { parseOverviewReadModel } from "@agent-control-stack/mission-control-contract";
import type { ExecutionAttempt, WorkItem } from "@agent-control-stack/work-items";
import type { MissionControlAgent, MissionControlAttemptLease, MissionControlViewModel } from "../types.js";
import { toOverviewReadModel } from "./overview.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const hash = "a".repeat(64);

function item(id: string, status: WorkItem["status"], extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    requester: "user",
    status,
    intent: "Do the thing",
    target: { cwd: "/home/secret-user/private/repo", files: ["/etc/shadow"], repo: "repo" },
    requestedActions: [{ kind: "fs.read", description: "read", params: { apiKey: "sk-abcdefghijklmnop1234" } }],
    risk: "low",
    metadata: { correlationId: "corr-1" },
    result: { stdout: "TOKEN=supersecretvalue" },
    createdAt: "2026-10-19T11:00:00.000Z",
    updatedAt: "2026-10-19T11:30:00.000Z",
    ...extra
  } as WorkItem;
}

function lease(over: Partial<MissionControlAttemptLease> & { leaseId: string; workItemId: string }): MissionControlAttemptLease {
  return {
    attemptId: "att-1",
    admissionId: "adm-1",
    workerId: "agent-a",
    planHash: hash,
    inputHash: hash,
    fencingEpoch: 1,
    protocolVersion: "1",
    policyVersion: "p1",
    policyDecisionHash: hash,
    issuedAt: "2026-10-19T11:55:00.000Z",
    lastRenewedAt: "2026-10-19T11:55:00.000Z",
    expiresAt: "2026-10-19T12:30:00.000Z",
    maxExpiresAt: "2026-10-19T13:00:00.000Z",
    status: "active",
    ...over,
    // Deliberately smuggled in to prove the mapper never forwards it.
    ...({ tokenHash: "deadbeef".repeat(8) } as object)
  } as MissionControlAttemptLease;
}

function agent(id: string, over: Partial<MissionControlAgent> = {}): MissionControlAgent {
  return { id, displayName: id, kind: "coding", status: "online", health: "healthy", capabilities: ["code"], metadata: { endpoint: "http://10.0.0.5:9000/?token=abc" }, ...over };
}

function model(over: Partial<MissionControlViewModel> = {}): MissionControlViewModel {
  return {
    workItems: [item("w1", "running"), item("w2", "needs_approval"), item("w3", "succeeded")],
    events: [{ sequence: 7, id: "e7", name: "work_item.created", timeUnixNano: "1792411200000000000", attributes: { actor: "u", apiToken: "xyz" }, body: {}, previousHash: "", eventHash: "" }],
    agents: [agent("agent-a"), agent("agent-b", { status: "stale", currentWorkItemId: "w1" })],
    attemptLeasesByWorkItem: { w1: [lease({ leaseId: "l1", workItemId: "w1" })] },
    executionAttemptsByWorkItem: { w1: [{ attemptId: "att-1", workItemId: "w1", planId: "p", planHash: hash, attemptNumber: 1, protocolVersion: "1", inputHash: hash, status: "running", currentFencingEpoch: 1, claimedByWorkerId: "agent-a", createdAt: "x", updatedAt: "x" } as unknown as ExecutionAttempt] },
    executionMode: "strict",
    executionBackend: "dry_run",
    statusCounts: { running: 1, needs_approval: 1, succeeded: 40 },
    now: NOW,
    ...over
  };
}

describe("toOverviewReadModel", () => {
  it("produces output that satisfies the shared contract (round trip)", () => {
    const parsed = parseOverviewReadModel(JSON.parse(JSON.stringify(toOverviewReadModel(model()))));
    expect(parsed.ok).toBe(true);
  });

  it("never emits secrets, host paths, token hashes, params, results or endpoints", () => {
    const json = JSON.stringify(toOverviewReadModel(model()));
    for (const forbidden of ["deadbeef", "tokenHash", "/home/secret-user", "/etc/shadow", "sk-abcdefghijklmnop", "supersecretvalue", "apiKey", "10.0.0.5", "xyz", "cwd", "stdout"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("redacts secret-looking text in titles", () => {
    const out = toOverviewReadModel(model({ workItems: [item("w1", "running", { title: "use Bearer abc.def.ghi-123 now" })] }));
    expect(JSON.stringify(out)).not.toContain("abc.def.ghi-123");
  });

  it("uses exact store counts and labels their source", () => {
    const out = toOverviewReadModel(model());
    const succeeded = out.pipeline.stages.find((s) => s.key === "succeeded");
    expect(succeeded).toMatchObject({ count: 40, countSource: "store" });
    expect(succeeded?.items).toHaveLength(1);
    expect(out.needsYou.approvals).toBe(1);
  });

  it("falls back to window counts when store counts are absent", () => {
    const out = toOverviewReadModel(model({ statusCounts: undefined }));
    expect(out.pipeline.stages.find((s) => s.key === "succeeded")).toMatchObject({ count: 1, countSource: "window" });
  });

  it("draws edges only from canonical bindings", () => {
    const out = toOverviewReadModel(model());
    expect(out.network.edges).toEqual([
      { from: "agent:agent-a", to: "work:w1", kind: "active_lease", fencingEpoch: 1 },
      { from: "agent:agent-b", to: "work:w1", kind: "reported_task" }
    ]);
    // agent-a and agent-b have no other edges; w2/w3 have no binding so no node.
    expect(out.network.nodes.some((n) => n.id === "work:w2")).toBe(false);
  });

  it("treats only the highest-epoch active lease as current ownership", () => {
    const out = toOverviewReadModel(
      model({
        agents: [agent("old"), agent("new")],
        attemptLeasesByWorkItem: {
          w1: [lease({ leaseId: "l-old", workItemId: "w1", workerId: "old", fencingEpoch: 1 }), lease({ leaseId: "l-new", workItemId: "w1", workerId: "new", fencingEpoch: 2 })]
        }
      })
    );
    expect(out.network.edges.map((e) => e.from)).toEqual(["agent:new"]);
  });

  it("adds an unknown-liveness node for a lease worker missing from the registry", () => {
    const out = toOverviewReadModel(model({ agents: [], attemptLeasesByWorkItem: { w1: [lease({ leaseId: "l1", workItemId: "w1", workerId: "ghost" })] } }));
    expect(out.network.nodes.find((n) => n.id === "agent:ghost")).toMatchObject({ liveness: "unknown" });
  });

  it("never reports online for an agent whose status is not provable", () => {
    const out = toOverviewReadModel(model({ agents: [agent("x", { status: "weird" as never })] }));
    expect(out.network.nodes.find((n) => n.id === "agent:x")?.liveness).toBe("unknown");
  });

  it("flags only active, soon-to-expire leases", () => {
    const soon = lease({ leaseId: "soon", workItemId: "w1", expiresAt: "2026-10-19T12:00:30.000Z" });
    const expired = lease({ leaseId: "gone", workItemId: "w1", expiresAt: "2026-10-19T11:00:00.000Z" });
    const closed = lease({ leaseId: "closed", workItemId: "w1", expiresAt: "2026-10-19T12:00:30.000Z", status: "consumed" });
    const out = toOverviewReadModel(model({ attemptLeasesByWorkItem: { w1: [soon, expired, closed] } }));
    expect(out.needsYou.expiringLeases.map((l) => l.leaseId)).toEqual(["soon"]);
  });

  it("marks missing sections unavailable instead of empty-ok", () => {
    const out = toOverviewReadModel(model({ events: undefined, readiness: undefined, executionTelemetry: undefined, infrastructure: undefined }));
    expect(out.sections.activity).toEqual({ status: "unavailable", reason: "events_absent" });
    expect(out.sections.readiness).toEqual({ status: "unavailable", reason: "readiness_absent" });
    expect(out.sections.observability).toEqual({ status: "unavailable", reason: "telemetry_absent" });
    expect(out.readiness).toBeNull();
  });

  it("reports dry-run only when the backend is dry_run, unknown when absent", () => {
    expect(toOverviewReadModel(model()).execution.dryRun).toBe("yes");
    expect(toOverviewReadModel(model({ executionBackend: "desktop_commander" })).execution.dryRun).toBe("no");
    expect(toOverviewReadModel(model({ executionBackend: undefined })).execution.dryRun).toBe("unknown");
    expect(toOverviewReadModel(model({ executionMode: undefined, executionModeProblem: "corrupt" })).execution).toMatchObject({ mode: "unknown", modeProblem: "corrupt" });
  });

  it("converts audit timestamps and reports the highest sequence", () => {
    const out = toOverviewReadModel(model());
    expect(out.eventSequence).toBe(7);
    expect(out.activity[0]?.at).toBe("2026-10-19T12:00:00.000Z");
    expect(out.activity[0]?.summary).not.toContain("xyz");
  });
});

describe("parseOverviewReadModel fail-closed", () => {
  it("rejects unexpected fields, wrong versions and garbage", () => {
    const good = toOverviewReadModel(model());
    expect(parseOverviewReadModel({ ...good, leaked: "secret" }).ok).toBe(false);
    expect(parseOverviewReadModel({ ...good, schemaVersion: 2 }).ok).toBe(false);
    expect(parseOverviewReadModel(null).ok).toBe(false);
    expect(parseOverviewReadModel("<html>").ok).toBe(false);
  });
});
