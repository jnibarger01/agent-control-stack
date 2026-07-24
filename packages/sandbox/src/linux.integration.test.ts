import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxAuthorityReceipt, SandboxAuthorityVerifier, SandboxExecutionRequest } from "./contracts.js";
import { createLinuxSandbox } from "./linux.js";

const runIntegration = process.env.ACS_SANDBOX_INTEGRATION === "1";

describe.runIf(runIntegration)("Bubblewrap Linux containment", () => {
  it("contains filesystem, environment, and network access in a real namespace", async () => {
    const fixture = createFixture();
    try {
      const externalCanary = join(fixture.parent, "outside-canary.txt");
      writeFileSync(externalCanary, "outside-secret", { mode: 0o600 });
      symlinkSync(externalCanary, join(fixture.workspace, "escape-link"));
      writeFixtureScript(
        fixture.workspace,
        `
          import { readFileSync } from "node:fs";
          import { connect } from "node:net";

          if (process.env.ACS_SANDBOX_PLANTED_SECRET) {
            throw new Error("parent secret reached sandbox");
          }

          let filesystemDenied = false;
          try {
            readFileSync("escape-link", "utf8");
          } catch {
            filesystemDenied = true;
          }
          if (!filesystemDenied) throw new Error("filesystem escape succeeded");

          await new Promise((resolve, reject) => {
            const socket = connect({ host: "1.1.1.1", port: 80 });
            socket.setTimeout(500);
            socket.once("connect", () => reject(new Error("network connection succeeded")));
            socket.once("error", () => resolve());
            socket.once("timeout", () => {
              socket.destroy();
              resolve();
            });
          });

          console.log("sandbox-contained");
        `
      );
      process.env.ACS_SANDBOX_PLANTED_SECRET = "canary";
      const request = fixtureRequest(fixture.workspace, "containment");
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result).toMatchObject({
        outcome: "exited",
        observedSuccess: true,
        cleanup: "verified",
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false
      });
      expect(result.stdout).toContain("sandbox-contained");
      expect(result.stdout).not.toContain("outside-secret");
      expect(result.stderr).not.toContain("canary");
    } finally {
      delete process.env.ACS_SANDBOX_PLANTED_SECRET;
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("caps aggregate output by exact bytes", async () => {
    const fixture = createFixture();
    try {
      writeFixtureScript(fixture.workspace, `process.stdout.write("x".repeat(64 * 1024));`);
      const request = fixtureRequest(fixture.workspace, "output", {
        limits: { ...defaultLimits(), outputBytes: 1_024 }
      });
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result.observedSuccess).toBe(true);
      expect(result.outputBytes).toBe(1_024);
      expect(Buffer.byteLength(`${result.stdout}${result.stderr}`, "utf8")).toBeLessThanOrEqual(1_024);
      expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("redacts secret-shaped process output before returning it", async () => {
    const fixture = createFixture();
    try {
      const canary = `sk-${"s".repeat(24)}`;
      writeFixtureScript(fixture.workspace, `console.log("OPENAI_API_KEY=${canary}");`);
      const request = fixtureRequest(fixture.workspace, "redaction");
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result.observedSuccess).toBe(true);
      expect(result.stdout).toBe("[redacted]");
      expect(result.stdout).not.toContain(canary);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("contains a symlink target that changes during execution", async () => {
    const fixture = createFixture();
    let raceTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const externalCanary = join(fixture.parent, "race-outside.txt");
      const safeFile = join(fixture.workspace, "race-safe.txt");
      const link = join(fixture.workspace, "race-link");
      writeFileSync(externalCanary, "outside-secret", { mode: 0o600 });
      writeFileSync(safeFile, "safe", { mode: 0o600 });
      symlinkSync("race-safe.txt", link);
      writeFixtureScript(
        fixture.workspace,
        `
          import { readFileSync } from "node:fs";
          for (let index = 0; index < 10000; index += 1) {
            try {
              const value = readFileSync("race-link", "utf8");
              if (value.includes("outside-secret")) throw new Error("TOCTOU escape succeeded");
            } catch (error) {
              if (error.message === "TOCTOU escape succeeded") throw error;
            }
          }
          console.log("race-contained");
        `
      );
      let outside = false;
      raceTimer = setInterval(() => {
        try {
          unlinkSync(link);
        } catch {
          // The link may already be absent between replacements.
        }
        symlinkSync(outside ? externalCanary : "race-safe.txt", link);
        outside = !outside;
      }, 1);

      const request = fixtureRequest(fixture.workspace, "symlink-race");
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result.observedSuccess).toBe(true);
      expect(result.stdout).toContain("race-contained");
      expect(result.stdout).not.toContain("outside-secret");
    } finally {
      if (raceTimer) clearInterval(raceTimer);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("kills the complete process tree on timeout", async () => {
    const fixture = createFixture();
    try {
      const marker = join(fixture.workspace, "escaped-child-marker");
      writeFixtureScript(
        fixture.workspace,
        `
          import { spawn } from "node:child_process";
          const child = spawn(process.execPath, [
            "-e",
            ${JSON.stringify(
              `const { writeFileSync } = require("node:fs"); setTimeout(() => writeFileSync("/workspace/escaped-child-marker", "escaped"), 1200);`
            )}
          ], { detached: true, stdio: "ignore" });
          child.unref();
          setInterval(() => {}, 1000);
        `
      );
      const request = fixtureRequest(fixture.workspace, "timeout", {
        limits: { ...defaultLimits(), wallClockMs: 300, terminationGraceMs: 100 }
      });
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result).toMatchObject({
        outcome: "timed_out",
        observedSuccess: false,
        cleanup: "verified"
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("cancels the complete process tree through the same cleanup path", async () => {
    const fixture = createFixture();
    try {
      writeFixtureScript(fixture.workspace, `setInterval(() => {}, 1000);`);
      const request = fixtureRequest(fixture.workspace, "cancel");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request, { signal: controller.signal });

      expect(result).toMatchObject({
        outcome: "cancelled",
        observedSuccess: false,
        cleanup: "verified"
      });
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("enforces the memory cgroup limit", async () => {
    const fixture = createFixture();
    try {
      writeFixtureScript(
        fixture.workspace,
        `
          const allocations = [];
          for (let index = 0; index < 32; index += 1) {
            allocations.push(Buffer.alloc(32 * 1024 * 1024, 1));
          }
          console.log(allocations.length);
        `
      );
      const request = fixtureRequest(fixture.workspace, "memory", {
        limits: { ...defaultLimits(), memoryBytes: 128 * 1_024 * 1_024 }
      });
      const result = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request)
      }).execute(request);

      expect(result.observedSuccess).toBe(false);
      expect(result.cleanup).toBe("verified");
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("enforces the PID cgroup limit", async () => {
    const fixture = createFixture();
    try {
      writeFixtureScript(
        fixture.workspace,
        `
          import { spawn } from "node:child_process";
          const children = [];
          let denied = false;
          for (let index = 0; index < 8; index += 1) {
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
              stdio: "ignore"
            });
            children.push(child);
            child.once("error", () => {
              denied = true;
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          for (const child of children) child.kill("SIGKILL");
          await new Promise((resolve) => setTimeout(resolve, 300));
          console.log(\`spawn-denied=\${denied}\`);
          process.exit(0);
        `
      );
      const controlRequest = fixtureRequest(fixture.workspace, "pids-control", {
        limits: { ...defaultLimits(), pids: 128 }
      });
      const control = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(controlRequest)
      }).execute(controlRequest);
      expect(control.observedSuccess).toBe(true);
      expect(control.stdout).toContain("spawn-denied=false");

      const limitedRequest = fixtureRequest(fixture.workspace, "pids-limited", {
        limits: { ...defaultLimits(), pids: 16, wallClockMs: 1_500 }
      });
      const limited = await createLinuxSandbox({
        authorityVerifier: fixtureAuthority(limitedRequest)
      }).execute(limitedRequest);

      expect(limited.cleanup).toBe("verified");
      expect(limited.observedSuccess ? limited.stdout.includes("spawn-denied=true") : true).toBe(true);
      expect(limited.observedSuccess || limited.outcome === "timed_out" || limited.exitCode !== 0).toBe(true);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("applies the exact CPU, memory, and PID controls to the live scope", async () => {
    const fixture = createFixture();
    const unitName = "acs-sandbox-resource-evidence.scope";
    try {
      writeFixtureScript(fixture.workspace, `await new Promise((resolve) => setTimeout(resolve, 1200));`);
      const request = fixtureRequest(fixture.workspace, "resources", {
        limits: {
          ...defaultLimits(),
          cpuQuotaPercent: 25,
          memoryBytes: 256 * 1_024 * 1_024,
          pids: 32
        }
      });
      const execution = createLinuxSandbox({
        authorityVerifier: fixtureAuthority(request),
        unitNameFactory: () => unitName
      }).execute(request);

      const properties = await waitForUnitProperties(unitName);
      expect(properties).toMatchObject({
        CPUQuotaPerSecUSec: "250ms",
        MemoryMax: String(request.limits.memoryBytes),
        TasksMax: String(request.limits.pids),
        ActiveState: "active"
      });

      const result = await execution;
      expect(result).toMatchObject({
        observedSuccess: true,
        cleanup: "verified",
        exitCode: 0
      });
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);
});

function createFixture(): { parent: string; workspace: string } {
  const parent = mkdtempSync(join(tmpdir(), "acs-sandbox-integration-"));
  const workspace = join(parent, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ private: true, type: "module", scripts: { test: "node test.mjs" } }, null, 2)}\n`
  );
  return { parent, workspace };
}

function writeFixtureScript(workspace: string, source: string): void {
  writeFileSync(join(workspace, "test.mjs"), `${source.trim()}\n`, { mode: 0o600 });
}

function fixtureRequest(
  workspace: string,
  suffix: string,
  overrides: Partial<SandboxExecutionRequest> = {}
): SandboxExecutionRequest {
  return {
    schemaVersion: "acs.sandbox-execution.v1",
    workItemId: `wrk_${suffix}`,
    attemptId: `attempt_${suffix}`,
    leaseId: `lease_${suffix}`,
    workerId: "worker_integration",
    fencingToken: 1,
    authorization: { kind: "action", hash: "a".repeat(64) },
    policyVersion: "policy-v1",
    auditCorrelationId: `evt_${suffix}_started`,
    idempotencyKey: `sandbox-${suffix}-1`,
    workspace: { allocationId: `workspace_${suffix}`, hostPath: workspace },
    commandProfile: "npm-test",
    cwd: ".",
    environment: { CI: "1", LANG: "C.UTF-8" },
    network: "none",
    limits: defaultLimits(),
    ...overrides
  };
}

function defaultLimits(): SandboxExecutionRequest["limits"] {
  return {
    wallClockMs: 10_000,
    terminationGraceMs: 500,
    cpuQuotaPercent: 100,
    memoryBytes: 512 * 1_024 * 1_024,
    pids: 64,
    outputBytes: 64 * 1_024,
    tmpfsBytes: 64 * 1_024 * 1_024
  };
}

function fixtureAuthority(request: SandboxExecutionRequest): SandboxAuthorityVerifier {
  const receipt: SandboxAuthorityReceipt = {
    schemaVersion: "acs.sandbox-authority-receipt.v1",
    workItemId: request.workItemId,
    attemptId: request.attemptId,
    leaseId: request.leaseId,
    workerId: request.workerId,
    fencingToken: request.fencingToken,
    authorizationHash: request.authorization.hash,
    policyVersion: request.policyVersion,
    workspaceAllocationId: request.workspace.allocationId,
    canonicalWorkspacePath: request.workspace.hostPath,
    executionEvent: { id: request.auditCorrelationId, sequence: 1, hash: "b".repeat(64) }
  };
  return { verify: async () => receipt };
}

async function waitForUnitProperties(unitName: string): Promise<Record<string, string>> {
  const deadline = Date.now() + 3_000;
  let lastError = "scope did not appear";
  while (Date.now() < deadline) {
    try {
      const output = execFileSync(
        "/usr/bin/systemctl",
        [
          "--user",
          "show",
          unitName,
          "-p",
          "CPUQuotaPerSecUSec",
          "-p",
          "MemoryMax",
          "-p",
          "TasksMax",
          "-p",
          "ActiveState"
        ],
        { encoding: "utf8", timeout: 1_000 }
      );
      const properties = Object.fromEntries(
        output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          })
      );
      if (properties.ActiveState === "active") return properties;
      lastError = `scope state was ${properties.ActiveState ?? "missing"}`;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error(`unable to inspect sandbox scope: ${lastError}`);
}
