import { describe, expect, it } from "vitest";
import { event } from "../test-fixtures";
import {
  applyAuditFilters,
  DEFAULT_AUDIT_FILTERS,
  eventActor,
  eventsPerSecond,
  eventSummary,
  eventTypeGroups,
  eventWorkItem,
  parseAuditFilters,
  relatedEvents,
  serializeAuditFilters,
  type AuditFilters
} from "./audit";
import { eventTimeMs, invalidationsFor, severityFor } from "../state/reconcile";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const f = (over: Partial<AuditFilters>): AuditFilters => ({ ...DEFAULT_AUDIT_FILTERS, ...over });

const created = event(
  "work_item.created",
  { "work_item.id": "wrk_1", "actor.id": "op-1" },
  { status: "needs_approval" },
  "2026-09-19T11:59:00.000Z"
);
const denied = event(
  "policy.decided",
  { "work_item.id": "wrk_2", "policy.decision": "deny" },
  { reason: "destructive command is denied" },
  "2026-09-19T11:00:00.000Z"
);
const hb = event("tunnel_session.heartbeat", { "connector.id": "corp-dc-1" }, {}, "2026-09-19T11:58:00.000Z");
const granted = event(
  "approval.granted",
  { "work_item.id": "wrk_1", "action.hash": "h" },
  { approvedBy: "op-1", reason: "ok" },
  "2026-09-19T11:59:30.000Z"
);
const events = [created, denied, hb, granted];

describe("severity", () => {
  it("derives error/warning/notice/info from names and decisions", () => {
    expect(severityFor(denied)).toBe("error");
    expect(severityFor(event("work_item.failed"))).toBe("error");
    expect(severityFor(event("attempt_lease.expired"))).toBe("error");
    expect(severityFor(event("work_item.needs_approval"))).toBe("warning");
    expect(severityFor(event("policy.decided", { "policy.decision": "require_approval" }))).toBe("warning");
    expect(severityFor(granted)).toBe("notice");
    expect(severityFor(event("tunnel_session.heartbeat"))).toBe("info");
  });
});

describe("audit filters", () => {
  it("filters by type prefix, actor, work item, severity and time window", () => {
    expect(applyAuditFilters(events, f({ type: "policy" }), NOW)).toEqual([denied]);
    expect(
      applyAuditFilters(events, f({ actor: "op-1" }), NOW)
        .map((e) => e.name)
        .sort()
    ).toEqual(["approval.granted", "work_item.created"]);
    expect(applyAuditFilters(events, f({ workItem: "wrk_2" }), NOW)).toEqual([denied]);
    expect(applyAuditFilters(events, f({ severity: "error" }), NOW)).toEqual([denied]);
    expect(
      applyAuditFilters(events, f({ window: "5m" }), NOW)
        .map((e) => e.name)
        .sort()
    ).toEqual(["approval.granted", "tunnel_session.heartbeat", "work_item.created"]);
  });
  it("full-text search covers name, id, actor, work item, summary and attributes", () => {
    expect(applyAuditFilters(events, f({ q: "destructive" }), NOW)).toEqual([denied]);
    expect(applyAuditFilters(events, f({ q: "corp-dc-1" }), NOW)).toEqual([hb]);
    expect(applyAuditFilters(events, f({ q: created.id }), NOW)).toEqual([created]);
  });
  it("round-trips through the URL and rejects unknown severities", () => {
    const filters = f({ q: "x", type: "policy", severity: "error", window: "1h" });
    expect(parseAuditFilters(serializeAuditFilters(filters))).toEqual(filters);
    expect(parseAuditFilters(new URLSearchParams("severity=<script>")).severity).toBe("");
  });
});

describe("audit projections", () => {
  it("actor falls back through attributes and body, then 'system'", () => {
    expect(eventActor(created)).toBe("op-1");
    expect(eventActor(granted)).toBe("op-1");
    expect(eventActor(denied)).toBe("system");
    expect(eventActor(hb)).toBe("corp-dc-1");
  });
  it("summary is built from structured fields and truncated", () => {
    expect(eventSummary(denied)).toContain("decision deny");
    expect(eventSummary(event("x", {}, { reason: "r".repeat(400) })).length).toBeLessThan(200);
    expect(eventSummary(event("x"))).toBe("—");
  });
  it("hostile payload text stays plain data (never markup) in every projection", () => {
    const hostile = event(
      "work_item.created",
      { "work_item.id": "<img src=x onerror=alert(1)>" },
      { reason: "<script>alert(1)</script>" }
    );
    expect(eventSummary(hostile)).toBe("<script>alert(1)</script>");
    expect(eventWorkItem(hostile)).toBe("<img src=x onerror=alert(1)>");
    expect(typeof eventSummary(hostile)).toBe("string");
  });
  it("groups type prefixes and finds related events by shared identifiers", () => {
    expect(eventTypeGroups(events)).toEqual(["approval", "policy", "tunnel_session", "work_item"]);
    expect(relatedEvents(created, events).map((e) => e.name)).toEqual(["approval.granted"]);
    expect(relatedEvents(event("x"), events)).toEqual([]);
  });
  it("events/sec is computed from real timestamps in the window", () => {
    expect(eventsPerSecond([created, granted], NOW, 60_000)).toBeCloseTo(2 / 60, 5);
    expect(eventsPerSecond([denied], NOW, 60_000)).toBe(0);
  });
  it("nanosecond timestamps convert without precision loss", () => {
    expect(eventTimeMs(created)).toBe(Date.parse("2026-09-19T11:59:00.000Z"));
    expect(Number.isNaN(eventTimeMs({ timeUnixNano: "not-a-number" }))).toBe(true);
  });
});

describe("live-event reconciliation", () => {
  it("invalidates the narrowest affected views", () => {
    expect(invalidationsFor(event("work_item.needs_approval", { "work_item.id": "wrk_5" }))).toEqual(
      expect.arrayContaining(["events", "work-items", "work-item:wrk_5", "executions"])
    );
    expect(invalidationsFor(event("agent.updated", { "agent.id": "analyst-1" }))).toEqual(
      expect.arrayContaining(["agents", "actors", "agent:analyst-1"])
    );
    expect(invalidationsFor(event("tunnel_session.revoked", { "connector.id": "c1" }))).toEqual(
      expect.arrayContaining(["actors", "agents"])
    );
    const unrelated = invalidationsFor(event("connector.requested"));
    expect(unrelated).not.toContain("work-items");
  });
  it("never returns duplicates", () => {
    const keys = invalidationsFor(event("execution_attempt.created", { "work_item.id": "wrk_1", "worker.id": "w1" }));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
