// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsApiError } from "../api/errors";
import type { WorkItemDetailResponse } from "../api/types";
import { attempt, event, HASH_A, lease, policyDecided, workItem } from "../test-fixtures";
import { queryCache } from "../state/query";
import { button, cleanup, click, flush, openDialog, render, runAxe, selectTab, type as typeInto } from "../test-utils";

const api = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    login: fn(),
    livez: fn(),
    readyz: fn(),
    health: fn(),
    listWorkItems: fn(),
    getWorkItem: fn(),
    createWorkItem: fn(),
    approveWorkItem: fn(),
    rejectWorkItem: fn(),
    cancelWorkItem: fn(),
    unblockWorkItem: fn(),
    retryWorkItem: fn(),
    cloneWorkItem: fn(),
    explainPolicy: fn(),
    listRegistryAgents: fn(),
    getRegistryAgent: fn(),
    listAgentCapabilities: fn(),
    listProjectedActors: fn(),
    listEvents: fn(),
    metricsText: fn(),
    listConnectors: fn(),
    registerConnector: fn(),
    rotateConnectorKey: fn(),
    registerTunnelSession: fn(),
    revokeTunnelSession: fn()
  };
});
vi.mock("../api/endpoints", () => ({ endpoints: api, createEndpoints: () => api }));

const stream = vi.hoisted(() => ({ status: "live" as string, trustworthy: true }));
vi.mock("../components/Shell", () => ({ useStreamTrust: () => stream, Shell: () => null }));

import { AgentsPage } from "./AgentsPage";
import { ApprovalsPage } from "./ApprovalsPage";
import { AuditPage } from "./AuditPage";
import { ConnectorsPage } from "./ConnectorsPage";
import { ExecutionPage } from "./ExecutionPage";
import { MetricsPage } from "./MetricsPage";
import { OverviewPage } from "./OverviewPage";
import { PolicyPage } from "./PolicyPage";
import { SystemPage } from "./SystemPage";
import { WorkPage } from "./WorkPage";

const pendingItem = workItem({ id: "wrk_pending", title: "Update deploy config" });
const blockedItem = workItem({ id: "wrk_blocked", title: "Delete data", status: "blocked", risk: "critical" });
const runningItem = workItem({ id: "wrk_running", title: "Run migration", status: "running", risk: "medium" });
const items = [pendingItem, blockedItem, runningItem];

function detail(item = pendingItem, extra: Partial<WorkItemDetailResponse> = {}): WorkItemDetailResponse {
  return {
    workItem: item,
    events: [policyDecided(item.id, HASH_A, "require_approval")],
    executionAttempts: [],
    attemptLeases: [],
    ...extra
  };
}

const registryAgent = (over: Record<string, unknown>) => ({
  id: "a",
  name: "A",
  kind: "llm",
  acpRole: "LOCAL_CODING_AGENT",
  status: "AVAILABLE",
  effectiveStatus: "AVAILABLE",
  isStale: false,
  heartbeatAgeMs: 1000,
  lastHeartbeatAt: "2026-09-19T10:00:00.000Z",
  capabilities: [],
  createdAt: "2026-09-19T09:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
  ...over
});

beforeEach(() => {
  queryCache.clear();
  stream.status = "live";
  stream.trustworthy = true;
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWorkItems.mockResolvedValue(items);
  api.getWorkItem.mockImplementation(async (id: string) => detail(items.find((i) => i.id === id) ?? pendingItem));
  api.listRegistryAgents.mockResolvedValue([]);
  api.listProjectedActors.mockResolvedValue([]);
  api.listEvents.mockResolvedValue([]);
  api.listConnectors.mockResolvedValue([]);
  api.livez.mockResolvedValue({ ok: true, status: "alive" });
  api.readyz.mockResolvedValue({
    ok: true,
    httpStatus: 200,
    checks: { read: { ok: true }, write: { ok: true }, auditChain: { ok: true }, liveness: { ok: true } }
  });
  api.health.mockResolvedValue({
    ok: true,
    httpStatus: 200,
    checks: { read: { ok: true }, write: { ok: true }, auditChain: { ok: true }, liveness: { ok: true } }
  });
  api.metricsText.mockResolvedValue("");
});
afterEach(cleanup);

describe("Overview shows real state only", () => {
  it("derives every count from the API, with no baked-in fixture values", async () => {
    const { container } = await render(<OverviewPage />);
    const text = container.textContent ?? "";
    const statValue = (label: string) =>
      [...container.querySelectorAll(".stat")].find(
        (card) => card.querySelector(".stat-label")?.textContent === label
      )?.querySelector(".stat-value")?.textContent;
    expect(statValue("Pending approvals")).toBe("1");
    expect(statValue("Blocked")).toBe("1");
    expect(statValue("Running")).toBe("1");
    expect(text).toContain("Update deploy config");
    expect(text).not.toMatch(/analyst|corp-dc|T-33721|WI-1837/i);
  });

  it("empty control plane renders honest empty states, not placeholders", async () => {
    api.listWorkItems.mockResolvedValue([]);
    const { container } = await render(<OverviewPage />);
    expect(container.textContent).toContain("Nothing needs attention");
    expect(container.textContent).toContain("No active executions");
  });

  it("an API failure is shown with its class, with a retry, not a blank page", async () => {
    api.listWorkItems.mockRejectedValue(
      new AcsApiError("forbidden", "insufficient scope", { status: 403, code: "insufficient_gateway_scope" })
    );
    const { container } = await render(<OverviewPage />);
    expect(container.querySelector("[data-error-kind=forbidden]")).not.toBeNull();
    expect(container.textContent).toContain("insufficient_gateway_scope");
  });
});

describe("Work Queue", () => {
  it("applies URL filters and opens the selected record from the URL", async () => {
    const { container } = await render(<WorkPage />, "/console/work/wrk_blocked?status=blocked");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Delete data");
    await flush();
    expect(container.querySelector("[data-testid=work-detail]")?.getAttribute("data-work-item")).toBe("wrk_blocked");
  });

  it("clicking a row navigates to its deep link", async () => {
    const { container } = await render(<WorkPage />, "/console/work");
    await click([...container.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes("Run migration")));
    expect(window.location.pathname).toBe("/console/work/wrk_running");
  });

  it("does not leak the previous selection's data into the next one", async () => {
    const { container } = await render(<WorkPage />, "/console/work/wrk_pending");
    expect(container.querySelector("[data-testid=work-detail]")?.getAttribute("data-work-item")).toBe("wrk_pending");
    await click([...container.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes("Run migration")));
    await flush();
    const shown = container.querySelector("[data-testid=work-detail]");
    expect(shown?.getAttribute("data-work-item")).toBe("wrk_running");
    expect(shown?.textContent).not.toContain("Update deploy config");
  });
});

describe("Approvals", () => {
  it("lists pending items, offers no bulk approval, and opens the hash-bound approve flow", async () => {
    const { container } = await render(<ApprovalsPage />, "/console/approvals/wrk_pending");
    expect(container.textContent).toContain("Update deploy config");
    expect(container.querySelector("input[type=checkbox]")).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => /approve all|bulk/i.test(b.textContent ?? ""))).toBe(
      false
    );
    await flush();
    expect(container.querySelector("[data-testid=action-hash]")?.textContent).toContain(HASH_A);
  });

  it("approve is disabled everywhere while the stream is stale", async () => {
    stream.status = "reconnecting";
    stream.trustworthy = false;
    const { container } = await render(<ApprovalsPage />, "/console/approvals/wrk_pending");
    await flush();
    expect((button(container, "Approve this action") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toMatch(/disabled while the live event stream is disconnected/);
  });
});

describe("Execution never exposes lease secrets", () => {
  it("renders leases from the sanitized projection and strips a token hash even if the gateway sent one", async () => {
    const running = workItem({ id: "wrk_running", status: "running" });
    api.listWorkItems.mockResolvedValue([running]);
    const leaky = {
      ...lease({ workItemId: "wrk_running" }),
      tokenHash: "SECRET-TOKEN-HASH-123",
      token: "SECRET-TOKEN"
    };
    api.getWorkItem.mockResolvedValue({
      workItem: running,
      events: [],
      executionAttempts: [attempt({ workItemId: "wrk_running", status: "running" })],
      attemptLeases: [leaky]
    });
    const { container } = await render(<ExecutionPage />, "/console/execution/wrk_running");
    await flush(5);
    expect(container.querySelector("[data-testid=execution-detail]")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/SECRET-TOKEN/);
    expect(container.textContent).toContain("lease_1");
    expect(container.textContent).toMatch(/never sent to or shown/);
  });
});

describe("Agents", () => {
  it("never calls an agent online just because it is registered", async () => {
    api.listRegistryAgents.mockResolvedValue([
      registryAgent({ id: "fresh", name: "Fresh" }),
      registryAgent({
        id: "never",
        name: "Never",
        lastHeartbeatAt: undefined,
        effectiveStatus: "UNKNOWN",
        status: "UNKNOWN"
      }),
      registryAgent({ id: "old", name: "Old", isStale: true, effectiveStatus: "OFFLINE", status: "AVAILABLE" })
    ]);
    const { container } = await render(<AgentsPage />, "/console/agents");
    const rowText = (name: string) =>
      [...container.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes(name))?.textContent ?? "";
    expect(rowText("Fresh")).toContain("Online");
    expect(rowText("Never")).not.toContain("Online");
    expect(rowText("Never")).toContain("Unknown");
    expect(rowText("Old")).toContain("Offline");
    expect(container.textContent).toMatch(/Online\s*1/);
  });
});

describe("Connectors: destructive actions confirm first", () => {
  const ledger = [
    event(
      "connector.registered",
      { "connector.id": "c1" },
      {
        connectorId: "c1",
        displayName: "Corp DC 1",
        allowedScopes: ["acs:work:read"],
        publicKeyFingerprint: "fp1",
        status: "active",
        actorId: "op"
      }
    ),
    event(
      "tunnel_session.registered",
      { "connector.id": "c1" },
      {
        connectorId: "c1",
        tunnelId: "tun-1",
        sessionId: "sess-1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      }
    )
  ];
  const connectorSummary = {
    id: "c1",
    displayName: "Corp DC 1",
    allowedScopes: ["acs:work:read"],
    publicKeyFingerprint: "fp1",
    status: "active" as const,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:05:00.000Z",
    tunnelSessions: [
      {
        connectorId: "c1",
        tunnelId: "tun-1",
        sessionId: "sess-1",
        status: "active" as const,
        issuedAt: "2026-09-19T09:05:00.000Z",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: "2026-09-19T09:05:00.000Z",
        updatedAt: "2026-09-19T09:05:00.000Z"
      }
    ]
  };

  async function openRevoke() {
    api.listEvents.mockResolvedValue(ledger);
    api.listConnectors.mockResolvedValue([connectorSummary]);
    const view = await render(<ConnectorsPage />, "/console/connectors/c1");
    await flush(4);
    await selectTab(view.container, "Tunnel sessions");
    await click(button(view.container, "Revoke"));
    return view;
  }

  it("names the connector, tunnel and session and calls nothing until confirmed", async () => {
    await openRevoke();
    const dialog = openDialog()!;
    expect(dialog.textContent).toContain("c1");
    expect(dialog.textContent).toContain("tun-1");
    expect(dialog.textContent).toContain("sess-1");
    expect(api.revokeTunnelSession).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
    expect(api.revokeTunnelSession).not.toHaveBeenCalled();
  });

  it("confirming sends exactly one revoke request", async () => {
    api.revokeTunnelSession.mockResolvedValue({ session: {} });
    await openRevoke();
    const submit = openDialog()!.querySelector("button[type=submit]") as HTMLButtonElement;
    await click(submit);
    await click(submit);
    await flush();
    expect(api.revokeTunnelSession).toHaveBeenCalledTimes(1);
    expect(api.revokeTunnelSession).toHaveBeenCalledWith("c1", "tun-1", "sess-1");
  });

  it("a backend failure is reported accurately and the dialog stays open", async () => {
    api.revokeTunnelSession.mockRejectedValue(
      new AcsApiError("forbidden", "operator or service role is required", {
        status: 403,
        code: "insufficient_gateway_role"
      })
    );
    await openRevoke();
    await click(openDialog()!.querySelector("button[type=submit]"));
    await flush();
    expect(openDialog()!.textContent).toContain("insufficient_gateway_role");
    expect(document.body.textContent).not.toContain("Revoked session");
  });

  it("key rotation refuses a pasted private key before anything is sent", async () => {
    api.listEvents.mockResolvedValue(ledger);
    api.listConnectors.mockResolvedValue([connectorSummary]);
    const { container } = await render(<ConnectorsPage />, "/console/connectors/c1");
    await flush(4);
    await click(button(container, "Rotate key"));
    const dialog = openDialog()!;
    await typeInto(
      dialog.querySelector("textarea:not([id])"),
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    );
    await typeInto([...dialog.querySelectorAll("textarea")].at(-1), "rotate");
    await click(dialog.querySelector("button[type=submit]"));
    expect(api.rotateConnectorKey).not.toHaveBeenCalled();
    expect(dialog.textContent).toMatch(/private key/i);
  });

  it("controls are disabled while the stream is stale", async () => {
    stream.trustworthy = false;
    api.listEvents.mockResolvedValue(ledger);
    api.listConnectors.mockResolvedValue([connectorSummary]);
    const { container } = await render(<ConnectorsPage />, "/console/connectors/c1");
    await flush(4);
    expect((button(container, "Rotate key") as HTMLButtonElement).disabled).toBe(true);
    await selectTab(container, "Tunnel sessions");
    expect((button(container, "Revoke") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Policy explorer is simulation only", () => {
  async function fill(container: HTMLElement) {
    const required = container.querySelectorAll("form input[aria-required]");
    await typeInto(required[0], "fs.write");
    await typeInto(required[1], "write a file");
  }

  it("submits to /policy/explain only and renders decision, rules, hash and the no-execution notice", async () => {
    api.explainPolicy.mockResolvedValue({
      actionHash: HASH_A,
      decision: "require_approval",
      reason: "high risk work requires approval",
      matchedRules: ["approval:risk"],
      context: {}
    });
    const { container } = await render(<PolicyPage />, "/console/policy");
    await fill(container);
    await click(button(container, "Explain decision"));
    await flush();
    expect(api.explainPolicy).toHaveBeenCalledTimes(1);
    expect(api.explainPolicy.mock.calls[0]![0]).toMatchObject({
      action: { kind: "fs.write", description: "write a file" }
    });
    for (const forbidden of [api.createWorkItem, api.approveWorkItem, api.unblockWorkItem])
      expect(forbidden).not.toHaveBeenCalled();
    const result = container.querySelector("[data-testid=explain-result]")!;
    expect(result.textContent).toContain("Approval required");
    expect(result.textContent).toContain("approval:risk");
    expect(result.textContent).toContain(HASH_A);
    expect(result.textContent).toMatch(/nothing was executed/i);
  });

  it("surfaces a rate limit explicitly", async () => {
    api.explainPolicy.mockRejectedValue(
      new AcsApiError("rate_limited", "rate limit exceeded", {
        status: 429,
        code: "rate_limited",
        retryAfterSeconds: 9
      })
    );
    const { container } = await render(<PolicyPage />, "/console/policy");
    await fill(container);
    await click(button(container, "Explain decision"));
    await flush();
    expect(container.textContent).toMatch(/Rate limited/);
    expect(container.textContent).toContain("retry after 9s");
  });

  it("recent evaluations come from persisted policy.decided events, and rates are computed from them", async () => {
    api.listEvents.mockResolvedValue([
      policyDecided("wrk_1", HASH_A, "allow"),
      policyDecided("wrk_2", HASH_A, "deny"),
      policyDecided("wrk_3", HASH_A, "require_approval"),
      policyDecided("wrk_4", HASH_A, "allow")
    ]);
    const { container } = await render(<PolicyPage />, "/console/policy");
    expect(container.textContent).toMatch(/Allow rate\s*50\.0%/);
    expect(container.textContent).toMatch(/Blocked rate\s*25\.0%/);
    expect(
      container.querySelectorAll("table")[container.querySelectorAll("table").length - 1]!.querySelectorAll("tbody tr")
    ).toHaveLength(4);
  });
});

describe("Audit detail renders untrusted payloads as inert text", () => {
  it("never turns event payload or attributes into markup", async () => {
    const hostile = event(
      "work_item.created",
      { "work_item.id": "wrk_x", "actor.id": "<img src=x onerror=window.__pwned=1>" },
      { reason: "<script>window.__pwned=1</script>", nested: { html: "<b onmouseover=alert(1)>x</b>" } }
    );
    api.listEvents.mockResolvedValue([hostile]);
    const { container } = await render(<AuditPage />, `/console/audit/${hostile.id}`);
    await flush(4);
    const detail = container.querySelector("[data-testid=audit-detail]")!;
    await selectTab(detail as HTMLElement, "Payload");
    expect(detail.querySelector("pre.json")?.textContent).toContain("<script>window.__pwned=1</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("offers Overview / Payload / Related events / Raw JSON tabs", async () => {
    const e = event("approval.granted", { "work_item.id": "wrk_1" }, { reason: "ok" });
    api.listEvents.mockResolvedValue([e, event("work_item.created", { "work_item.id": "wrk_1" })]);
    const { container } = await render(<AuditPage />, `/console/audit/${e.id}`);
    await flush(4);
    expect([...container.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual([
      "Overview",
      "Payload",
      "Related events",
      "Raw JSON"
    ]);
    await selectTab(container, "Related events");
    expect(container.textContent).toContain("work_item.created");
  });

  it("filters by severity", async () => {
    api.listEvents.mockResolvedValue([
      event("work_item.failed"),
      event("work_item.created"),
      event("approval.granted")
    ]);
    const { container } = await render(<AuditPage />, "/console/audit?severity=error");
    await flush(4);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("work_item.failed");
  });
});

describe("System keeps LIVE, READY and HEALTHY distinct", () => {
  const probe = (container: HTMLElement, name: string) => container.querySelector(`[data-testid=probe-${name}]`);

  it("all green", async () => {
    const { container } = await render(<SystemPage />, "/console/system");
    for (const name of ["live", "ready", "healthy"])
      expect(probe(container, name)?.getAttribute("data-state")).toBe("yes");
  });

  it("a failing dependency is LIVE but NOT READY and NOT HEALTHY", async () => {
    const failing = {
      ok: false,
      httpStatus: 503,
      checks: { read: { ok: true }, write: { ok: false, code: "write_failed" }, auditChain: { ok: true } }
    };
    api.readyz.mockResolvedValue(failing);
    api.health.mockResolvedValue(failing);
    const { container } = await render(<SystemPage />, "/console/system");
    expect(probe(container, "live")?.getAttribute("data-state")).toBe("yes");
    expect(probe(container, "ready")?.getAttribute("data-state")).toBe("no");
    expect(probe(container, "healthy")?.getAttribute("data-state")).toBe("no");
    expect(container.textContent).toContain("write_failed");
    expect(container.textContent).toContain("NOT READY");
  });

  it("unreachable probes render UNKNOWN, never Healthy", async () => {
    api.readyz.mockRejectedValue(new AcsApiError("network", "down"));
    api.health.mockRejectedValue(new AcsApiError("network", "down"));
    const { container } = await render(<SystemPage />, "/console/system");
    expect(probe(container, "ready")?.getAttribute("data-state")).toBe("unknown");
    expect(probe(container, "healthy")?.getAttribute("data-state")).toBe("unknown");
    expect(probe(container, "healthy")?.textContent).toContain("UNKNOWN");
    expect(container.textContent).toMatch(/Policy service[\s\S]*UNKNOWN/);
  });

  it("the policy and connector subsystems are UNKNOWN because the gateway exposes no signal", async () => {
    const { container } = await render(<SystemPage />, "/console/system");
    const rows = [...container.querySelectorAll("tbody tr")].filter((r) =>
      /Policy service|Connector subsystem/.test(r.textContent ?? "")
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).toContain("UNKNOWN");
  });
});

describe("Metrics: only real data", () => {
  it("shows values parsed from /metrics and no fabricated history", async () => {
    api.metricsText.mockResolvedValue(
      'acs_http_requests_total{method="GET",route="/x",status="429"} 4\nacs_audit_events_total{event_name="approval.granted"} 7\n'
    );
    const { container } = await render(<MetricsPage />, "/console/metrics");
    await flush(4);
    expect(container.textContent).toMatch(/HTTP 429[^0-9]*4/);
    expect(container.textContent).toMatch(/Approval grants\s*7/);
    expect(container.textContent).toMatch(/Collecting samples/);
    expect(container.querySelectorAll("svg rect")).toHaveLength(0);
  });

  it("an empty exposition renders zeros and 'unknown', not invented numbers", async () => {
    const { container } = await render(<MetricsPage />, "/console/metrics");
    await flush(4);
    expect(container.textContent).toMatch(/Execution success rate\s*—/);
    expect(container.textContent).toMatch(/Avg request latency\s*—/);
  });
});

describe("accessibility (axe: WCAG 2.1 A/AA + best practices)", () => {
  const cases: Array<[string, () => ReactElement, string]> = [
    ["Overview", () => <OverviewPage />, "/console/overview"],
    ["Work Queue with detail", () => <WorkPage />, "/console/work/wrk_pending"],
    ["Approvals with detail", () => <ApprovalsPage />, "/console/approvals/wrk_pending"],
    ["Policy", () => <PolicyPage />, "/console/policy"],
    ["System", () => <SystemPage />, "/console/system"]
  ];
  for (const [name, view, path] of cases) {
    it(name, async () => {
      api.listRegistryAgents.mockResolvedValue([registryAgent({})]);
      const { container } = await render(view(), path);
      await flush(4);
      const violations = await runAxe(container);
      expect(
        violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
      ).toEqual([]);
    });
  }
  it("confirmation dialog", async () => {
    const { container } = await render(<ApprovalsPage />, "/console/approvals/wrk_pending");
    await flush(4);
    await click(button(container, "Approve this action"));
    const violations = await runAxe(openDialog()!);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
