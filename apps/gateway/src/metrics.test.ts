import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("renders request, audit, and readiness metrics", () => {
    const metrics = new GatewayMetrics();
    metrics.observeRequest("POST", "/work-items", 201, 25);
    metrics.increment("acs_audit_events_total", { event_name: "work_item.created" });
    metrics.setGauge("scheduler_agent_active", 1, { agent: "claude" });
    metrics.clearGauges("scheduler_agent_active");
    metrics.setGauge("scheduler_agent_active", 2, { agent: "chatgpt" });
    metrics.setSqliteReady(true);

    const output = metrics.render();
    expect(output).toContain('acs_http_requests_total{method="POST",route="/work-items",status="201"} 1');
    expect(output).toContain('acs_http_request_duration_seconds_count{method="POST",route="/work-items"} 1');
    expect(output).toContain('acs_audit_events_total{event_name="work_item.created"} 1');
    expect(output).toContain('scheduler_agent_active{agent="chatgpt"} 2');
    expect(output).not.toContain('scheduler_agent_active{agent="claude"}');
    expect(output).toContain("acs_sqlite_ready 1");
  });
});
