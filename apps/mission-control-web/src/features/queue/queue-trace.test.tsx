// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import type { EventSourceLike } from "../../data/stream";
import { overviewFixture, queueFixture, traceFixture } from "../../test/fixture";
import { filterQueue } from "./QueuePage";

const idle = (): EventSourceLike => ({ addEventListener: () => undefined, close: () => undefined });

function mountAt(path: string, routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      const { status = 200, body } = hit?.[1] ?? { status: 500, body: {} };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App streamFactory={idle} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const overview = { body: overviewFixture() };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Work queue", () => {
  it("lists real items with honest plan state and links to the trace", async () => {
    mountAt("/queue", { "/queue": { body: queueFixture() }, "/overview": overview });
    const table = await screen.findByRole("table", { name: "Work items" });
    expect(within(table).getByRole("link", { name: "Inspect queue latency" }).getAttribute("href")).toBe("/queue/wrk_run00000001");
    expect(within(table).getByText("Plan not admitted")).toBeTruthy();
    expect(within(table).getByText("Plan unknown")).toBeTruthy();
    expect(within(table).getByText(/epoch 2 · agent-a/)).toBeTruthy();
    expect(screen.getByText(/exact/)).toBeTruthy();
  });

  it("filters by status chip and search, and says so when nothing matches", async () => {
    mountAt("/queue", { "/queue": { body: queueFixture() }, "/overview": overview });
    await screen.findByRole("table", { name: "Work items" });
    fireEvent.click(screen.getByRole("button", { name: /needs approval/ }));
    expect(screen.getByText(/Showing 1 of 3 loaded/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search loaded items"), { target: { value: "zzz-nothing" } });
    expect(await screen.findByText("No loaded item matches these filters")).toBeTruthy();
  });

  it("filterQueue combines status, risk and text", () => {
    const items = queueFixture().items;
    expect(filterQueue(items, { status: "", risk: "high", q: "" }).map((i) => i.id)).toEqual(["wrk_appr0000002"]);
    expect(filterQueue(items, { status: "running", risk: "", q: "LATENCY" })).toHaveLength(1);
    expect(filterQueue(items, { status: "", risk: "", q: "wrk_done" })).toHaveLength(1);
  });

  it("shows an empty state, not a blank table, with no items", async () => {
    mountAt("/queue", { "/queue": { body: queueFixture({ items: [], counts: { source: "window", byStatus: {} }, finishedWindow: undefined }) }, "/overview": overview });
    expect(await screen.findByText("No work items yet")).toBeTruthy();
  });

  it("fails closed on an invalid queue response", async () => {
    mountAt("/queue", { "/queue": { body: { ...queueFixture(), secret: "x" } }, "/overview": overview });
    expect(await screen.findByText(/Work queue unavailable/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Execution trace", () => {
  const open = () => mountAt("/queue/wrk_run00000001", { "/trace": { body: traceFixture() }, "/overview": overview });

  it("renders the stages in order and flags derived ones", async () => {
    open();
    const list = await screen.findByRole("list", { name: "Execution trace stages" });
    const labels = within(list).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(labels).toEqual(["Request", "Policy decision", "Execution plan", "Admission", "Human approval", "Execution attempt", "Lease and fencing", "Result"]);
    expect(within(list).getAllByText("derived from audit")).toHaveLength(2);
  });

  it("marks a lower-epoch active lease as superseded, never as current ownership", async () => {
    open();
    const leases = await screen.findByRole("list", { name: /Leases for attempt 1/ });
    const old = within(leases).getByText(/Epoch 1 · agent-old/).closest("li")!;
    expect(within(old).getByText("superseded")).toBeTruthy();
    const current = within(leases).getByText(/Epoch 2 · agent-a/).closest("li")!;
    expect(within(current).queryByText("superseded")).toBeNull();
  });

  it("says 'Plan not admitted' when there is a plan but no admission", async () => {
    mountAt("/queue/wrk_run00000001", { "/trace": { body: traceFixture({ admission: null }) }, "/overview": overview });
    await screen.findByRole("list", { name: "Execution trace stages" });
    expect(screen.getByText("Plan not admitted")).toBeTruthy();
  });

  it("does not show the allowed command list, only a count", async () => {
    open();
    await screen.findByRole("list", { name: "Execution trace stages" });
    expect(screen.getByText(/2 \(not shown\)/)).toBeTruthy();
  });

  it("shows 'not found' for a missing work item and 'unavailable' for an invalid trace", async () => {
    mountAt("/queue/nope", { "/trace": { status: 404, body: { error: "work item not found" } }, "/overview": overview });
    expect(await screen.findByText(/Work item not found/)).toBeTruthy();
    cleanup();
    mountAt("/queue/x", { "/trace": { body: { ...traceFixture(), extra: 1 } }, "/overview": overview });
    expect(await screen.findByText(/Work item unavailable/)).toBeTruthy();
  });
});
