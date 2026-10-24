// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { EventSourceLike } from "../data/stream";
import { overviewFixture, queueFixture } from "../test/fixture";

/** A stream that stays connected, so the shell keeps saying "Live" throughout. */
const live = (): EventSourceLike => ({ addEventListener: (type, cb) => { if (type === "open") queueMicrotask(() => cb(new MessageEvent("open"))); }, close: () => undefined });

function mountAt(path: string) {
  let failing = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (failing) return new Response("{}", { status: 500 });
      const body = url.includes("/queue") ? queueFixture() : overviewFixture();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App streamFactory={live} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return {
    failRefetches: async () => {
      failing = true;
      await act(async () => { await client.refetchQueries(); });
    }
  };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("cached data after a failed refetch", () => {
  it("the queue keeps its last data but says it may be out of date", async () => {
    const { failRefetches } = mountAt("/queue");
    await screen.findByRole("table", { name: "Work items" });
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    await failRefetches();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Work queue may be out of date\. The latest refresh failed/);
    expect(screen.getByRole("table", { name: "Work items" })).toBeTruthy();
  });

  it("the command overview warns too, even while the stream is live", async () => {
    const { failRefetches } = mountAt("/");
    await screen.findByText("Live");
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    await failRefetches();
    expect((await screen.findAllByRole("alert")).some((a) => /Mission Control data may be out of date/.test(a.textContent ?? ""))).toBe(true);
  });
});
