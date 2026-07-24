import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineIsolationAuthorityReceipt, EngineIsolationAuthorityVerifier, EngineIsolationRequest } from "./engine-contracts.js";
import { createEngineIsolation, type EngineRuntimeMount } from "./engine.js";

const runIntegration = process.env.ACS_SANDBOX_INTEGRATION === "1";

// The fixture uses the real Node.js binary as the "engine executable" (it
// is not under /usr, exactly like the real Codex/Claude CLIs in this dev
// environment - see ADR 0014) so it must be mounted the same way a real
// deployment's runtimeMounts would mount an engine's install directory.
function nodeRuntimeMounts(): EngineRuntimeMount[] {
  const runtimeRoot = realpathSync(dirname(dirname(process.execPath)));
  return [{ hostPath: runtimeRoot, sandboxPath: runtimeRoot }];
}

describe.runIf(runIntegration)("Engine isolation boundary (ADR 0014)", () => {
  let dest: { server: Server; port: number } | undefined;

  afterEach(async () => {
    if (dest) await new Promise<void>((resolvePromise) => dest?.server.close(() => resolvePromise()));
    dest = undefined;
  });

  async function startAllowedDestination(response: string): Promise<number> {
    return await new Promise((resolvePromise) => {
      const server = createServer((socket) => {
        socket.end(response);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        dest = { server, port };
        resolvePromise(port);
      });
    });
  }

  it("cannot read a file under the real host HOME, and gets a private empty HOME instead", async () => {
    const fixture = createFixture();
    try {
      const realHome = process.env.HOME;
      if (!realHome) throw new Error("test requires HOME to be set on the host");
      const hostSecretPath = join(realHome, `.acs-engine-isolation-canary-${process.pid}`);
      writeFileSync(hostSecretPath, "host-home-secret", { mode: 0o600 });
      try {
        writeScript(
          fixture.workspace,
          `
            import { readFileSync, readdirSync } from "node:fs";
            let reached = false;
            try {
              readFileSync(${JSON.stringify(hostSecretPath)}, "utf8");
              reached = true;
            } catch {}
            if (reached) throw new Error("host HOME file was reachable from inside the sandbox");
            if (process.env.HOME === ${JSON.stringify(realHome)}) {
              throw new Error("sandbox HOME env var points at the real host HOME");
            }
            const homeContents = readdirSync(process.env.HOME);
            if (homeContents.length !== 0) throw new Error("private HOME is not empty: " + homeContents.join(","));
            console.log("home-contained");
          `
        );
        const request = fixtureRequest(fixture.workspace, "home", [{ host: "127.0.0.1", port: 1 }]);
        const result = await createEngineIsolation({ authorityVerifier: fixtureAuthority(request), runtimeMounts: nodeRuntimeMounts() }).execute(request);

        expect(result).toMatchObject({ outcome: "exited", observedSuccess: true, cleanup: "verified", exitCode: 0 });
        expect(result.stdout).toContain("home-contained");
      } finally {
        rmSync(hostSecretPath, { force: true });
      }
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("cannot reach a destination outside the egress allowlist", async () => {
    const fixture = createFixture();
    try {
      const port = await startAllowedDestination("should-not-be-reached");
      writeScript(
        fixture.workspace,
        `
          import { connect } from "node:net";
          await new Promise((resolve, reject) => {
            const socket = connect({ host: "127.0.0.1", port: ${port} });
            socket.setTimeout(800);
            socket.once("connect", () => reject(new Error("disallowed destination was reachable")));
            socket.once("error", () => resolve());
            socket.once("timeout", () => { socket.destroy(); resolve(); });
          });
          console.log("egress-denied-as-expected");
        `
      );
      // Deliberately allowlist a different, unrelated port so the request
      // schema's non-empty allowlist requirement is satisfied without
      // actually permitting the destination under test.
      const request = fixtureRequest(fixture.workspace, "egress-deny", [{ host: "127.0.0.1", port: port + 1 }]);
      const result = await createEngineIsolation({ authorityVerifier: fixtureAuthority(request), runtimeMounts: nodeRuntimeMounts() }).execute(request);

      expect(result).toMatchObject({ outcome: "exited", observedSuccess: true, cleanup: "verified", exitCode: 0 });
      expect(result.stdout).toContain("egress-denied-as-expected");
      expect(result.egressAllowedCount).toBe(0);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("reaches an allowlisted destination only through the scoped-egress proxy", async () => {
    const fixture = createFixture();
    try {
      const port = await startAllowedDestination("allowed-dest-reached\n");
      writeScript(
        fixture.workspace,
        `
          import { connect } from "node:net";
          const proxyUrl = new URL(process.env.HTTPS_PROXY);
          const body = await new Promise((resolve, reject) => {
            const socket = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
            let buffer = "";
            socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
            socket.on("close", () => resolve(buffer));
            socket.on("error", reject);
            socket.write(\`CONNECT 127.0.0.1:${port} HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\n\\r\\n\`);
            setTimeout(() => socket.destroy(), 2000);
          });
          if (!body.includes("200 Connection Established")) throw new Error("proxy tunnel was not established: " + body);
          if (!body.includes("allowed-dest-reached")) throw new Error("allowed destination content was not relayed: " + body);
          console.log("egress-allowed-as-expected");
        `
      );
      const request = fixtureRequest(fixture.workspace, "egress-allow", [{ host: "127.0.0.1", port }]);
      const result = await createEngineIsolation({ authorityVerifier: fixtureAuthority(request), runtimeMounts: nodeRuntimeMounts() }).execute(request);

      expect(result).toMatchObject({ outcome: "exited", observedSuccess: true, cleanup: "verified", exitCode: 0 });
      expect(result.stdout).toContain("egress-allowed-as-expected");
      expect(result.egressAllowedCount).toBe(1);
      expect(result.egressDeniedCount).toBe(0);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("never leaks the injected credential value into captured output, only its name", async () => {
    const fixture = createFixture();
    try {
      writeScript(fixture.workspace, `console.log("ok - credential not echoed by this script");`);
      const request = fixtureRequest(fixture.workspace, "credential", [{ host: "127.0.0.1", port: 1 }], {
        credential: { envName: "ACS_TEST_CREDENTIAL", envValue: "super-secret-value-12345" }
      });
      const result = await createEngineIsolation({ authorityVerifier: fixtureAuthority(request), runtimeMounts: nodeRuntimeMounts() }).execute(request);

      expect(result.observedSuccess).toBe(true);
      expect(result.credentialInjected).toBe("ACS_TEST_CREDENTIAL");
      expect(result.stdout).not.toContain("super-secret-value-12345");
      expect(result.stderr).not.toContain("super-secret-value-12345");
      expect(JSON.stringify(result)).not.toContain("super-secret-value-12345");
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("kills the complete process tree, including the socat egress bridge, on timeout", async () => {
    const fixture = createFixture();
    try {
      const marker = join(fixture.workspace, "escaped-child-marker");
      writeScript(
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
      const request = fixtureRequest(fixture.workspace, "timeout", [{ host: "127.0.0.1", port: 1 }], {
        limits: { ...defaultLimits(), wallClockMs: 300, terminationGraceMs: 100 }
      });
      const result = await createEngineIsolation({ authorityVerifier: fixtureAuthority(request), runtimeMounts: nodeRuntimeMounts() }).execute(request);

      expect(result).toMatchObject({ outcome: "timed_out", observedSuccess: false, cleanup: "verified" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses to launch when the workspace does not match the authoritative allocation", async () => {
    const fixture = createFixture();
    try {
      writeScript(fixture.workspace, `console.log("should not run");`);
      const request = fixtureRequest(fixture.workspace, "mismatch", [{ host: "127.0.0.1", port: 1 }]);
      const wrongReceipt: EngineIsolationAuthorityVerifier = {
        verify: async () => ({
          schemaVersion: "acs.engine-isolation-authority-receipt.v1",
          workItemId: request.workItemId,
          attemptId: request.attemptId,
          leaseId: request.leaseId,
          workerId: request.workerId,
          fencingToken: request.fencingToken,
          authorizationHash: request.authorization.hash,
          policyVersion: request.policyVersion,
          workspaceAllocationId: request.workspace.allocationId,
          canonicalWorkspacePath: "/tmp/definitely-not-the-real-workspace",
          executionEvent: { id: request.auditCorrelationId, sequence: 1, hash: "b".repeat(64) }
        })
      };

      await expect(createEngineIsolation({ authorityVerifier: wrongReceipt }).execute(request)).rejects.toThrow(
        /workspace/i
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }, 20_000);
});

function createFixture(): { parent: string; workspace: string } {
  const parent = mkdtempSync(join(tmpdir(), "acs-engine-isolation-integration-"));
  const workspace = join(parent, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  return { parent, workspace };
}

function writeScript(workspace: string, source: string): void {
  writeFileSync(join(workspace, "script.mjs"), `${source.trim()}\n`, { mode: 0o600 });
}

function fixtureRequest(
  workspace: string,
  suffix: string,
  egressAllowlist: EngineIsolationRequest["egressAllowlist"],
  overrides: Partial<EngineIsolationRequest> = {}
): EngineIsolationRequest {
  return {
    schemaVersion: "acs.engine-isolation.v1",
    workItemId: `wrk_${suffix}`,
    attemptId: `attempt_${suffix}`,
    leaseId: `lease_${suffix}`,
    workerId: "worker_integration",
    fencingToken: 1,
    authorization: { kind: "action", hash: "a".repeat(64) },
    policyVersion: "policy-v1",
    auditCorrelationId: `evt_${suffix}_started`,
    idempotencyKey: `engine-${suffix}-1`,
    workspace: { allocationId: `workspace_${suffix}`, hostPath: workspace },
    engineId: "test-engine",
    executable: realpathSync(process.execPath),
    args: ["/workspace/script.mjs"],
    cwd: ".",
    network: "scoped-egress",
    egressAllowlist,
    limits: defaultLimits(),
    ...overrides
  };
}

function defaultLimits(): EngineIsolationRequest["limits"] {
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

function fixtureAuthority(request: EngineIsolationRequest): EngineIsolationAuthorityVerifier {
  const receipt: EngineIsolationAuthorityReceipt = {
    schemaVersion: "acs.engine-isolation-authority-receipt.v1",
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
