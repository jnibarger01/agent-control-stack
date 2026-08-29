import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe("claimSchedulerFiring / completeSchedulerFiring", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function createStore(): SqliteWorkItemStore {
    directory = mkdtempSync(join(tmpdir(), "acs-scheduler-firing-"));
    return new SqliteWorkItemStore(join(directory, "control.db"));
  }

  it("claims a firing that has never been seen before", () => {
    const store = createStore();
    const claim = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: new Date("2026-01-01T00:00:00.000Z"), idempotencyKey: hex("a") },
      { via: "domain_service" }
    );

    expect(claim.owned).toBe(true);
    expect(claim.firing).toMatchObject({ scheduleId: "nightly", status: "claimed" });
  });

  it("refuses without a privileged transition option", () => {
    const store = createStore();
    expect(() =>
      store.claimSchedulerFiring(
        { scheduleId: "nightly", scheduledFiringTime: new Date(), idempotencyKey: hex("a") },
        undefined as never
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" }));
  });

  it("a second claim on the same (scheduleId, scheduledFiringTime) does not own it and does not create a duplicate row", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z");
    const first = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a") },
      { via: "domain_service" }
    );
    const second = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a") },
      { via: "domain_service" }
    );

    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);
    expect(second.firing.firingId).toBe(first.firing.firingId);
  });

  it("returns the completed firing (not a fresh claim) once completeSchedulerFiring has run", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z");
    const claim = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a") },
      { via: "domain_service" }
    );
    const completed = store.completeSchedulerFiring(claim.firing.firingId, "wrk_123", { via: "domain_service" });
    expect(completed.status).toBe("completed");
    expect(completed.workItemId).toBe("wrk_123");

    const retry = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a") },
      { via: "domain_service" }
    );
    expect(retry.owned).toBe(false);
    expect(retry.firing.status).toBe("completed");
    expect(retry.firing.workItemId).toBe("wrk_123");
  });

  it("records the crash-safe work-item handoff, then lets completion follow it idempotently", () => {
    const store = createStore();
    const claim = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: new Date(), idempotencyKey: hex("a") },
      { via: "domain_service" }
    );

    const recorded = store.recordSchedulerFiringWorkItem(claim.firing.firingId, "wrk_crash_safe", {
      via: "domain_service"
    });
    expect(recorded.status).toBe("claimed");
    expect(recorded.workItemId).toBe("wrk_crash_safe");

    // A retry after a crash between record and complete must be a no-op,
    // not a conflict - the work item was already created.
    const reRecorded = store.recordSchedulerFiringWorkItem(claim.firing.firingId, "wrk_crash_safe", {
      via: "domain_service"
    });
    expect(reRecorded.workItemId).toBe("wrk_crash_safe");

    const completed = store.completeSchedulerFiring(claim.firing.firingId, "wrk_crash_safe", {
      via: "domain_service"
    });
    expect(completed.status).toBe("completed");
    expect(completed.workItemId).toBe("wrk_crash_safe");
  });

  it("refuses to record a work item against a firing already bound to a different one", () => {
    const store = createStore();
    const claim = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: new Date(), idempotencyKey: hex("a") },
      { via: "domain_service" }
    );
    store.recordSchedulerFiringWorkItem(claim.firing.firingId, "wrk_first", { via: "domain_service" });

    expect(() =>
      store.recordSchedulerFiringWorkItem(claim.firing.firingId, "wrk_second", { via: "domain_service" })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "scheduler_firing_conflict" }));
  });

  it("refuses to complete a firing twice", () => {
    const store = createStore();
    const claim = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: new Date(), idempotencyKey: hex("a") },
      { via: "domain_service" }
    );
    store.completeSchedulerFiring(claim.firing.firingId, "wrk_1", { via: "domain_service" });

    expect(() => store.completeSchedulerFiring(claim.firing.firingId, "wrk_2", { via: "domain_service" })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "scheduler_firing_conflict" })
    );
  });

  it("does not reclaim a fresh (non-stale) in-flight claim", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z");
    const claimedAt = new Date("2026-01-01T00:05:00.000Z");
    store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a"), now: claimedAt },
      { via: "domain_service" }
    );

    const secondAttempt = store.claimSchedulerFiring(
      {
        scheduleId: "nightly",
        scheduledFiringTime: time,
        idempotencyKey: hex("a"),
        staleClaimMs: 60_000,
        now: new Date(claimedAt.getTime() + 30_000)
      },
      { via: "domain_service" }
    );
    expect(secondAttempt.owned).toBe(false);
    expect(secondAttempt.firing.status).toBe("claimed");
  });

  it("reclaims a stale claim so a crashed process's firing is not stuck forever", () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z");
    const claimedAt = new Date("2026-01-01T00:05:00.000Z");
    const original = store.claimSchedulerFiring(
      { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a"), now: claimedAt },
      { via: "domain_service" }
    );

    const reclaim = store.claimSchedulerFiring(
      {
        scheduleId: "nightly",
        scheduledFiringTime: time,
        idempotencyKey: hex("a"),
        staleClaimMs: 60_000,
        now: new Date(claimedAt.getTime() + 120_000)
      },
      { via: "domain_service" }
    );

    expect(reclaim.owned).toBe(true);
    expect(reclaim.firing.firingId).toBe(original.firing.firingId);
    expect(reclaim.firing.status).toBe("claimed");
  });

  it("distinct scheduled firing times for the same schedule are independent claims", () => {
    const store = createStore();
    const first = store.claimSchedulerFiring(
      {
        scheduleId: "nightly",
        scheduledFiringTime: new Date("2026-01-01T00:00:00.000Z"),
        idempotencyKey: hex("a")
      },
      { via: "domain_service" }
    );
    const second = store.claimSchedulerFiring(
      {
        scheduleId: "nightly",
        scheduledFiringTime: new Date("2026-01-02T00:00:00.000Z"),
        idempotencyKey: hex("b")
      },
      { via: "domain_service" }
    );

    expect(first.owned).toBe(true);
    expect(second.owned).toBe(true);
    expect(first.firing.firingId).not.toBe(second.firing.firingId);
  });

  it("10 concurrent claim attempts on the same firing yield exactly one owner", async () => {
    const store = createStore();
    const time = new Date("2026-01-01T00:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() =>
          store.claimSchedulerFiring(
            { scheduleId: "nightly", scheduledFiringTime: time, idempotencyKey: hex("a") },
            { via: "domain_service" }
          )
        )
      )
    );

    const owners = results.filter((r) => r.owned);
    expect(owners).toHaveLength(1);
    const firingIds = new Set(results.map((r) => r.firing.firingId));
    expect(firingIds.size).toBe(1);
  });
});
