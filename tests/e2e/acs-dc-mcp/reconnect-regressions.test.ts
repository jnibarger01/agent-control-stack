/**
 * E2E 3 - managed session / reconnect regressions (ADR 0019).
 *
 * Reproduces the failure class fixed on 2026-09-25/26 across
 * desktop-commander (fix/remote-device-managed-attach: single-flight attach,
 * request-scoped errors do not drop the session) and
 * desktop-commander-mcp-gateway (f09ba36: reuse the executor across fresh
 * bootstrap challenges; multiplexed downstream sessions). Assertions follow the
 * current implementation:
 *
 *  - bridge.js keeps exactly one Desktop Commander executor; every downstream
 *    session gets a fresh ACS challenge through that same executor;
 *  - an ACS or tool rejection is request-scoped: it neither closes the MCP
 *    session nor recycles the executor;
 *  - losing the executor fails its sessions closed; the bridge respawns one
 *    executor and a new session re-attests before any call executes;
 *  - the device-side managed client (DesktopCommanderIntegration) attaches
 *    once under concurrent initialize() calls and survives request-scoped authorization errors.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DC_ROOT,
  E2E_ENABLED,
  McpHttpClient,
  accessToken,
  attestedInitializes,
  bridgeAuthority,
  desktopCommanderRuntimeId,
  executorPid,
  requireDesktopCommanderBuild,
  sandbox,
  startAcs,
  startBridge,
  startEdge,
  waitFor,
  type AcsHandle,
  type Sandbox,
  type ServiceProcess
} from "../support/chain-harness.js";

describe.skipIf(!E2E_ENABLED)("E2E 3: managed session and reconnect regressions", { timeout: 60_000 }, () => {
  let box: Sandbox;
  let acs: AcsHandle;
  let bridge: ServiceProcess;
  let edge: ServiceProcess & { origin: string };
  const newClient = (sub = "e2e-user") =>
    new McpHttpClient(`${edge.origin}/mcp`, () => ({ authorization: `Bearer ${accessToken(edge.origin, sub)}` }));
  const workspaceFile = (name: string, content: string) => {
    const file = join(box.workspace, name);
    writeFileSync(file, content);
    return file;
  };

  beforeAll(async () => {
    requireDesktopCommanderBuild();
    box = sandbox("acs-dc-reconnect-e2e-");
    acs = await startAcs(box, await desktopCommanderRuntimeId(box));
    bridge = await startBridge(box, acs);
    edge = await startEdge(box, acs, bridge);
  }, 60_000);

  afterAll(async () => {
    await edge?.stop();
    await bridge?.stop();
    await acs?.close();
    box?.cleanup();
  });

  it("a request-scoped ACS rejection does not kill the managed session or recycle the executor", async () => {
    const client = newClient();
    const initialized = await waitFor(async () => {
      const attempt = await client.initialize();
      return attempt.status === 200 ? attempt : undefined;
    });
    expect(initialized.status).toBe(200);
    const session = client.session;
    const pid = executorPid(box);
    const before = await bridgeAuthority(bridge);

    const denied = await client.call("write_file", { path: join(box.workspace, "held.txt"), content: "x" });
    expect(denied.status).toBe(200);
    expect(denied.body.error).toMatchObject({
      code: -32002,
      data: { kind: "managed_authorization_required", acsCode: "require_approval", retryable: true }
    });
    const unsupported = await client.call("kill_process", { pid: 1 });
    expect(unsupported.status).toBe(200);
    expect(unsupported.body.error.code).toBe(-32001);
    const toolError = await client.call("read_file", { path: join(box.workspace, "does-not-exist.txt") });
    expect(toolError.status).toBe(200);

    const read = await client.call("read_file", { path: workspaceFile("after-reject.txt", "still usable") });
    expect(read.status).toBe(200);
    expect(read.body.result.content[0].text).toContain("still usable");
    expect(client.session).toBe(session);
    expect(executorPid(box)).toBe(pid);
    const after = await bridgeAuthority(bridge);
    expect(after.bridge.spawnCount).toBe(before.bridge.spawnCount);
    expect(after.bridge.sessionCount).toBe(before.bridge.sessionCount);
    await client.close();
  });

  it("concurrent session attaches fail closed (never half-attested), leak no bridge session, and succeed on retry", async () => {
    // ACS keeps ONE outstanding bootstrap challenge per runtime: issuing a new
    // challenge expires the pending ones (runtime-registry.ts). Truly
    // concurrent attaches therefore race; losers must fail closed with
    // runtime_bootstrap_rejected, and must not strand a bridge session.
    const pid = executorPid(box);
    const spawnCount = (await bridgeAuthority(bridge)).bridge.spawnCount;
    const clients = [newClient("user-a"), newClient("user-b"), newClient("user-c")];
    const inits = await Promise.all(clients.map((client) => client.initialize()));
    expect(inits.some((init) => init.status === 200)).toBe(true);
    for (const [index, init] of inits.entries()) {
      if (init.status === 200) continue;
      expect(init.status).toBe(503);
      expect(init.body).toMatchObject({
        error: "managed_authorization_unavailable",
        code: "runtime_bootstrap_rejected"
      });
      // Retrying sequentially attaches with a fresh challenge.
      const retried = await clients[index].initialize();
      expect(retried.status).toBe(200);
      inits[index] = retried;
    }
    const challenges = inits.map((init) => init.body.result._meta.acsRuntimeIdentity.challenge);
    expect(new Set(challenges).size).toBe(clients.length);
    expect((await bridgeAuthority(bridge)).bridge.sessionCount).toBe(clients.length);

    const files = clients.map((_, index) => workspaceFile(`concurrent-${index}.txt`, `payload-${index}`));
    const reads = await Promise.all(clients.map((client, index) => client.call("read_file", { path: files[index] })));
    reads.forEach((read, index) => {
      expect(read.status).toBe(200);
      expect(read.body.result.content[0].text).toContain(`payload-${index}`);
    });

    expect(executorPid(box)).toBe(pid);
    const authority = await bridgeAuthority(bridge);
    expect(authority.bridge.spawnCount).toBe(spawnCount);
    expect(authority.bridge.sessionCount).toBe(clients.length);
    await Promise.all(clients.map((client) => client.close()));
    await waitFor(async () => ((await bridgeAuthority(bridge)).bridge.sessionCount === 0 ? true : undefined));
  });

  it("reconnect after a session closes restores a usable, re-attested session without leaking sessions", async () => {
    const pid = executorPid(box);
    const attestedBefore = attestedInitializes(edge);
    for (let round = 0; round < 3; round++) {
      const client = newClient();
      expect((await client.initialize()).status).toBe(200);
      const read = await client.call("read_file", { path: workspaceFile(`reconnect-${round}.txt`, `round-${round}`) });
      expect(read.body.result.content[0].text).toContain(`round-${round}`);
      await client.close();
    }
    expect(attestedInitializes(edge) - attestedBefore).toBe(3);
    expect(executorPid(box)).toBe(pid);
    await waitFor(async () => ((await bridgeAuthority(bridge)).bridge.sessionCount === 0 ? true : undefined));
  });

  it("losing the executor fails its session closed; a replacement executor serves a re-attested session", async () => {
    const client = newClient();
    const init = await client.initialize();
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const oldPid = executorPid(box);
    const spawnCount = (await bridgeAuthority(bridge)).bridge.spawnCount;
    expect(oldPid).toBeGreaterThan(0);
    process.kill(oldPid!, "SIGKILL");

    // The bridge respawns; DC only takes over a dead holder's lease after its
    // 10s PID-reuse grace (executor-lock.ts), so recovery is bounded by that.
    await waitFor(async () => ((await bridgeAuthority(bridge)).bridge.spawnCount > spawnCount ? true : undefined));
    // The old session was failed closed with its executor.
    const stale = await client.call("read_file", { path: workspaceFile("stale.txt", "x") });
    expect(stale.status).not.toBe(200);

    const fresh = newClient();
    await waitFor(async () => {
      const attempt = await fresh.initialize();
      return attempt.status === 200 ? attempt : undefined;
    }, 30_000);
    const read = await fresh.call("read_file", { path: workspaceFile("after-respawn.txt", "respawned") });
    expect(read.body.result.content[0].text).toContain("respawned");
    const newPid = executorPid(box);
    expect(newPid).toBeGreaterThan(0);
    expect(newPid).not.toBe(oldPid);
    await fresh.close();
  });

  describe("device-side managed client (vendor/desktop-commander remote-device)", () => {
    type Integration = {
      initialize(): Promise<void>;
      callClientTool(name: string, args: Record<string, unknown>): Promise<any>;
      shutdown(): Promise<void>;
    };
    let integration: Integration;

    beforeAll(async () => {
      // Pre-seed the device's OAuth state with a token from the edge's own AS
      // (the interactive consent flow is not what these tests exercise).
      const statePath = join(box.root, "device-oauth.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          clientInformation: { client_id: "e2e-device-client" },
          tokens: { access_token: accessToken(edge.origin, "device-user", "e2e-device-client"), token_type: "Bearer" }
        })
      );
      process.env.DC_MANAGED_OAUTH_STATE_PATH = statePath;
      process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = "1";
      const module = (await import(
        pathToFileURL(join(DC_ROOT, "dist/remote-device/desktop-commander-integration.js")).href
      )) as { DesktopCommanderIntegration: new (standalone: boolean, url: string) => Integration };
      integration = new module.DesktopCommanderIntegration(false, `${edge.origin}/mcp`);
    });

    afterAll(async () => {
      await integration?.shutdown().catch(() => undefined);
      delete process.env.DC_MANAGED_OAUTH_STATE_PATH;
    });

    it("concurrent initialize() calls attach exactly one managed session", async () => {
      const attestedBefore = attestedInitializes(edge);
      await Promise.all([integration.initialize(), integration.initialize(), integration.initialize()]);
      expect(attestedInitializes(edge) - attestedBefore).toBe(1);
      const read = await integration.callClientTool("read_file", { path: workspaceFile("device.txt", "device read") });
      expect(read.content[0].text).toContain("device read");
    });

    it("a request-scoped authorization error becomes a tool error without dropping the attached session", async () => {
      const attestedBefore = attestedInitializes(edge);
      const held = await integration.callClientTool("write_file", {
        path: join(box.workspace, "device-held.txt"),
        content: "x"
      });
      expect(held.isError).toBe(true);
      expect(held.content[0].text).toContain("ACS approval required");
      expect(held.structuredContent).toMatchObject({
        kind: "managed_authorization_required",
        acsCode: "require_approval",
        retryable: true
      });
      const read = await integration.callClientTool("read_file", {
        path: workspaceFile("device-after-jsonrpc-error.txt", "session survived")
      });
      expect(read.content[0].text).toContain("session survived");
      expect(attestedInitializes(edge)).toBe(attestedBefore);
    });
  });
});
