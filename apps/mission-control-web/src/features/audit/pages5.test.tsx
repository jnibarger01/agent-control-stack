// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditReadModel } from "@agent-control-stack/mission-control-contract";
import { App } from "../../App";
import type { EventSourceLike } from "../../data/stream";
import { overviewFixture } from "../../test/fixture";
import { PolicyPage } from "../policy/PolicyPage";

const idle = (): EventSourceLike => ({ addEventListener: () => undefined, close: () => undefined });
const ev = (sequence: number, name: string, over: Partial<AuditEvent> = {}): AuditEvent => ({ sequence, id: `e${sequence}`, name, at: "2026-10-19T12:00:00.000Z", attributes: {}, eventHash: "h".repeat(8), previousHash: "p".repeat(8), ...over });
const model = (events: AuditEvent[], nextBefore: number | null): AuditReadModel => ({ schemaVersion: 1, generatedAt: "2026-10-19T12:00:00.000Z", events, nextBefore });

function mountAudit(handler: (url: string) => unknown) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    const body = url.includes("/audit") ? handler(url) : overviewFixture();
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/audit"]}><App streamFactory={idle} /></MemoryRouter></QueryClientProvider>);
  return urls;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Audit page", () => {
  it("lists events newest first, opens a redacted detail, and says the data is bounded", async () => {
    mountAudit(() => model([ev(5, "work_item.created", { attributes: { "work_item.id": "wrk_1", apiToken: "[redacted]" } }), ev(4, "agent.heartbeat")], null));
    const table = await screen.findByRole("table", { name: "Audit events, newest first" });
    expect(within(table).getAllByRole("button").map((b) => b.textContent)).toEqual(["work_item.created", "agent.heartbeat"]);
    fireEvent.click(within(table).getByRole("button", { name: "Inspect event 5, work_item.created" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Attributes (redacted)")).toBeTruthy();
    expect(within(dialog).getByText("[redacted]")).toBeTruthy();
    expect(screen.getByText(/Start of the retained log reached/)).toBeTruthy();
  });

  it("sends name and work-item filters to the server instead of only filtering what is loaded", async () => {
    const urls = mountAudit(() => model([ev(5, "policy.decided")], null));
    await screen.findByRole("table", { name: "Audit events, newest first" });
    fireEvent.change(screen.getByLabelText("Event name (exact)"), { target: { value: "policy.decided" } });
    await waitFor(() => expect(urls.some((u) => u.includes("name=policy.decided"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Work item identifier"), { target: { value: "wrk_9" } });
    await waitFor(() => expect(urls.some((u) => u.includes("workItemId=wrk_9"))).toBe(true));
  });

  it("loads older events with beforeSequence and never duplicates a row", async () => {
    const urls = mountAudit((url) => (url.includes("beforeSequence=4") ? model([ev(4, "b"), ev(3, "a")], null) : model([ev(5, "c"), ev(4, "b")], 4)));
    const table = await screen.findByRole("table", { name: "Audit events, newest first" });
    expect(within(table).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Audit events, newest first" })).getAllByRole("button")).toHaveLength(3));
    expect(urls.some((u) => u.includes("beforeSequence=4"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
  });

  it("searches only the loaded events and says so when none match", async () => {
    mountAudit(() => model([ev(5, "work_item.created")], null));
    await screen.findByRole("table", { name: "Audit events, newest first" });
    fireEvent.change(screen.getByLabelText("Search loaded events"), { target: { value: "zzz" } });
    expect(await screen.findByText("No loaded event matches the search")).toBeTruthy();
  });

  it("fails closed on an invalid audit response", async () => {
    mountAudit(() => ({ ...model([], null), leaked: "x" }));
    expect(await screen.findByText(/Audit log unavailable/)).toBeTruthy();
  });
});

describe("Policy page", () => {
  const decision = (seq: number, decision: string, reason?: string): AuditEvent => ev(seq, "policy.decided", { attributes: { "work_item.id": "wrk_1", "action.hash": "a".repeat(64) }, policy: { decision, ...(reason ? { reason } : {}), matchedRules: ["approval:risk"] } });

  it("summarises recorded decisions and states that it is read-only", () => {
    render(<MemoryRouter><PolicyPage events={[decision(3, "allow"), decision(2, "require_approval", "high risk work requires approval"), decision(1, "deny"), ev(9, "work_item.created")]} /></MemoryRouter>);
    expect(screen.getByText(/Policy rules cannot be edited here/)).toBeTruthy();
    expect(screen.getByText("high risk work requires approval")).toBeTruthy();
    expect(screen.getByText("Decisions loaded").closest("div")?.textContent).toContain("3"); // the non-policy event is not counted
  });

  it("shows 'none recorded' for a missing reason instead of inventing one, and an empty state with no decisions", () => {
    render(<MemoryRouter><PolicyPage events={[decision(1, "allow")]} /></MemoryRouter>);
    expect(screen.getByText("none recorded")).toBeTruthy();
    cleanup();
    render(<MemoryRouter><PolicyPage events={[]} /></MemoryRouter>);
    expect(screen.getByText("No policy decisions recorded yet")).toBeTruthy();
  });
});
