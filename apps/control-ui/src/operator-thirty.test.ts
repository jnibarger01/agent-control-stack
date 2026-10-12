import { describe, expect, it } from "vitest";
import { renderDashboard } from "./index.js";
import {
  bucketWorkItemAge,
  bucketWorkItemAges,
  classifyAgentActivity,
  classifyApprovalSla,
  detectAuditSequenceGaps,
  detectDuplicateIntents,
  detectRetryStorms,
  detectStaleLeases,
  executionModeDisplayWarning,
  policyDenialRate,
  riskWeightedQueueScore
} from "./operator-insights.js";
import {
  adminModeMustConfirm,
  clipboardPayload,
  emptyQueueMessage,
  filterChipSummary,
  focusRingToken,
  navBadgeCounts,
  parseStoredView,
  reducedMotionQuery,
  relativeTime,
  shouldHandleRefreshShortcut
} from "./operator-impact.js";
import { OPERATOR_THIRTY, operatorInsightsHtml, operatorToolbarHtml } from "./operator-thirty-ui.js";
import {
  densityClass,
  filterCountAnnouncement,
  printAuditCss,
  pushRecentId,
  rankCommandResults,
  SKIP_LINK_TARGETS,
  sortQueueItems,
  statusGlyph,
  statusGlyphLabel,
  timezoneLabel,
  togglePinnedId
} from "./operator-ux.js";

const now = new Date("2026-10-10T18:00:00.000Z");

describe("operator thirty", () => {
  it("ships exactly 30 named changes", () => {
    expect(new Set(OPERATOR_THIRTY).size).toBe(30);
    expect(OPERATOR_THIRTY).toHaveLength(30);
  });

  it("scores attention and risk above idle low-risk work", () => {
    const urgent = riskWeightedQueueScore(
      { risk: "critical", status: "needs_approval", createdAt: "2026-10-10T16:00:00.000Z" },
      now
    );
    const idle = riskWeightedQueueScore(
      { risk: "low", status: "succeeded", createdAt: "2026-10-10T17:30:00.000Z" },
      now
    );
    expect(urgent).toBeGreaterThan(idle);
  });

  it("classifies SLA warning before breach and ignores a non-positive SLA", () => {
    expect(classifyApprovalSla(75, 100)).toBe("warning");
    expect(classifyApprovalSla(100, 100)).toBe("breach");
    expect(classifyApprovalSla(10, 0)).toBe("unknown");
  });

  it("detects stale leases and audit gaps without inventing a leading gap", () => {
    expect(detectStaleLeases([{ id: "lease_a", expiresAt: "2026-10-10T17:00:00.000Z" }, { id: "lease_b", expiresAt: "2026-10-10T19:00:00.000Z" }], now)).toEqual(["lease_a"]);
    expect(detectAuditSequenceGaps([{ sequence: 2 }, { sequence: 4 }, { sequence: 4 }])).toEqual([3]);
  });

  it("buckets age, agent activity, duplicate intents, denial rate, and retry storms", () => {
    expect(bucketWorkItemAge("2026-10-10T17:30:00.000Z", now)).toBe("fresh");
    expect(bucketWorkItemAges([{ id: "a", createdAt: "2026-10-01T18:00:00.000Z" }], now).ancient).toEqual(["a"]);
    expect(classifyAgentActivity("2026-10-10T17:58:00.000Z", now)).toBe("active");
    expect(classifyAgentActivity("2026-10-10T17:40:00.000Z", now)).toBe("idle");
    expect(detectDuplicateIntents([{ id: "a", intent: "Restart  API" }, { id: "b", intent: "restart api" }, { id: "c", intent: "other" }])).toEqual({ "restart api": ["a", "b"] });
    const proto = detectDuplicateIntents([{ id: "p1", intent: "__proto__" }, { id: "p2", intent: "__proto__" }]);
    expect(Object.getPrototypeOf(proto)).toBeNull();
    expect(Object.keys(proto)).toEqual(["__proto__"]);
    expect(proto["__proto__"]).toEqual(["p1", "p2"]);
    expect(policyDenialRate([])).toBeUndefined();
    expect(policyDenialRate([{ outcome: "deny" }, { outcome: "allow" }])).toBe(0.5);
    expect(detectRetryStorms([{ id: "storm", retrySequence: 3 }, { id: "ok", retrySequence: 1 }])).toEqual(["storm"]);
  });

  it("warns that admin mode is display-only and never treats dry-run as live execution", () => {
    expect(executionModeDisplayWarning("admin", "dry_run")).toContain("dry-run");
    expect(executionModeDisplayWarning("strict", "dry_run")).toBeUndefined();
    expect(adminModeMustConfirm()).toBe(true);
  });

  it("formats relative time, clipboard ids, empty queues, shortcuts, and views", () => {
    expect(relativeTime("2026-10-10T17:00:00.000Z", now)).toBe("1h ago");
    expect(clipboardPayload("wrk_123")).toBe("wrk_123");
    expect(clipboardPayload("api_key_live")).toBeUndefined();
    expect(clipboardPayload("has space")).toBeUndefined();
    expect(emptyQueueMessage(true, 4)).toContain("Clear filters");
    expect(emptyQueueMessage(false, 0)).toBe("No work items.");
    expect(shouldHandleRefreshShortcut({ key: "r" }, false)).toBe(true);
    expect(shouldHandleRefreshShortcut({ key: "r", metaKey: true }, false)).toBe(false);
    expect(shouldHandleRefreshShortcut({ key: "r" }, true)).toBe(false);
    expect(parseStoredView("audit")).toBe("audit");
    expect(parseStoredView("../etc")).toBeUndefined();
    expect(focusRingToken()).toContain("var(--accent)");
    expect(focusRingToken()).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(reducedMotionQuery()).toBe("(prefers-reduced-motion: reduce)");
  });

  it("counts nav badges and summarizes filters", () => {
    expect(navBadgeCounts([{ status: "needs_approval" }, { status: "blocked" }, { status: "quarantined" }])).toEqual({
      approvals: 1,
      attention: 3,
      failed: 1
    });
    expect(filterChipSummary({ statuses: ["failed"], risks: [], agentId: "", text: "api" })).toBe("1 status, text");
  });

  it("sorts, pins, ranks, announces, and labels without storing secrets", () => {
    expect(densityClass("compact")).toBe("compact");
    expect(densityClass("nope")).toBe("comfortable");
    const sorted = sortQueueItems(
      [
        { id: "b", status: "succeeded", risk: "low", createdAt: "2026-10-10T12:00:00.000Z" },
        { id: "a", status: "needs_approval", risk: "critical", createdAt: "2026-10-10T13:00:00.000Z" }
      ],
      "attention"
    );
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
    expect(sortQueueItems(sorted, "server").map((item) => item.id)).toEqual(["a", "b"]);
    expect(togglePinnedId(["keep"], "wrk_new")).toEqual(["wrk_new", "keep"]);
    expect(togglePinnedId(["wrk_new", "keep"], "wrk_new")).toEqual(["keep"]);
    expect(pushRecentId(["old"], "wrk_new")).toEqual(["wrk_new", "old"]);
    expect(rankCommandResults("queue", [{ label: "audit" }, { label: "queue", keywords: "work" }, { label: "agents" }]).map((item) => item.label)).toEqual(["queue"]);
    expect(SKIP_LINK_TARGETS.map((link) => link.href)).toEqual(["#main-content", "#approvals", "#queue"]);
    expect(filterCountAnnouncement(2, 5)).toBe("Showing 2 of 5 work items");
    expect(statusGlyph("needs_approval")).toBe("!");
    expect(statusGlyphLabel("needs_approval")).toContain("needs approval");
    expect(printAuditCss()).toContain("@media print");
    expect(timezoneLabel(now, "UTC")).toContain("UTC");
  });

  it("renders the toolbar, insights, skip links, and stable queue markers", () => {
    const html = renderDashboard([]);
    expect(html).toContain('id="operator-toolbar"');
    expect(html).toContain('id="operator-insights"');
    expect(html).toContain("Skip to approvals");
    expect(html).toContain("does not grant execution authority");
    expect(operatorToolbarHtml()).toContain("Copy selected id");
    expect(operatorInsightsHtml()).toContain("read-only");
    expect(operatorInsightsHtml()).toContain("read-only");
  });
});
