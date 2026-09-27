/**
 * E2E 2 - relay path (ADR 0019):
 *
 *   remote MCP client -> dc-relay /mcp (call_device_tool)
 *     -> durable call record -> device claim            [Supabase pipe: simulated]
 *     -> DC remote device (vendor DesktopCommanderIntegration, managed attach)
 *     -> dc-mcp-gateway edge -> ACS capability -> bridge
 *     -> Desktop Commander child validation -> executor
 *     -> device completes the call -> relay returns the result
 *
 * Real components: the relay server (apps/dc-relay, in-memory stores - the
 * relay's own production store is Supabase), the device's managed MCP client,
 * the edge, ACS, the bridge, and Desktop Commander. The ONLY simulated hop is
 * the Supabase Realtime/RPC pipe between relay and device: the test claims and
 * completes calls through the same store transitions the device RPCs perform
 * and executes them with DesktopCommanderIntegration.callClientTool, exactly as
 * src/remote-device/device.ts does. That pipe is transport; it carries no
 * authority. Authorization still happens at ACS and, finally, in Desktop
 * Commander.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DC_ROOT,
  E2E_ENABLED,
  REPO_ROOT,
  accessToken,
  desktopCommanderRuntimeId,
  requireDesktopCommanderBuild,
  sandbox,
  sleep,
  startAcs,
  startBridge,
  startEdge,
  type AcsHandle,
  type Sandbox,
  type ServiceProcess
} from "../support/chain-harness.js";

const USER = "33333333-3333-4333-8333-333333333333";
const DEVICE_SESSION = "device-auth-session";
const GENERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Integration {
  initialize(): Promise<void>;
  callClientTool(name: string, args: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<any>;
  shutdown(): Promise<void>;
}

describe.skipIf(!E2E_ENABLED)(
  "E2E 2: relay -> device -> gateway -> ACS -> DC child validation -> executor",
  { timeout: 60_000 },
  () => {
    let box: Sandbox;
    let acs: AcsHandle;
    let bridge: ServiceProcess;
    let edge: ServiceProcess & { origin: string };
    let relay: Server;
    let relayUrl: string;
    let store: any;
    let deviceId: string;
    let integration: Integration;
    let deviceLoop: Promise<void>;
    let stopping = false;
    let rpcId = 1;

    const callDeviceTool = async (toolName: string, args: Record<string, unknown>) => {
      const response = await fetch(`${relayUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer remote-user"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: { name: "call_device_tool", arguments: { device_id: deviceId, tool_name: toolName, arguments: args } }
        })
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    };

    beforeAll(async () => {
      requireDesktopCommanderBuild();
      box = sandbox("acs-dc-relay-e2e-");
      acs = await startAcs(box, await desktopCommanderRuntimeId(box));
      bridge = await startBridge(box, acs);
      edge = await startEdge(box, acs, bridge);

      // --- the relay (real server; Supabase adapters replaced by in-memory ones)
      const relayDist = (file: string) => pathToFileURL(join(REPO_ROOT, "apps/dc-relay/dist", file)).href;
      const { createControlPlaneServer } = await import(relayDist("server.js"));
      const { InMemoryPairingStore } = await import(relayDist("pairing-store.js"));
      const { ControlPlaneError, ControlPlaneService, InMemoryControlPlaneStore } = await import(
        relayDist("service.js")
      );
      store = new InMemoryControlPlaneStore();
      const service = new ControlPlaneService(store, { dispatchTimeoutMs: 30_000 });
      relay = createControlPlaneServer(
        {
          SUPABASE_URL: "https://relay-e2e.invalid",
          SUPABASE_PUBLISHABLE_KEY: "relay-e2e-publishable",
          SUPABASE_SECRET_KEY: "relay-e2e-server-only",
          DEVICE_OAUTH_CLIENT_ID: "relay-e2e-device-client",
          PAIRING_STATE_KEY: Buffer.alloc(32, 1).toString("base64"),
          PAIRING_CODE_KEY: Buffer.alloc(32, 2).toString("base64"),
          CONTROL_PLANE_URL: "https://relay-e2e.invalid"
        },
        {
          pairingStore: new InMemoryPairingStore(),
          // Supabase Auth is the relay's IdP; the relay only maps a session to a user.
          authenticate: async (req: { headers: Record<string, string> }) => {
            if (req.headers.authorization !== "Bearer remote-user")
              throw new ControlPlaneError("not_found", "not found");
            return {
              userId: USER,
              token: "remote-user",
              sessionId: "remote-mcp-session",
              clientId: "remote-mcp-client"
            };
          },
          serviceFor: () => service,
          mcp: { pollIntervalMs: 20, maxWaitMs: 30_000 },
          accessLog: () => undefined
        }
      );
      await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
      relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
      const device = await service.registerDevice(USER, {
        device_name: "relay-e2e-device",
        capabilities: { transport_broadcast_v1: true, tool_names: ["read_file", "write_file"] }
      });
      deviceId = device.id;
      await service.bindDeviceSession(USER, deviceId, DEVICE_SESSION);
      await service.setPresence(USER, deviceId, {
        present: true,
        transport: "broadcast_v1",
        localMcpReady: true,
        connectionGeneration: GENERATION
      });

      // --- the device: DC's managed client attached to the real edge
      const statePath = join(box.root, "device-oauth.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          clientInformation: { client_id: "relay-device-client" },
          tokens: {
            access_token: accessToken(edge.origin, "relay-device", "relay-device-client"),
            token_type: "Bearer"
          }
        })
      );
      process.env.DC_MANAGED_OAUTH_STATE_PATH = statePath;
      process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = "1";
      const module = (await import(
        pathToFileURL(join(DC_ROOT, "dist/remote-device/desktop-commander-integration.js")).href
      )) as { DesktopCommanderIntegration: new (standalone: boolean, url: string) => Integration };
      integration = new module.DesktopCommanderIntegration(false, `${edge.origin}/mcp`);
      await integration.initialize();

      // --- the simulated Supabase pipe: claim -> execute -> complete, like device.ts
      deviceLoop = (async () => {
        while (!stopping) {
          const pending = [...(store.calls as Map<string, any>).values()].filter(
            (call) => call.device_id === deviceId && call.status === "pending"
          );
          for (const call of pending) {
            const now = () => new Date().toISOString();
            if (!(await store.claimCall(USER, deviceId, call.id, DEVICE_SESSION, GENERATION, now()))) continue;
            try {
              const result = await integration.callClientTool(call.tool_name, call.tool_args, call.metadata);
              await store.completeCall(
                USER,
                deviceId,
                call.id,
                DEVICE_SESSION,
                GENERATION,
                "completed",
                result,
                null,
                now()
              );
            } catch (error) {
              await store.completeCall(
                USER,
                deviceId,
                call.id,
                DEVICE_SESSION,
                GENERATION,
                "failed",
                null,
                (error as Error).message,
                now()
              );
            }
          }
          await sleep(20);
        }
      })();
    }, 90_000);

    afterAll(async () => {
      stopping = true;
      await deviceLoop;
      await integration?.shutdown().catch(() => undefined);
      delete process.env.DC_MANAGED_OAUTH_STATE_PATH;
      await new Promise((resolve) => relay?.close(resolve));
      await edge?.stop();
      await bridge?.stop();
      await acs?.close();
      box?.cleanup();
    });

    it("executes a relayed read under an ACS capability that Desktop Commander verified", async () => {
      const file = join(box.workspace, "relayed.txt");
      writeFileSync(file, "read through the relay");
      const result = await callDeviceTool("read_file", { path: file });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.content[0].text).toContain("read through the relay");
    });

    it("holds a relayed mutation for ACS approval (nothing executes), then executes exactly the approved write", async () => {
      const target = join(box.workspace, "relayed-write.txt");
      const args = { path: target, content: "approved via relay" };
      const held = await callDeviceTool("write_file", args);
      expect(held.isError).toBe(true);
      expect(held.content[0].text).toContain("managed_authorization_required");
      expect(existsSync(target)).toBe(false);

      // Relay wrapper {call_id, status, error}; the device error embeds the edge's JSON body.
      const failure = JSON.parse(held.content[0].text) as { status: string; error: string };
      expect(failure.status).toBe("failed");
      const approval = JSON.parse(failure.error.slice(failure.error.indexOf("{")));
      expect(approval).toMatchObject({ error: "managed_authorization_required", code: "require_approval" });
      expect(await acs.approve(approval.workItemId, approval.actionHash)).toBe(200);
      const executed = await callDeviceTool("write_file", args);
      expect(executed.isError, JSON.stringify(executed)).not.toBe(true);
      expect(readFileSync(target, "utf8")).toBe("approved via relay");
    });

    it("gives a relay caller no way to smuggle authority in the arguments", async () => {
      const target = join(box.workspace, "smuggled.txt");
      const smuggled = await callDeviceTool("write_file", {
        path: target,
        content: "x",
        acsCapability: { payload: { toolName: "write_file" }, keyId: "k", signature: "s" }
      });
      expect(smuggled.isError).toBe(true);
      // ACS's strict schema rejects the unknown key before any capability exists.
      expect(smuggled.content[0].text).toContain("managed_authorization_unavailable");
      expect(existsSync(target)).toBe(false);
    });

    it("fails closed for tools ACS does not manage", async () => {
      const result = await callDeviceTool("kill_process", { pid: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/managed_authorization_unavailable|managed_tool_unsupported/u);
    });

    it("keeps the device session attached across relayed rejections", async () => {
      const file = join(box.workspace, "relayed-after-reject.txt");
      writeFileSync(file, `still attached ${randomUUID()}`);
      const result = await callDeviceTool("read_file", { path: file });
      expect(result.content[0].text).toContain("still attached");
      expect((edge.output().match(/initialize attested \+ proxied/gu) ?? []).length).toBe(1);
    });
  }
);
