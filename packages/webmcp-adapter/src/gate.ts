import { ControlStackError } from "@agent-control-stack/shared";
import { WebMcpError, WebMcpErrorCode } from "./contracts.js";

/**
 * WebMCP live-execution gate.
 *
 * The lane is architecturally complete but **operationally inert** until the
 * repository's live-execution release gate is explicitly cleared. Two
 * independent conditions must both hold before any browser is launched or any
 * tool is invoked:
 *
 *   1. `ACS_WEBMCP_LIVE=1`                              — the lane is switched on.
 *   2. `ACS_WEBMCP_LIVE_EXECUTION_GATE=cleared`         — a human has cleared
 *      `docs/releases/sandbox-real-execution-gate.md` for this execution mode.
 *
 * Everything else — unset, empty, misspelled, "true", "yes", partially
 * configured — resolves to closed. There is no default-on path and no
 * environment in which a missing marker is inferred from a present one.
 */

export const WEBMCP_LIVE_ENV = "ACS_WEBMCP_LIVE";
export const WEBMCP_LIVE_GATE_ENV = "ACS_WEBMCP_LIVE_EXECUTION_GATE";
export const WEBMCP_LIVE_ENABLED_VALUE = "1";
export const WEBMCP_GATE_CLEARED_VALUE = "cleared";

export type WebMcpGateClosedReason =
  | "lane_disabled"
  | "execution_gate_not_cleared"
  | "production_requires_explicit_gate";

export interface WebMcpExecutionGate {
  readonly live: boolean;
  readonly reason?: WebMcpGateClosedReason;
  readonly detail: string;
}

export type WebMcpEnvironment = Readonly<Record<string, string | undefined>>;

export function closedWebMcpGate(
  reason: WebMcpGateClosedReason = "lane_disabled",
  detail = "WebMCP live execution is disabled"
): WebMcpExecutionGate {
  return Object.freeze({ live: false, reason, detail });
}

/**
 * Resolve the gate. `nodeEnv` is passed explicitly (never read implicitly) so
 * production behaviour is testable and cannot be relaxed by ambient state.
 */
export function resolveWebMcpExecutionGate(
  env: WebMcpEnvironment,
  nodeEnv: string | undefined = undefined
): WebMcpExecutionGate {
  const enabled = env[WEBMCP_LIVE_ENV];
  const cleared = env[WEBMCP_LIVE_GATE_ENV];

  if (enabled !== WEBMCP_LIVE_ENABLED_VALUE) {
    return closedWebMcpGate(
      "lane_disabled",
      `${WEBMCP_LIVE_ENV} is not "${WEBMCP_LIVE_ENABLED_VALUE}"; the WebMCP lane stays inert`
    );
  }
  if (cleared !== WEBMCP_GATE_CLEARED_VALUE) {
    return closedWebMcpGate(
      "execution_gate_not_cleared",
      `${WEBMCP_LIVE_GATE_ENV} is not "${WEBMCP_GATE_CLEARED_VALUE}"; the live-execution release gate is not cleared`
    );
  }
  if (nodeEnv !== undefined && nodeEnv !== "test" && nodeEnv !== "development") {
    return closedWebMcpGate(
      "production_requires_explicit_gate",
      `WebMCP live execution is not permitted with NODE_ENV=${nodeEnv}`
    );
  }
  return Object.freeze({ live: true, detail: "WebMCP live execution gate is cleared" });
}

/** Fail-closed assertion used at the process boundary before any browser work. */
export function assertWebMcpExecutionGate(gate: WebMcpExecutionGate): void {
  if (gate.live) return;
  throw new ControlStackError(WebMcpErrorCode.GateClosed, gate.detail);
}

export function requireLiveWebMcpGate(gate: WebMcpExecutionGate): void {
  if (gate.live) return;
  throw new WebMcpError(WebMcpErrorCode.GateClosed, gate.detail);
}
