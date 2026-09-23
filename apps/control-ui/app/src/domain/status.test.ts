import { describe, expect, it } from "vitest";
import type { RegistryAgentView } from "../api/types";
import {
  agentHealthMeta,
  agentLiveness,
  attemptStatusMeta,
  leaseStatusMeta,
  livenessMeta,
  needsAttention,
  riskMeta,
  workItemStatusMeta
} from "./status";

type AgentLike = Pick<RegistryAgentView, "effectiveStatus" | "isStale" | "lastHeartbeatAt">;
const agent = (over: Partial<AgentLike>): AgentLike => ({
  effectiveStatus: "AVAILABLE",
  isStale: false,
  lastHeartbeatAt: "2026-09-19T10:00:00.000Z",
  ...over
});

describe("status/risk badges", () => {
  it("maps every work-item status to a labelled tone (colour is never the only signal)", () => {
    const expected: Record<string, string> = {
      needs_approval: "warning",
      blocked: "danger",
      failed: "danger",
      quarantined: "danger",
      succeeded: "success",
      running: "info",
      cancelled: "muted",
      rejected: "muted",
      draft: "muted"
    };
    for (const [status, tone] of Object.entries(expected)) {
      const meta = workItemStatusMeta(status);
      expect(meta.tone).toBe(tone);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });
  it("falls back to a neutral humanised label for unknown values instead of throwing", () => {
    expect(workItemStatusMeta("some_new_state")).toEqual({ label: "Some new state", tone: "neutral" });
  });
  it("risk: low→success, medium→info, high→warning, critical→danger", () => {
    expect(["low", "medium", "high", "critical"].map((r) => riskMeta(r).tone)).toEqual([
      "success",
      "info",
      "warning",
      "danger"
    ]);
  });
  it("attempt and lease states", () => {
    expect(attemptStatusMeta("succeeded").tone).toBe("success");
    expect(attemptStatusMeta("quarantined").tone).toBe("danger");
    expect(attemptStatusMeta("pending").label).toBe("Queued");
    expect(leaseStatusMeta("active").tone).toBe("success");
    expect(leaseStatusMeta("revoked").tone).toBe("danger");
  });
  it("needsAttention covers approval, blocked, quarantined, failed, unknown only", () => {
    expect(["needs_approval", "blocked", "quarantined", "failed", "unknown"].every(needsAttention)).toBe(true);
    expect(["running", "succeeded", "approved", "draft", "cancelled"].some(needsAttention)).toBe(false);
  });
});

describe("agent liveness follows the gateway's heartbeat projection, never bare existence", () => {
  it("online requires a heartbeat AND a fresh (non-stale) available status", () => {
    expect(agentLiveness(agent({}))).toBe("online");
    expect(agentLiveness(agent({ effectiveStatus: "BUSY" }))).toBe("online");
    expect(agentLiveness(agent({ effectiveStatus: "DEGRADED" }))).toBe("online");
  });
  it("a registered agent with no heartbeat is unknown, not online", () => {
    expect(agentLiveness(agent({ lastHeartbeatAt: undefined, effectiveStatus: "AVAILABLE" }))).toBe("unknown");
    expect(agentLiveness(agent({ lastHeartbeatAt: undefined, effectiveStatus: "UNKNOWN" }))).toBe("unknown");
  });
  it("an expired heartbeat is stale, and an OFFLINE projection is offline", () => {
    expect(agentLiveness(agent({ isStale: true }))).toBe("stale");
    expect(agentLiveness(agent({ effectiveStatus: "OFFLINE", isStale: true }))).toBe("offline");
    expect(agentLiveness(agent({ lastHeartbeatAt: undefined, effectiveStatus: "OFFLINE" }))).toBe("offline");
  });
  it("labels and tones", () => {
    expect(livenessMeta("online")).toEqual({ label: "Online", tone: "success" });
    expect(livenessMeta("stale").tone).toBe("warning");
    expect(livenessMeta("unknown").label).toBe("Unknown");
  });
  it("health separates degraded/error/offline-with-error", () => {
    expect(agentHealthMeta({ effectiveStatus: "DEGRADED", lastError: undefined }).tone).toBe("warning");
    expect(agentHealthMeta({ effectiveStatus: "ERROR", lastError: "boom" }).tone).toBe("danger");
    expect(agentHealthMeta({ effectiveStatus: "OFFLINE", lastError: "boom" }).tone).toBe("danger");
    expect(agentHealthMeta({ effectiveStatus: "OFFLINE", lastError: undefined }).tone).toBe("muted");
    expect(agentHealthMeta({ effectiveStatus: "UNKNOWN", lastError: undefined }).tone).toBe("neutral");
  });
});
