import { describe, expect, it } from "vitest";
import { bootLive } from "./live-harness.test-support.js";
import type { MissionControlViewModel } from "./index.js";

const CLOCK_START_MS = 1_800_000_000_000;

const item = {
  id: "wrk_lease_warn",
  title: "Lease expiry warning",
  requester: "user" as const,
  status: "running" as const,
  intent: "verify the expiring-soon lease warning",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: {} }],
  risk: "low" as const,
  createdAt: new Date(CLOCK_START_MS - 60_000).toISOString(),
  updatedAt: new Date(CLOCK_START_MS - 30_000).toISOString()
};

const attempt = {
  attemptId: "attempt_1",
  workItemId: item.id,
  planId: "plan_1",
  planHash: "b".repeat(64),
  attemptNumber: 1,
  protocolVersion: "acs.worker.v2" as const,
  inputHash: "a".repeat(64),
  status: "leased" as const,
  currentFencingEpoch: 1,
  claimedByWorkerId: "worker-1",
  createdAt: new Date(CLOCK_START_MS - 30_000).toISOString(),
  updatedAt: new Date(CLOCK_START_MS - 30_000).toISOString()
};

function leaseWith(expiresInMs: number, overrides: Record<string, unknown> = {}) {
  return {
    leaseId: "lease_1",
    attemptId: attempt.attemptId,
    workItemId: item.id,
    admissionId: "admission_1",
    workerId: "worker-1",
    planHash: attempt.planHash,
    inputHash: attempt.inputHash,
    fencingEpoch: 1,
    protocolVersion: "acs.worker.v2" as const,
    policyVersion: "acs.policy.v1",
    policyDecisionHash: "c".repeat(64),
    issuedAt: new Date(CLOCK_START_MS - 4 * 60_000).toISOString(),
    expiresAt: new Date(CLOCK_START_MS + expiresInMs).toISOString(),
    maxExpiresAt: new Date(CLOCK_START_MS + expiresInMs).toISOString(),
    lastRenewedAt: new Date(CLOCK_START_MS - 30_000).toISOString(),
    status: "active" as const,
    ...overrides
  };
}

function initial(): MissionControlViewModel {
  return { workItems: [item], events: [], executionAttemptsByWorkItem: { [item.id]: [attempt] } };
}

async function openDetail(lease: ReturnType<typeof leaseWith>, serverOffsetMs = 0) {
  const serverDate = new Date(CLOCK_START_MS + serverOffsetMs).toUTCString();
  const app = bootLive(initial(), {
    [`/work-items/${item.id}`]: () => ({
      status: 200,
      headers: { Date: serverDate },
      body: {
        workItem: item,
        events: [],
        executionAttempts: [attempt],
        attemptLeases: [lease]
      }
    })
  });
  app.open();
  await app.advance(2_000);
  (app.document.querySelector(`[data-work-item="${item.id}"]`) as HTMLElement).click();
  await app.flush();
  return app;
}

function warningText(app: Awaited<ReturnType<typeof openDetail>>) {
  return app.text(".lease-expiry-warning");
}

describe("lease expiring-soon warning", () => {
  it("uses lastRenewedAt as the current TTL start", async () => {
    const lease = leaseWith(4 * 60_000, {
      issuedAt: new Date(CLOCK_START_MS - 20 * 60_000).toISOString(),
      lastRenewedAt: new Date(CLOCK_START_MS - 60_000).toISOString()
    });
    const app = await openDetail(lease);
    expect(warningText(app)).toBe("");
  });

  it("reevaluates while the detail remains open and clears after expiry", async () => {
    const app = await openDetail(
      leaseWith(70_000, { lastRenewedAt: new Date(CLOCK_START_MS - 230_000).toISOString() })
    );
    expect(warningText(app)).toBe("");

    await app.advance(15_000);
    expect(warningText(app)).toContain("expiring soon");

    await app.advance(60_000);
    expect(warningText(app)).toBe("");
  });

  it("uses the HTTP Date header to correct a skewed browser clock", async () => {
    // Server is two minutes ahead. The server sees only 30s remaining even
    // though the browser's local clock would incorrectly see 150s.
    const app = await openDetail(
      leaseWith(150_000, { lastRenewedAt: new Date(CLOCK_START_MS - 150_000).toISOString() }),
      120_000
    );
    expect(warningText(app)).toContain("expiring soon");
  });

  it("does not warn for an expired or non-active lease", async () => {
    const expired = await openDetail(leaseWith(-10_000));
    expect(warningText(expired)).toBe("");

    const released = await openDetail(leaseWith(30_000, { status: "released" }));
    expect(warningText(released)).toBe("");
  });

  it("keeps an author rule that hides inactive warning pills", async () => {
    const app = await openDetail(leaseWith(4 * 60_000));
    const warning = app.document.querySelector(".lease-expiry-warning") as HTMLElement;
    expect(warning.hidden).toBe(true);
    // The .pill author rule sets display:inline-flex, which overrides the
    // hidden attribute in real browsers and shows an empty amber pill.
    // jsdom applies the UA [hidden] rule regardless, so guard the author
    // rule itself rather than the computed style.
    const css = Array.from(app.document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toMatch(/\.lease-expiry-warning\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("does not rewrite the live region while the warning state is unchanged", async () => {
    const app = await openDetail(
      leaseWith(50_000, { lastRenewedAt: new Date(CLOCK_START_MS - 250_000).toISOString() })
    );
    const warning = app.document.querySelector(".lease-expiry-warning") as HTMLElement;
    expect(warning.hidden).toBe(false);
    const mutations: string[] = [];
    const observer = new app.window.MutationObserver((records) => {
      for (const record of records) mutations.push(record.type);
    });
    observer.observe(warning, { attributes: true, characterData: true, childList: true, subtree: true });
    await app.advance(15_000);
    await app.flush();
    observer.disconnect();
    expect(mutations).toEqual([]);
  });
});
