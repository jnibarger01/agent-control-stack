import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("renders request, audit, and readiness metrics", () => {
    const metrics = new GatewayMetrics();
    metrics.observeRequest("POST", "/work-items", 201, 25);
    metrics.increment("acs_audit_events_total", { event_name: "work_item.created" });
    metrics.setSqliteReady(true);

    const output = metrics.render();
    expect(output).toContain('acs_http_requests_total{method="POST",route="/work-items",status="201"} 1');
    expect(output).toContain('acs_http_request_duration_seconds_count{method="POST",route="/work-items"} 1');
    expect(output).toContain('acs_audit_events_total{event_name="work_item.created"} 1');
    expect(output).toContain("acs_sqlite_ready 1");
  });
});

describe("GatewayMetrics.summary", () => {
  it("sums counters across label sets and filters 429s and 5xx by status", () => {
    const metrics = new GatewayMetrics();
    metrics.observeRequest("GET", "/", 200, 5);
    metrics.observeRequest("POST", "/work-items", 429, 1);
    metrics.observeRequest("POST", "/mcp", 429, 1);
    metrics.observeRequest("GET", "/readyz", 503, 2);
    metrics.increment("acs_rate_limit_rejected_total", { method: "POST", route: "/mcp" });
    metrics.increment("acs_rate_limit_rejected_total", { method: "POST", route: "/work-items" });
    metrics.increment("acs_auth_lockout_total", { route: "/session/login" });
    metrics.increment("acs_audit_events_total", { event_name: "work_item.created" });
    metrics.increment("acs_audit_events_total", { event_name: "policy.decided" });
    metrics.setSqliteReady(true);

    expect(metrics.summary()).toEqual({
      sqliteReady: true,
      httpRequests: 4,
      http429: 2,
      http5xx: 1,
      rateLimited: 2,
      authLockouts: 1,
      sseRejected: 0,
      sseDropped: 0,
      auditEvents: 2
    });
    expect(metrics.total("acs_http_requests_total", (labels) => labels.route === "/mcp")).toBe(1);
    // The Prometheus text is unchanged by the structured bookkeeping.
    expect(metrics.render()).toContain('acs_http_requests_total{method="POST",route="/mcp",status="429"} 1');
  });
});
