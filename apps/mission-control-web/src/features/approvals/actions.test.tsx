// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import type { EventSourceLike } from "../../data/stream";
import type { ExecutionReadModel } from "@agent-control-stack/mission-control-contract";
import { approvalsFixture, executionFixture, overviewFixture } from "../../test/fixture";

/** A stream that reports `open` immediately (live) or never (connecting). */
const live = (): EventSourceLike => ({ addEventListener: (type, cb) => { if (type === "open") queueMicrotask(() => cb(new MessageEvent("open"))); }, close: () => undefined });
const connecting = (): EventSourceLike => ({ addEventListener: () => undefined, close: () => undefined });

type Post = { url: string; body: Record<string, string> };
function mountAt(path: string, opts: { approvals?: unknown; execution?: unknown; factory?: () => EventSourceLike; postResponse?: () => Response }) {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return opts.postResponse ? opts.postResponse() : new Response("{}", { status: 200 });
      }
      const body = url.includes("/approvals") ? opts.approvals : url.includes("/execution") ? opts.execution : overviewFixture();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App streamFactory={opts.factory ?? live} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { posts };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Approvals", () => {
  it("renders waiting work with SLA, action hash and an honest note when nothing is approvable", async () => {
    mountAt("/approvals", { approvals: approvalsFixture() });
    await screen.findByRole("list", { name: /Work waiting on a human/ });
    expect(screen.getAllByText("over SLA").length).toBeGreaterThan(0);
    expect(screen.getByText(/For example, policy denies approving your own high-risk request/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve fs.write for Review deployment request" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unblock Check connector scopes" })).toBeTruthy();
  });

  it("approves only through a confirm dialog that needs a reason, sends the exact payload, then closes with a notice", async () => {
    const { posts } = mountAt("/approvals", { approvals: approvalsFixture() });
    await screen.findByRole("list", { name: /Work waiting on a human/ });
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve fs.write for Review deployment request" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Approve fs.write for Review deployment request" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })); // safe choice has focus
    const confirm = within(dialog).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no reason yet
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  reviewed the diff  " } });
    expect(confirm.disabled).toBe(false);
    await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm); }); // double click
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ url: "/work-items/wrk_appr0000002/approve", body: { reason: "reviewed the diff", actionHash: "d".repeat(64) } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/approved\./)).toBeTruthy();
  });

  it("Escape dismisses without sending anything", async () => {
    const { posts } = mountAt("/approvals", { approvals: approvalsFixture() });
    await waitFor(() => expect((screen.getByRole("button", { name: "Deny Review deployment request" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Deny Review deployment request" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toHaveLength(0);
  });

  it("shows the gateway's refusal verbatim and keeps the dialog open", async () => {
    const { posts } = mountAt("/approvals", { approvals: approvalsFixture(), postResponse: () => new Response(JSON.stringify({ error: "requester cannot approve its own Desktop Commander operation", code: "approval_self_denied" }), { status: 403 }) });
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve fs.write for Review deployment request" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Approve fs.write for Review deployment request" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "because" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Approve" })); });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("requester cannot approve its own Desktop Commander operation");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(posts).toHaveLength(1);
  });

  it("disables controls with an explanation for a read-only credential", async () => {
    mountAt("/approvals", { approvals: approvalsFixture({ viewer: { canApprove: false, canWrite: false } }) });
    const approve = await screen.findByRole("button", { name: "Approve fs.write for Review deployment request" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/does not have approval permission/).length).toBeGreaterThan(0);
    expect(screen.getByText("Read only")).toBeTruthy();
  });

  it("gates deny on write permission, not approval permission", async () => {
    mountAt("/approvals", { approvals: approvalsFixture({ viewer: { canApprove: true, canWrite: false } }) });
    const deny = await screen.findByRole("button", { name: "Deny Review deployment request" });
    expect((deny as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Approve fs.write for Review deployment request" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Deny for blocked work too, sending it to /reject behind the write gate", async () => {
    const { posts } = mountAt("/approvals", { approvals: approvalsFixture() });
    const deny = await screen.findByRole("button", { name: "Deny Check connector scopes" });
    await waitFor(() => expect((deny as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(deny);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "no longer needed" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Deny" })); });
    expect(posts).toEqual([{ url: "/work-items/wrk_blk00000004/reject", body: { reason: "no longer needed" } }]);
  });

  it("disables blocked-item Deny and Unblock for an approve-only credential", async () => {
    mountAt("/approvals", { approvals: approvalsFixture({ viewer: { canApprove: true, canWrite: false } }) });
    expect(((await screen.findByRole("button", { name: "Deny Check connector scopes" })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Unblock Check connector scopes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables controls while the live stream is not connected", async () => {
    mountAt("/approvals", { approvals: approvalsFixture(), factory: connecting });
    const approve = await screen.findByRole("button", { name: "Approve fs.write for Review deployment request" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Live stream disconnected; controls are disabled/).length).toBeGreaterThan(0);
  });

  it("shows an empty state when nothing is waiting", async () => {
    mountAt("/approvals", { approvals: approvalsFixture({ items: [] }) });
    expect(await screen.findByText("Nothing is waiting on a human")).toBeTruthy();
  });

  it("fails closed on an invalid approvals response", async () => {
    mountAt("/approvals", { approvals: { ...approvalsFixture(), extra: 1 } });
    expect(await screen.findByText(/Approvals unavailable/)).toBeTruthy();
  });
});

describe("Execution", () => {
  it("shows attempts, dry-run banner, and offers retry only for failed and cancel only for in-flight", async () => {
    mountAt("/execution", { execution: executionFixture() });
    const table = await screen.findByRole("table", { name: "Execution attempts" });
    expect(screen.getByText(/Dry run: attempts below are simulated/)).toBeTruthy();
    expect(within(table).getByText("expiring soon · warning only")).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Retry Review policy boundaries" })).toBeTruthy();
    expect(within(table).queryByRole("button", { name: "Retry Inspect queue latency" })).toBeNull();
    expect(within(table).getByRole("button", { name: "Cancel Inspect queue latency" })).toBeTruthy();
    expect(within(table).queryByRole("button", { name: "Cancel Review policy boundaries" })).toBeNull();
  });

  it("offers retry for every retryable work-item status, once per work item on its latest attempt", async () => {
    const row = (attemptId: string, workItemId: string, title: string, workItemStatus: string, status: string, attemptNumber = 1) =>
      ({ attemptId, workItemId, title, workItemStatus, risk: "low", attemptNumber, status, fencingEpoch: 1, updatedAt: "2026-10-19T10:55:00.000Z" }) as ExecutionReadModel["attempts"][number];
    const attempts = [
      row("s1", "wrk_succ0000001", "Succeeded item", "succeeded", "succeeded"),
      row("c1", "wrk_canc0000001", "Cancelled item", "cancelled", "cancelled"),
      row("f1", "wrk_twice000001", "Twice failed", "failed", "failed", 1),
      row("f2", "wrk_twice000001", "Twice failed", "failed", "failed", 2)
    ];
    mountAt("/execution", { execution: executionFixture({ attempts }) });
    const table = await screen.findByRole("table", { name: "Execution attempts" });
    expect(within(table).getByRole("button", { name: "Retry Succeeded item" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Retry Cancelled item" })).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: "Retry Twice failed" })).toHaveLength(1);
  });

  it("retry requires a reason and posts to the existing retry route", async () => {
    const { posts } = mountAt("/execution", { execution: executionFixture() });
    const btn = await screen.findByRole("button", { name: "Retry Review policy boundaries" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("button", { name: "Retry as new item" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "flaky network" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Retry as new item" })); });
    expect(posts).toEqual([{ url: "/work-items/wrk_fail0000005/retry", body: { reason: "flaky network" } }]);
  });

  it("labels an unknown backend instead of claiming real or simulated", async () => {
    mountAt("/execution", { execution: executionFixture({ dryRun: "unknown" }) });
    expect(await screen.findByText(/execution backend is unknown/)).toBeTruthy();
  });

  it("disables write controls for a credential without write permission", async () => {
    mountAt("/execution", { execution: executionFixture({ viewer: { canApprove: false, canWrite: false } }) });
    const retry = await screen.findByRole("button", { name: "Retry Review policy boundaries" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("action safety (security review findings)", () => {
  it("closes immediately after success and never waits on the refetch (no second-submit window)", async () => {
    let approvalsCalls = 0;
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") { posts.push(url); return new Response(JSON.stringify({ workItem: { status: "approved" } }), { status: 200 }); }
        if (url.includes("/approvals")) {
          approvalsCalls += 1;
          if (approvalsCalls > 1) return new Promise<Response>(() => undefined); // refetch hangs forever
          return new Response(JSON.stringify(approvalsFixture()), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(overviewFixture()), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/approvals"]}><App streamFactory={live} /></MemoryRouter></QueryClientProvider>);
    const btn = await screen.findByRole("button", { name: "Approve fs.write for Review deployment request" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "ok" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Approve" })); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); // closed although the refetch never returns
    expect(posts).toHaveLength(1);
  });

  it("does not claim 'approved' when the item still needs more approvals", async () => {
    mountAt("/approvals", { approvals: approvalsFixture(), postResponse: () => new Response(JSON.stringify({ workItem: { status: "needs_approval" } }), { status: 200 }) });
    const btn = await screen.findByRole("button", { name: "Approve fs.write for Review deployment request" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "first of two" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Approve" })); });
    expect(await screen.findByText(/still needs more approvals/)).toBeTruthy();
    expect(screen.queryByText(/“Review deployment request” approved\./)).toBeNull();
  });

  it("shows enough for informed consent: requester, intent, what the action does and the full hash", async () => {
    mountAt("/approvals", { approvals: approvalsFixture() });
    const btn = await screen.findByRole("button", { name: "Approve fs.write for Review deployment request" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ship the release")).toBeTruthy();
    expect(within(dialog).getByText("write config")).toBeTruthy();
    expect(within(dialog).getByText("user")).toBeTruthy();
    expect(within(dialog).getByText("d".repeat(64))).toBeTruthy();
  });
});
