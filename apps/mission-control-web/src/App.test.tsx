// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { EventSourceLike } from "./data/stream";
import { overviewFixture } from "./test/fixture";

const idle = (): EventSourceLike => ({ addEventListener: () => undefined, close: () => undefined });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App streamFactory={idle} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

describe("App fail-closed behaviour", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders the Command overview from a valid response", async () => {
    respond(200, overviewFixture());
    mount();
    await screen.findByRole("heading", { name: "Needs you" });
    expect(screen.getAllByText("Review deployment request").length).toBeGreaterThan(0);
    expect(screen.getByText("Dry run, simulated")).toBeTruthy();
    expect(screen.getByText("Strict mode")).toBeTruthy();
  });

  it("shows sign-in, never data, on 401", async () => {
    respond(401, { error: "unauthorized" });
    mount();
    await screen.findByRole("heading", { name: "Sign in required" });
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  it("shows 'unavailable' for a response that violates the contract (extra field)", async () => {
    respond(200, { ...overviewFixture(), leakedToken: "secret" });
    mount();
    await screen.findByText(/Mission Control data unavailable/);
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(document.body.textContent).not.toContain("secret");
  });

  it("shows 'unavailable' on server errors", { timeout: 10000 }, async () => {
    respond(500, { error: "boom" });
    mount();
    // Transient server errors are retried with backoff before giving up.
    await screen.findByText(/Mission Control data unavailable/, undefined, { timeout: 6000 });
  });

  it("renders an unavailable section as 'unavailable', not as an empty list", async () => {
    respond(200, overviewFixture({ sections: { ...overviewFixture().sections, activity: { status: "unavailable", reason: "events_absent" } }, activity: [] }));
    mount();
    const card = (await screen.findByRole("heading", { name: "Live activity" })).closest("section")!;
    expect(within(card).getByText(/unavailable/i)).toBeTruthy();
    expect(within(card).queryByText("No audit events yet")).toBeNull();
  });

  it("never claims online for an agent with unknown liveness; shows 'unknown' instead of a number when infrastructure is absent", async () => {
    respond(200, overviewFixture({ infrastructure: null, observability: { telemetry: null, admission: null }, sections: { ...overviewFixture().sections, observability: { status: "unavailable", reason: "telemetry_absent" } } }));
    mount();
    await screen.findByRole("heading", { name: "Needs you" });
    await waitFor(() => expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(3));
    expect(screen.getByRole("button", { name: /Idle reviewer, agent, Unknown/ })).toBeTruthy();
  });
});
