import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexSwarmEngineAdapter, type CodexSwarmEngineConfig } from "./codex-swarm.js";
import type { BuildExecutionEnvelopeInput } from "./codex-swarm-envelope.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-swarm.mjs", import.meta.url));

function input(overrides: Partial<BuildExecutionEnvelopeInput> = {}): BuildExecutionEnvelopeInput {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    acsWorkItemId: "wrk_1",
    acsAttemptId: "attempt_1",
    planId: "plan_1",
    admittedPlanHash: "ab".repeat(32),
    leaseId: "lease_1",
    fencingEpoch: 3,
    auditCorrelationId: "evt_1",
    idempotencyKey: "idem_1",
    workspace: { allocationId: "ws_1", hostPath: "/tmp/acs-ws", expectedBaseSha: "a".repeat(40) },
    objective: "fixture objective",
    permittedPaths: ["src"],
    forbiddenPaths: [],
    permittedOwnerProfiles: ["codex"],
    maxLanes: 1,
    maxLoopIterations: 0,
    networkPolicy: "none",
    timeoutMs: 5_000,
    acceptanceCommands: [],
    validationCommands: [],
    evidenceRequirements: [],
    issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

const adapter = (mode: string, extra: Partial<CodexSwarmEngineConfig> = {}) =>
  new CodexSwarmEngineAdapter({
    command: [process.execPath, FAKE],
    env: { FAKE_SWARM_MODE: mode },
    readyTimeoutMs: 3_000,
    executeTimeoutMs: 2_000,
    killGraceMs: 300,
    ...extra
  });

function groupAlive(marker: string): boolean {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

describe("F4 Codex Swarm transport (ACS side)", () => {
  it("runs one attempt end to end and accepts only exactly-echoed evidence", async () => {
    const outcome = await adapter("ok").runAttempt(input());
    expect(outcome.status, JSON.stringify(outcome)).toBe("evidence");
    if (outcome.status !== "evidence") return;
    expect(outcome.evidence.acsAttemptId).toBe("attempt_1");
    expect(outcome.evidence.envelopeHash).toBe(outcome.envelope.envelopeHash);
    expect(outcome.reaped).toBe(true);
  });

  it("refuses evidence for another attempt or a stale fencing epoch", async () => {
    expect(await adapter("wrong-echo").runAttempt(input())).toMatchObject({ status: "refused", reason: "evidence_attempt_mismatch" });
    expect(await adapter("stale-epoch").runAttempt(input())).toMatchObject({ status: "refused", reason: "evidence_fencing_mismatch" });
  });

  it("never sends the secret on the wire or in the child environment", async () => {
    // The fixture refuses with secret_on_wire if a secret field arrives, and reports env exposure.
    expect(await adapter("env-leak-probe").runAttempt(input())).toMatchObject({
      status: "refused",
      reason: "swarm_refused: secret_not_in_env"
    });
  });

  it("refuses an expired envelope before starting any process", async () => {
    const outcome = await adapter("ok").runAttempt(
      input({ issuedAt: new Date(Date.now() - 20_000).toISOString(), expiresAt: new Date(Date.now() - 10_000).toISOString() })
    );
    expect(outcome).toMatchObject({ status: "refused", reason: "envelope_expired" });
  });

  it("treats no readiness, a readiness mismatch, a hang, a crash and garbage as unknown, never success", async () => {
    expect(await adapter("never-ready", { readyTimeoutMs: 400 }).runAttempt(input())).toMatchObject({ status: "unknown", reason: "ready_timeout" });
    expect(await adapter("ready-mismatch").runAttempt(input())).toMatchObject({ status: "unknown", reason: "ready_mismatch" });
    expect(await adapter("hang", { executeTimeoutMs: 300 }).runAttempt(input())).toMatchObject({ status: "unknown", reason: "timeout" });
    expect((await adapter("crash").runAttempt(input())).status).toBe("unknown");
    expect(await adapter("garbage").runAttempt(input())).toMatchObject({ status: "unknown", reason: "reply_not_json" });
  });

  it("kills and reaps the whole process group, including a SIGTERM-ignoring lane", async () => {
    const marker = "process.on('SIGTERM',()=>{});setInterval";
    const outcome = await adapter("ignore-sigterm").runAttempt(input());
    expect(outcome.status).toBe("evidence");
    expect(outcome.reaped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupAlive(marker)).toBe(false);
  });

  it("does not start in a non-ACS mode: the child refuses to run without SWARM_CONTROL_PLANE=acs", async () => {
    // The adapter always sets the mode; a reserved override is rejected at construction.
    expect(() => new CodexSwarmEngineAdapter({ command: [process.execPath, FAKE], env: { SWARM_CONTROL_PLANE: "operator" } })).toThrow();
  });

  it("rejects relative commands and secret-looking environment keys", () => {
    expect(() => new CodexSwarmEngineAdapter({ command: ["node", FAKE] })).toThrow(/absolute/u);
    expect(() => new CodexSwarmEngineAdapter({ command: [process.execPath], env: { OPENAI_API_KEY: "x" } })).toThrow();
  });

  it("serves the fence oracle: Swarm proceeds only while ACS says the attempt is current", async () => {
    const seen: number[] = [];
    const current = await adapter("fence-mutate", {
      fenceCheck: ({ fencingEpoch }) => (seen.push(fencingEpoch), true)
    }).runAttempt(input());
    expect(current.status).toBe("evidence");
    expect(seen).toEqual([3]);
    const revoked = await adapter("fence-mutate", { fenceCheck: () => false }).runAttempt(input());
    expect(revoked).toMatchObject({ status: "refused", reason: "swarm_refused: fence_lost" });
    // A forged epoch is answered "not current" without consulting ACS state.
    const forged = await adapter("fence-forged", { fenceCheck: () => true }).runAttempt(input());
    expect(forged).toMatchObject({ status: "refused", reason: "swarm_refused: fence_lost" });
    const throwing = await adapter("fence-mutate", {
      fenceCheck: () => {
        throw new Error("store unavailable");
      }
    }).runAttempt(input());
    expect(throwing).toMatchObject({ status: "refused", reason: "swarm_refused: fence_lost" });
  });

  it("honours cancellation as unknown", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const outcome = await adapter("hang", { executeTimeoutMs: 5_000 }).runAttempt(input(), controller.signal);
    expect(outcome).toMatchObject({ status: "unknown", reason: "cancelled" });
  });
});
