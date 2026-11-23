// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import type { EventSourceLike } from "../../data/stream";

const idle = (): EventSourceLike => ({ addEventListener: () => undefined, close: () => undefined });
const SECRET = "ghp_" + "Q".repeat(36);

function view(overrides: Record<string, unknown> = {}) {
  return {
    missionId: "factory-" + "a".repeat(48),
    repository: "jnibarger01/agent-control-stack",
    pinnedBaseSha: "b".repeat(40),
    missionState: "PLANNING",
    stage: "verified_awaiting_publication",
    plan: { revision: 2, planDigest: "c".repeat(64), accepted: true },
    units: [
      { unitId: "a", status: "succeeded", failureCategory: null, resultHash: "d".repeat(64) },
      { unitId: "b", status: "succeeded", failureCategory: null, resultHash: "e".repeat(64) }
    ],
    budget: { limits: { parallel_work_units: 2, wall_clock_ms: 1_200_000 }, usage: {} },
    failedGate: null,
    publication: { state: "none", url: null },
    nextAction: { recommendation: "Approve publication of the verified head as a draft pull request.", authority: "advisory", requiresHumanApproval: true },
    ...overrides
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/factory"]}>
        <App streamFactory={idle} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

describe("F10 AI Factory backlog page", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders stage, pinned base, budget, evidence and an explicitly advisory next step in an accessible table", async () => {
    respond(200, { missions: [view()] });
    mount();
    const table = await screen.findByRole("table", { name: "AI Factory backlog" });
    const t = within(table);
    expect(t.getByText("Verified, awaiting publication")).toBeTruthy();
    expect(t.getByText("bbbbbbbbbbbb")).toBeTruthy();
    expect(t.getByText("2 parallel · 20 min wall clock")).toBeTruthy();
    expect(t.getByText("2/2 units verified")).toBeTruthy();
    expect(t.getByText(/Recommendation only · needs a human decision/u)).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toContain("Recommended next step");
  });

  it("shows Unknown for an unknown stage instead of guessing", async () => {
    respond(200, { missions: [view({ stage: "unknown" })] });
    mount();
    expect(await screen.findByText("Unknown")).toBeTruthy();
  });

  it("renders nothing from a response that does not match the contract (invented stage or extra fields)", async () => {
    respond(200, { missions: [view({ stage: "merged" })] });
    mount();
    expect(await screen.findByText(/failed contract validation|could not|unavailable/iu)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "AI Factory backlog" })).toBeNull();
    cleanup();
    respond(200, { missions: [view({ objective: "leak " + SECRET })] });
    mount();
    await screen.findByText(/failed contract validation|could not|unavailable/iu);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("shows sign-in, never data, on 401", async () => {
    respond(401, { error: "unauthorized" });
    mount();
    expect(await screen.findByRole("heading", { name: "Sign in required" })).toBeTruthy();
  });
});
