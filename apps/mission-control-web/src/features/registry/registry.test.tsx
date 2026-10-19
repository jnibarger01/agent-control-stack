// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentsList, parseConnectorDetail, parseExecutorDetail } from "@agent-control-stack/mission-control-contract";
import { AgentsPage, ConnectorDetailPage, ConnectorsPage, ExecutorsPage } from "./pages";

afterEach(cleanup);
const wrap = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe("registry contract picks drop everything the UI does not render", () => {
  it("never carries endpoint, lastError, actor ids or input schemas into the model", () => {
    const parsed = parseAgentsList({ agents: [{ id: "a", name: "A", kind: "cli", acpRole: "X", status: "AVAILABLE", effectiveStatus: "AVAILABLE", endpoint: "http://10.0.0.5:9000/?token=abc", lastError: "Bearer abc.def.ghi", createdByActorId: "root", capabilities: [{ name: "code", inputSchema: { secret: "x" } }] }] });
    expect(parsed.ok).toBe(true);
    const json = JSON.stringify(parsed.ok ? parsed.value : {});
    for (const bad of ["10.0.0.5", "abc.def.ghi", "createdByActorId", "inputSchema", "secret"]) expect(json, bad).not.toContain(bad);
  });

  it("drops connector key material and session actor ids", () => {
    const parsed = parseConnectorDetail({ connector: { id: "c", displayName: "C", status: "active", publicKeyPem: "-----BEGIN PUBLIC KEY-----abc", publicKeyFingerprint: "fp", sessionCount: 1, activeSessionCount: 1 }, sessions: [{ sessionId: "s", status: "active", effectiveStatus: "active", actorId: "someone", tokenHash: "deadbeef" }] });
    expect(parsed.ok).toBe(true);
    const json = JSON.stringify(parsed.ok ? parsed.value : {});
    for (const bad of ["BEGIN PUBLIC KEY", "someone", "deadbeef", "publicKeyPem", "tokenHash"]) expect(json, bad).not.toContain(bad);
    expect(parseExecutorDetail({ executor: { id: "e", displayName: "E", kind: "k", configured: false, status: "unconfigured" } }).ok).toBe(true);
  });

  it("rejects structurally invalid responses", () => {
    expect(parseAgentsList({ agents: [{ id: 1 }] }).ok).toBe(false);
    expect(parseAgentsList(null).ok).toBe(false);
  });
});

describe("registry pages", () => {
  const agent = (over: Record<string, unknown>) => ({ id: "x", name: "X", kind: "cli", acpRole: "REVIEW_PLANNING_AGENT", status: "UNKNOWN", effectiveStatus: "UNKNOWN", capabilities: [], ...over }) as never;

  it("shows an agent with no heartbeat evidence as unknown and a stale one as stale, never online", () => {
    wrap(<AgentsPage agents={[agent({ id: "a", name: "Never heard", effectiveStatus: "UNKNOWN" }), agent({ id: "b", name: "Went quiet", effectiveStatus: "AVAILABLE", isStale: true, lastHeartbeatAt: "2026-10-19T10:00:00.000Z" })]} />);
    const table = screen.getByRole("table", { name: "Registered agents" });
    expect(within(table.querySelectorAll("tbody tr")[0] as HTMLElement).getByText("unknown")).toBeTruthy();
    expect(within(table.querySelectorAll("tbody tr")[1] as HTMLElement).getByText("stale")).toBeTruthy();
    expect(within(table).queryByText("online")).toBeNull();
    expect(screen.getByText("No heartbeat evidence")).toBeTruthy();
  });

  it("labels configured executors as configured, not healthy", () => {
    wrap(<ExecutorsPage executors={[{ id: "dc", displayName: "Desktop Commander", kind: "managed_mcp_executor", configured: true, status: "configured", scopes: [], capabilityCount: 3 }]} />);
    expect(screen.getByText(/Configured is not the same as healthy/)).toBeTruthy();
    const row = screen.getByRole("table", { name: "Execution bridges" }).querySelector("tbody tr") as HTMLElement;
    expect(within(row).getAllByText("configured").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^healthy$/i)).toBeNull();
  });

  it("shows connectors with session counts and only a key fingerprint", () => {
    wrap(<ConnectorsPage connectors={[{ id: "c", displayName: "QA", allowedScopes: ["acs:work:read"], status: "active", sessionCount: 3, activeSessionCount: 1 }]} />);
    expect(screen.getByText("1 active of 3")).toBeTruthy();
    cleanup();
    wrap(<ConnectorDetailPage data={{ connector: { id: "c", displayName: "QA", allowedScopes: ["acs:work:read"], status: "active", publicKeyFingerprint: "abcdef0123456789", sessionCount: 1, activeSessionCount: 0 }, sessions: [{ sessionId: "sess-1", status: "active", effectiveStatus: "inactive", staleReason: "heartbeat_expired" }] }} />);
    expect(screen.getByText(/inactive · heartbeat expired/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("BEGIN PUBLIC KEY");
  });
});
