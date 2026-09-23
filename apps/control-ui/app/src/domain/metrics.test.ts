import { describe, expect, it } from "vitest";
import { counterDeltas, parsePrometheus, summarizeMetrics, sumWhere } from "./metrics";

const SAMPLE = `# HELP acs_sqlite_ready x
# TYPE acs_sqlite_ready gauge
acs_sqlite_ready 1
acs_http_requests_total{method="GET",route="/work-items",status="200"} 40
acs_http_requests_total{method="POST",route="/work-items",status="429"} 3
acs_http_requests_total{method="GET",route="/events",status="503"} 1
acs_http_request_duration_seconds_count{method="GET",route="/work-items"} 40
acs_http_request_duration_seconds_sum{method="GET",route="/work-items"} 0.4
acs_rate_limit_rejected_total{method="POST",route="/work-items"} 3
acs_audit_events_total{event_name="approval.granted"} 5
acs_audit_events_total{event_name="approval.consumed"} 2
acs_audit_events_total{event_name="execution.completed"} 6
acs_audit_events_total{event_name="work_item.failed"} 2
acs_sse_clients_dropped_total{reason="backpressure"} 1
garbage line that must be skipped
acs_broken{ 5
`;

describe("Prometheus parsing", () => {
  const samples = parsePrometheus(SAMPLE);
  it("parses samples and labels, skipping comments and garbage", () => {
    expect(samples).toHaveLength(12);
    expect(samples.find((s) => s.name === "acs_sqlite_ready")).toEqual({
      name: "acs_sqlite_ready",
      labels: {},
      value: 1
    });
    expect(samples[1]).toMatchObject({ labels: { method: "GET", route: "/work-items", status: "200" }, value: 40 });
  });
  it("unescapes label values", () => {
    expect(parsePrometheus('m{a="x\\"y\\\\z\\nq"} 1')[0]?.labels.a).toBe('x"y\\z\nq');
  });
  it("sumWhere aggregates by predicate", () => {
    expect(sumWhere(samples, "acs_http_requests_total")).toBe(44);
    expect(sumWhere(samples, "acs_http_requests_total", (l) => l.status === "429")).toBe(3);
  });
  it("summarizes only what the gateway actually exports", () => {
    const s = summarizeMetrics(samples);
    expect(s).toMatchObject({
      sqliteReady: true,
      requests429: 3,
      requests5xx: 1,
      rateLimitRejected: 3,
      approvalsGranted: 5,
      approvalsConsumed: 2,
      executionsSucceeded: 6,
      executionsFailed: 2,
      sseDropped: 1
    });
    expect(s.avgLatencySeconds).toBeCloseTo(0.01, 5);
    expect(s.topRoutes[0]).toEqual({ route: "/work-items", count: 43 });
  });
  it("empty input yields zeros and 'unknown', never fabricated values", () => {
    const s = summarizeMetrics(parsePrometheus(""));
    expect(s.sqliteReady).toBeUndefined();
    expect(s.avgLatencySeconds).toBeUndefined();
    expect(s.requestsTotal).toBe(0);
    expect(s.topRoutes).toEqual([]);
  });
});

describe("counter sampling", () => {
  it("returns per-interval increases and no bar for a counter reset (gateway restart)", () => {
    const points = [
      { at: 1, value: 10 },
      { at: 2, value: 15 },
      { at: 3, value: 2 },
      { at: 4, value: 9 }
    ];
    expect(counterDeltas(points)).toEqual([
      { at: 2, delta: 5 },
      { at: 4, delta: 7 }
    ]);
  });
  it("needs two samples to say anything (sparse data is honest)", () => {
    expect(counterDeltas([])).toEqual([]);
    expect(counterDeltas([{ at: 1, value: 3 }])).toEqual([]);
  });
});
