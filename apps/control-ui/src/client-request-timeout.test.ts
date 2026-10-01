import { describe, expect, it } from "vitest";
import { CLIENT_REQUEST_TIMEOUT_MS, METRICS_POLL_MS, type MissionControlViewModel } from "./index.js";
import { bootLive } from "./live-harness.test-support.js";

type Item = MissionControlViewModel["workItems"][number];
type AuditEvent = MissionControlViewModel["events"][number];

const NOW = new Date("2026-09-22T00:01:00.000Z");

function item(id: string, status: Item["status"] = "succeeded"): Item {
  return {
    id,
    title: `Task ${id}`,
    requester: "user",
    status,
    intent: `do ${id}`,
    target: {},
    requestedActions: [{ kind: "shell", description: "run", params: {} }],
    risk: "low",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z"
  } as Item;
}

function event(sequence: number, name = "work_item.created"): AuditEvent {
  return {
    sequence,
    timeUnixNano: String(BigInt(1_790_000_000_000 + sequence) * 1_000_000n),
    name,
    attributes: { "work_item.id": `wrk_${sequence}` }
  } as unknown as AuditEvent;
}

function metricsBody(requests: number) {
  return {
    at: "2026-09-22T00:00:00.000Z",
    metrics: {
      sqliteReady: true,
      httpRequests: requests,
      http429: 0,
      http5xx: 0,
      rateLimited: 0,
      authLockouts: 0,
      sseRejected: 0,
      sseDropped: 0,
      auditEvents: 0
    }
  };
}

// A gateway that accepts the connection and never answers used to leave every
// caller's in-flight latch set for the life of the tab. These tests drive the
// real client against a mock fetch that only settles when the client aborts,
// and assert each latch releases at the deadline.
describe("bounded dashboard requests", () => {
  it("releases the fragments refresh latch when the gateway never answers", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.hangNextFragments(1);
    app.open();
    await app.advance(0);
    expect(app.fragmentFetches()).toBe(1);
    expect(app.liveText()).not.toContain("refresh failed");

    // Still inside the deadline: the client keeps waiting, it has not given up.
    await app.advance(CLIENT_REQUEST_TIMEOUT_MS / 2);
    expect(app.fragmentFetches()).toBe(1);
    expect(app.liveText()).not.toContain("refresh failed");

    await app.advance(CLIENT_REQUEST_TIMEOUT_MS / 2);
    expect(app.liveText()).toContain("refresh failed, retrying");

    // The latch is released, so the backoff retry actually reaches the gateway.
    await app.advance(1_000);
    expect(app.fragmentFetches()).toBe(2);
    expect(app.liveText()).not.toContain("refresh failed");
    expect(app.document.querySelector("#dashboard-updated")?.textContent).toContain("Updated");
  });

  it("clears the metrics in-flight latch so polling resumes after a stall", async () => {
    let polls = 0;
    const app = bootLive(
      { workItems: [], events: [], now: NOW },
      {
        "/dashboard/metrics": () => {
          polls += 1;
          return polls === 1 ? { hang: true } : { body: metricsBody(100 + polls) };
        }
      }
    );
    app.open();
    (app.document.querySelector('nav a[data-nav="metrics"]') as HTMLElement).click();
    await app.advance(CLIENT_REQUEST_TIMEOUT_MS);
    expect(polls).toBe(1);
    expect(app.text("#live-metrics")).toContain("Metrics unavailable.");

    await app.advance(METRICS_POLL_MS);
    expect(polls).toBe(2);
    expect(app.text("#live-metrics")).toContain("SQLite ready");
    expect(app.text("#live-metrics")).not.toContain("Metrics unavailable.");
  });

  it("re-enables the audit 'Load older' control after a stalled page request", async () => {
    let pages = 0;
    const app = bootLive(
      { workItems: [], events: [event(51), event(52)], now: NOW },
      {
        "/dashboard/events": () => {
          pages += 1;
          return pages === 1 ? { hang: true } : { body: { events: [event(1)] } };
        }
      }
    );
    app.open();
    const button = app.document.getElementById("events-load-older") as HTMLButtonElement;
    button.click();
    await app.advance(0);
    expect(pages).toBe(1);
    expect(button.disabled).toBe(true);

    await app.advance(CLIENT_REQUEST_TIMEOUT_MS);
    expect(app.text("#action-status")).toBe("Could not load older events");
    expect(button.disabled).toBe(false);

    button.click();
    await app.advance(0);
    expect(pages).toBe(2);
    expect(app.text("#action-status")).toBe("Loaded 1 older events");
    expect(button.textContent).toBe("No older events");
    expect(button.disabled).toBe(true);
  });

  it("reports the deadline on a stalled work-item detail instead of a generic failure", async () => {
    const app = bootLive(
      { workItems: [item("wrk_live", "running")], events: [], now: NOW },
      { "/work-items/wrk_live": () => ({ hang: true }) }
    );
    (app.document.querySelector('[data-work-item="wrk_live"]') as HTMLElement).click();
    await app.advance(CLIENT_REQUEST_TIMEOUT_MS);
    expect(app.text("#work-detail")).toContain(`request timed out after ${CLIENT_REQUEST_TIMEOUT_MS}ms`);
  });
});
