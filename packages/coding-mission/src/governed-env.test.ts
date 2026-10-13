import { describe, expect, it } from "vitest";
import { codingMissionPortsFromEnv } from "./default-runtime.js";

/**
 * Governed execution is how a deployment turns the dispatch authority gate on, so the switch itself is tested: exactly "1"
 * enables it, nothing else does, and the default runtime's executor is declared idempotent so recovery keeps working.
 */
const base = { ACS_GITHUB_TOKEN: "test-token", ACS_CODING_CHECKOUT_ROOT: "/tmp/acs-checkouts" };
const ports = (extra: Record<string, string | undefined> = {}) =>
  codingMissionPortsFromEnv({ ...base, ...extra }, { dbPath: "/tmp/acs-governed-env.db" })!;

describe("ACS_CODING_MISSION_GOVERNED", () => {
  it("enables governance only when it is exactly 1", () => {
    expect(ports({ ACS_CODING_MISSION_GOVERNED: "1" }).governance).toEqual({ mode: "enforce" });
  });

  it.each([undefined, "", "0", "true", "yes", "on", " 1", "1 ", "01", "2"])("leaves governance off for %j", (value) => {
    expect(ports({ ACS_CODING_MISSION_GOVERNED: value }).governance).toBeUndefined();
  });

  it("is unaffected by the other settings, and declares the default executor idempotent", () => {
    const configured = ports({ ACS_CODING_MISSION_GOVERNED: "1", ACS_CODING_NIMBLE_THRESHOLD: "0.5" });
    expect(configured.governance).toEqual({ mode: "enforce" });
    expect(configured.coder.idempotent).toBe(true);
  });
});
