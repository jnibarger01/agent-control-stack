// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { EventSourceLike } from "./stream";
import { overviewFixture, queueFixture } from "../test/fixture";

/** Connected, but no event ever arrives: only the passage of time can change agent staleness, SLA or lease expiry. */
const quiet = (): EventSourceLike => ({ addEventListener: (type, cb) => { if (type === "open") queueMicrotask(() => cb(new MessageEvent("open"))); }, close: () => undefined });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("time-derived freshness on a quiet system", () => {
  it("refetches reads on a bounded interval even when the stream sends no event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes("/queue") ? queueFixture() : overviewFixture();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/queue"]}><App streamFactory={quiet} /></MemoryRouter>
      </QueryClientProvider>
    );
    await screen.findByRole("table", { name: "Work items" });
    const queueReads = () => urls.filter((u) => u.includes("/queue")).length;
    const before = queueReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(queueReads()).toBeGreaterThan(before);
  });

  it("refetches on window focus once the data is older than the refresh interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes("/queue") ? queueFixture() : overviewFixture();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/queue"]}><App streamFactory={quiet} /></MemoryRouter>
      </QueryClientProvider>
    );
    await screen.findByRole("table", { name: "Work items" });
    const queueReads = () => urls.filter((u) => u.includes("/queue")).length;
    const before = queueReads();
    // Jump the clock without running the interval timer, as when a background tab is throttled.
    vi.setSystemTime(Date.now() + 61_000);
    focusManager.setFocused(false);
    await act(async () => { focusManager.setFocused(true); await vi.advanceTimersByTimeAsync(10); });
    focusManager.setFocused(undefined);
    expect(queueReads()).toBeGreaterThan(before);
  });
});
