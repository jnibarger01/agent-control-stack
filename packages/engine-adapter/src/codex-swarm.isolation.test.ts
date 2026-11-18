import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexSwarmLaunch, createCodexSwarmSandboxLauncher } from "@agent-control-stack/sandbox";
import { CodexSwarmEngineAdapter } from "./codex-swarm.js";
import type { BuildExecutionEnvelopeInput } from "./codex-swarm-envelope.js";

/**
 * F5: adversarial checks for the codex-swarm-v1 host isolation profile, run in a real
 * systemd user scope + bubblewrap sandbox. Gated like the other host-sandbox suites
 * (ACS_SANDBOX_INTEGRATION=1); a skipped run is not evidence.
 */
const live = process.env.ACS_SANDBOX_INTEGRATION === "1";
const FIXTURES = realpathSync(fileURLToPath(new URL("./__fixtures__", import.meta.url)));
const NODE_ROOT = realpathSync(dirname(dirname(process.execPath)));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(mode: string, limits: Partial<{ pids: number; memoryBytes: number }> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-swarm-ws-")));
  const workspace = join(root, "attempt");
  mkdirSync(workspace);
  // A planted symlink that points at a real host file outside the workspace.
  const secretFile = join(root, "host-secret.txt");
  writeFileSync(secretFile, "host-only");
  symlinkSync(secretFile, join(workspace, "escape-link"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const launcher = createCodexSwarmSandboxLauncher({
    workspaceRoot: root,
    runtimeMounts: [
      { hostPath: NODE_ROOT, sandboxPath: "/opt/acs-node" },
      { hostPath: FIXTURES, sandboxPath: "/opt/acs-fixtures" }
    ],
    limits: { memoryBytes: limits.memoryBytes ?? 512 * 1024 ** 2, pids: limits.pids ?? 32, cpuQuotaPercent: 100, tmpfsBytes: 64 * 1024 ** 2, wallClockMs: 60_000 }
  });
  const nodeInside = "/opt/acs-node/" + process.execPath.slice(NODE_ROOT.length + 1);
  const adapter = new CodexSwarmEngineAdapter({
    command: [nodeInside, "/opt/acs-fixtures/fake-swarm.mjs"],
    env: { FAKE_SWARM_MODE: mode },
    launcher,
    requireIsolation: true,
    readyTimeoutMs: 15_000,
    executeTimeoutMs: 20_000,
    killGraceMs: 500
  });
  return { root, workspace, adapter };
}

function input(workspace: string, overrides: Partial<BuildExecutionEnvelopeInput> = {}): BuildExecutionEnvelopeInput {
  return {
    acsWorkItemId: "wrk_iso",
    acsAttemptId: "attempt_iso_" + Math.random().toString(36).slice(2, 10),
    planId: "plan_iso",
    admittedPlanHash: "ef".repeat(32),
    leaseId: "lease_iso",
    fencingEpoch: 1,
    auditCorrelationId: "evt_iso",
    idempotencyKey: "idem_iso",
    workspace: { allocationId: "ws_iso", hostPath: workspace, expectedBaseSha: "c".repeat(40) },
    objective: "isolation probe",
    permittedPaths: ["src"],
    forbiddenPaths: [],
    permittedOwnerProfiles: ["codex"],
    maxLanes: 1,
    maxLoopIterations: 0,
    networkPolicy: "none",
    timeoutMs: 30_000,
    acceptanceCommands: [],
    validationCommands: [],
    evidenceRequirements: [],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides
  };
}

describe("F5 codex-swarm-v1 profile (pure checks)", () => {
  it("refuses scoped egress, a workspace outside the root, and a symlinked workspace", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-swarm-root-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acs-swarm-out-")));
    mkdirSync(join(root, "ws"));
    symlinkSync(outside, join(root, "link"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const options = {
      workspaceRoot: root,
      runtimeMounts: [],
      limits: { memoryBytes: 1024 ** 3, pids: 64, cpuQuotaPercent: 100, tmpfsBytes: 1024 ** 2, wallClockMs: 1_000 }
    };
    const context = (workspaceHostPath: string, networkPolicy = "none") => ({
      attemptId: "a1",
      workspaceHostPath,
      networkPolicy,
      socketDir: root,
      socketName: "acs.sock",
      command: ["/usr/bin/true"],
      env: {}
    });
    expect(() => buildCodexSwarmLaunch(options, context(join(root, "ws"), "scoped-egress:" + "a".repeat(64)))).toThrow(/none/u);
    expect(() => buildCodexSwarmLaunch(options, context(outside))).toThrow(/outside/u);
    expect(() => buildCodexSwarmLaunch(options, context(join(root, "link")))).toThrow(/symlink/u);
    expect(() => buildCodexSwarmLaunch(options, context(root))).toThrow(/outside/u);
    const launch = buildCodexSwarmLaunch(options, context(join(root, "ws")));
    expect(launch.args).toEqual(expect.arrayContaining(["--unshare-net", "--clearenv", "--die-with-parent", `--property=TasksMax=64`]));
    expect(launch.args.join(" ")).not.toContain(homedir());
  });

  it("refuses to run Swarm without isolation when isolation is required", () => {
    expect(() => new CodexSwarmEngineAdapter({ command: ["/usr/bin/true"], requireIsolation: true })).toThrow(/isolation/u);
  });
});

describe.runIf(live)("F5 codex-swarm-v1 profile (live host sandbox, adversarial)", () => {
  it("contains the Swarm tree: no host home, no symlink escape, no network, no host env, no secret exposure, task quota enforced", async () => {
    const { workspace, adapter } = setup("sandbox-probe", { pids: 32 });
    const outcome = await adapter.runAttempt(input(workspace));
    expect(outcome.status, JSON.stringify(outcome)).toBe("evidence");
    expect(outcome.reaped).toBe(true);
    const probe = JSON.parse(readFileSync(join(workspace, "probe.json"), "utf8"));
    expect(probe).toMatchObject({
      hostHomeVisible: false,
      symlinkEscapeRead: false,
      writeOutsideWorkspace: false,
      hostEtcPasswdVisible: false,
      hostProcessesVisible: false,
      hostFdsInherited: [],
      tcpEgress: false,
      dnsResolution: false,
      secretInEnv: false,
      secretInCmdline: false
    });
    expect(probe.envKeys).toEqual(
      // PWD is set by bubblewrap's --chdir to the sandbox path; nothing else from the host survives --clearenv.
      ["ACS_SWARM_ATTEMPT_ID", "ACS_SWARM_SECRET_FD", "ACS_SWARM_SOCKET", "FAKE_SWARM_MODE", "HOME", "PATH", "PWD", "SWARM_CONTROL_PLANE", "TMPDIR"].sort()
    );
    expect(probe.pwd).toBe("/workspace");
    // 64 children were attempted under a 32-task scope limit.
    expect(probe.aliveChildrenUnderTaskLimit).toBeLessThan(32);
    // The probe could not write through to the host outside the workspace.
    expect(existsSync("/usr/acs-probe")).toBe(false);
  });

  it("kills the whole scope, including a SIGTERM-ignoring lane, and leaves no unit behind", async () => {
    const { workspace, adapter } = setup("ignore-sigterm");
    const attempt = input(workspace);
    const outcome = await adapter.runAttempt(attempt);
    expect(outcome.status).toBe("evidence");
    expect(outcome.reaped).toBe(true);
    const unit = "acs-swarm-" + attempt.acsAttemptId.replace(/[^A-Za-z0-9]/gu, "_") + ".scope";
    const active = (() => {
      try {
        return execFileSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).trim();
      } catch (error) {
        return String((error as { stdout?: string }).stdout ?? "").trim();
      }
    })();
    expect(active).not.toBe("active");
    const survivors = (() => {
      try {
        return execFileSync("pgrep", ["-f", "process.on('SIGTERM'"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    expect(survivors).toBe("");
  });
});
