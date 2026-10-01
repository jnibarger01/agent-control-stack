import { describe, expect, it } from "vitest";
import {
  WEBMCP_GATE_CLEARED_VALUE,
  WEBMCP_LIVE_ENV,
  WEBMCP_LIVE_GATE_ENV,
  assertWebMcpExecutionGate,
  requireLiveWebMcpGate,
  resolveWebMcpExecutionGate
} from "./gate.js";
import { expectCode } from "./test-support.js";

const cleared = { [WEBMCP_LIVE_ENV]: "1", [WEBMCP_LIVE_GATE_ENV]: WEBMCP_GATE_CLEARED_VALUE };

describe("the lane is inert by default", () => {
  it("is closed with no configuration at all", () => {
    const gate = resolveWebMcpExecutionGate({});
    expect(gate.live).toBe(false);
    expect(gate.reason).toBe("lane_disabled");
  });

  it("stays closed when the lane is switched on but the release gate is not cleared", () => {
    const gate = resolveWebMcpExecutionGate({ [WEBMCP_LIVE_ENV]: "1" });
    expect(gate.live).toBe(false);
    expect(gate.reason).toBe("execution_gate_not_cleared");
  });

  it("stays closed when the gate marker is present but the lane is off", () => {
    const gate = resolveWebMcpExecutionGate({ [WEBMCP_LIVE_GATE_ENV]: WEBMCP_GATE_CLEARED_VALUE });
    expect(gate.live).toBe(false);
    expect(gate.reason).toBe("lane_disabled");
  });

  it.each([
    ["true instead of 1", { ...cleared, [WEBMCP_LIVE_ENV]: "true" }],
    ["yes instead of and 1", { ...cleared, [WEBMCP_LIVE_ENV]: "yes" }],
    ["an empty lane value", { ...cleared, [WEBMCP_LIVE_ENV]: "" }],
    ["a partially cleared marker", { ...cleared, [WEBMCP_LIVE_GATE_ENV]: "clear" }],
    ["a cleared marker in the wrong case", { ...cleared, [WEBMCP_LIVE_GATE_ENV]: "CLEARED" }],
    ["an empty marker", { ...cleared, [WEBMCP_LIVE_GATE_ENV]: "" }]
  ])("stays closed with %s", (_label, env) => {
    expect(resolveWebMcpExecutionGate(env).live).toBe(false);
  });

  it("opens only with both explicit markers", () => {
    const gate = resolveWebMcpExecutionGate(cleared);
    expect(gate.live).toBe(true);
  });

  it("refuses to open in a production-like NODE_ENV", () => {
    const gate = resolveWebMcpExecutionGate(cleared, "webmcp_production");
    expect(gate.live).toBe(false);
    expect(gate.reason).toBe("production_requires_explicit_gate");
  });

  it("fails closed through both assertion helpers", () => {
    const gate = resolveWebMcpExecutionGate({});
    expectCode(() => assertWebMcpExecutionGate(gate), "webmcp_live_execution_gate_closed");
    expectCode(() => requireLiveWebMcpGate(gate), "webmcp_live_execution_gate_closed");
    expect(() => assertWebMcpExecutionGate(resolveWebMcpExecutionGate(cleared))).not.toThrow();
  });
});
