import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("renders request, audit, and readiness metrics", () => {
    const metrics = new GatewayMetrics();
    metrics.observeRequest("POST", "/work-items", 201, 25);
    metrics.increment("acs_audit_events_total", { event_name: "work_item.created" });
    metrics.setGauge("acs_admission_active", 2, { class: "execution" });
    metrics.observeDurationMs("acs_admission_wait_ms", 12, { lane: "jc", class: "execution" });
    metrics.setSqliteReady(true);

    const output = metrics.render();
    expect(output).toContain('acs_http_requests_total{method="POST",route="/work-items",status="201"} 1');
    expect(output).toContain('acs_http_request_duration_seconds_count{method="POST",route="/work-items"} 1');
    expect(output).toContain('acs_audit_events_total{event_name="work_item.created"} 1');
    expect(output).toContain('acs_admission_active{class="execution"} 2');
    expect(output).toContain('acs_admission_wait_ms_count{class="execution",lane="jc"} 1');
    expect(output).toContain('acs_admission_wait_ms_sum{class="execution",lane="jc"} 12');
    expect(output).toContain("acs_sqlite_ready 1");
  });
});

describe("GatewayMetrics readiness telemetry", () => {
  it("tracks a bounded readiness window with latest, p50, p95, failures, and sample count", () => {
    const metrics = new GatewayMetrics();
    metrics.observeReadiness(1, true);
    metrics.observeReadiness(2, true);
    metrics.observeReadiness(3, false);
    metrics.observeReadiness(4, true);
    metrics.observeReadiness(5, true);

    expect(metrics.readyzSummary()).toEqual({
      latestMs: 5,
      p50Ms: 3,
      p95Ms: 5,
      failures: 1,
      sampleCount: 5
    });
    const output = metrics.render();
    expect(output).toContain('acs_readyz_gateway_ms{stat="latest"} 5');
    expect(output).toContain('acs_readyz_gateway_ms{stat="p50"} 3');
    expect(output).toContain('acs_readyz_gateway_ms{stat="p95"} 5');
    expect(output).toContain("acs_readyz_window_failures 1");
    expect(output).toContain("acs_readyz_window_samples 5");
  });
});


describe("GatewayMetrics admission latency telemetry", () => {
  it("keeps lane-specific rolling service and wait latency summaries", () => {
    const metrics = new GatewayMetrics();
    metrics.observeAdmissionLatency("jc", "wait", 4);
    metrics.observeAdmissionLatency("jc", "service", 10);
    metrics.observeAdmissionLatency("jc", "service", 20);
    metrics.observeAdmissionLatency("jc", "service", 30);
    metrics.observeAdmissionLatency("dc", "service", 80);

    expect(metrics.admissionLatencySummary()).toEqual({
      jc: {
        wait: { latestMs: 4, p50Ms: 4, p95Ms: 4, sampleCount: 1 },
        service: { latestMs: 30, p50Ms: 20, p95Ms: 30, sampleCount: 3 }
      },
      dc: {
        wait: { latestMs: null, p50Ms: null, p95Ms: null, sampleCount: 0 },
        service: { latestMs: 80, p50Ms: 80, p95Ms: 80, sampleCount: 1 }
      }
    });

    const output = metrics.render();
    expect(output).toContain('acs_admission_latency_ms{lane="jc",phase="service",stat="latest"} 30');
    expect(output).toContain('acs_admission_latency_ms{lane="jc",phase="service",stat="p95"} 30');
    expect(output).toContain('acs_admission_latency_window_samples{lane="dc",phase="service"} 1');
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
