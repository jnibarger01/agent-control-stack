import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexSwarmEngineAdapter } from "./codex-swarm.js";

/**
 * Live cross-repo parity: the ACS adapter against the real Codex Swarm `swarm-acs-serve` build.
 *
 * Runs only when ACS_CODEX_SWARM_ACS_SERVE points at a built codex-swarm `dist/acs-serve.js`.
 * When it is unset this suite is reported as skipped. A skipped run is not evidence of parity;
 * record the pinned ACS and Swarm commits with every passing run.
 */
const serve = process.env.ACS_CODEX_SWARM_ACS_SERVE;
const live = serve !== undefined && existsSync(serve);

describe.skipIf(!live)("F4 live parity with codex-swarm swarm-acs-serve", () => {
  const input = () => ({
    acsWorkItemId: "wrk_parity",
    acsAttemptId: "attempt_parity",
    planId: "plan_parity",
    admittedPlanHash: "cd".repeat(32),
    leaseId: "lease_parity",
    fencingEpoch: 9,
    auditCorrelationId: "evt_parity",
    idempotencyKey: "idem_parity",
    workspace: { allocationId: "ws_parity", hostPath: "/tmp/acs-parity", expectedBaseSha: "b".repeat(40) },
    objective: "live parity check",
    permittedPaths: ["src"],
    forbiddenPaths: [".github"],
    permittedOwnerProfiles: ["codex"],
    maxLanes: 1,
    maxLoopIterations: 0,
    networkPolicy: "none",
    timeoutMs: 5_000,
    acceptanceCommands: [],
    validationCommands: [],
    evidenceRequirements: [],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  it("authenticates the ACS-signed envelope over acs/v1 and gets Swarm's fail-closed isolation refusal", async () => {
    const adapter = new CodexSwarmEngineAdapter({
      command: [process.execPath, serve!],
      readyTimeoutMs: 5_000,
      executeTimeoutMs: 5_000,
      killGraceMs: 500
    });
    const outcome = await adapter.runAttempt(input());
    // Reaching the handler proves readiness, attempt binding, envelope hash and MAC all matched
    // across repos; the refusal is Swarm declining to execute without the F5 isolation profile.
    expect(outcome).toEqual({ status: "refused", reason: "swarm_refused: isolation_profile_unavailable", reaped: true });
  });
});
