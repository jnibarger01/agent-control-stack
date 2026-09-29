/**
 * E2E 1 - MCP path (ADR 0019):
 *
 *   MCP client -> dc-mcp-gateway server.js (OAuth edge, ACS managed mode)
 *              -> ACS (/dc/runtime/bootstrap, /dc/capability/issue, approvals)
 *              -> ACS capability -> bridge.js -> Desktop Commander child validation
 *              -> executor -> result (and ACS result submission)
 *
 * Every hop is the real implementation. Rejections are asserted at the
 * boundary that owns them and, for every privileged rejection, by proving the
 * executor never touched the filesystem.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  E2E_ENABLED,
  EXECUTION_TOKEN,
  McpHttpClient,
  accessToken,
  desktopCommanderRuntimeId,
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

describe.skipIf(!E2E_ENABLED)(
  "E2E 1: MCP client -> gateway -> ACS -> DC child validation -> executor",
  { timeout: 60_000 },
  () => {
    let box: Sandbox;
    let acs: AcsHandle;
    let bridge: ServiceProcess;
    let edge: ServiceProcess & { origin: string };
    let client: McpHttpClient;

    beforeAll(async () => {
      requireDesktopCommanderBuild();
      box = sandbox("acs-dc-mcp-e2e-");
      acs = await startAcs(box, await desktopCommanderRuntimeId(box));
      bridge = await startBridge(box, acs);
      edge = await startEdge(box, acs, bridge);
      client = new McpHttpClient(`${edge.origin}/mcp`, () => ({ authorization: `Bearer ${accessToken(edge.origin)}` }));
    }, 60_000);

    afterAll(async () => {
      await client?.close();
      await edge?.stop();
      await bridge?.stop();
      await acs?.close();
      box?.cleanup();
    });

    it("initializes only after ACS attests the managed Desktop Commander runtime", async () => {
      const response = await client.initialize();
      expect(response.status, edge.output()).toBe(200);
      expect(response.body.result._meta.desktopCommanderMode).toBe("managed");
      expect(response.body.result._meta.acsRuntimeIdentity.runtimeId).toBe(acs.runtimeId);
    });

    it("executes a read with an ACS-issued capability that Desktop Commander verified", async () => {
      const file = join(box.workspace, "hello.txt");
      writeFileSync(file, "hello from the executor");
      const response = await client.call("read_file", { path: file });
      expect(response.status).toBe(200);
      const result = response.body.result;
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.content[0].text).toContain("hello from the executor");
      // DC's own verdict, not the gateway's.
      expect(result._meta.acsAuthorization).toMatchObject({
        mode: "managed",
        decision: "granted",
        toolName: "read_file"
      });
      const workItemId = result._meta.acsAuthorization.workItemId as string;
      // The bridge reports the canonical result back to ACS for that attempt.
      const detail = await waitFor(async () => {
        const item = await acs.workItem(workItemId);
        return item.workItem.status === "succeeded" ? item : undefined;
      });
      expect(detail.events.map((event) => event.name)).toContain("desktop_commander.capability_issued");
    });

    it("holds a mutation for human approval, executes nothing, then executes exactly the approved write", async () => {
      const target = join(box.workspace, "approved.txt");
      const args = { path: target, content: "approved content" };
      const held = await client.call("write_file", args);
      expect(held.status).toBe(200);
      expect(held.body.error).toMatchObject({
        code: -32002,
        data: {
          kind: "managed_authorization_required",
          acsCode: "require_approval",
          retryable: true
        }
      });
      expect(existsSync(target)).toBe(false);

      expect(await acs.approve(held.body.error.data.workItemId, held.body.error.data.actionHash)).toBe(200);
      const executed = await client.call("write_file", args);
      expect(executed.status).toBe(200);
      expect(executed.body.result.isError, JSON.stringify(executed.body)).toBeUndefined();
      expect(executed.body.result._meta.acsAuthorization.decision).toBe("granted");
      expect(readFileSync(target, "utf8")).toBe("approved content");
    });

    it("does not let an approval for one argument set authorize different arguments", async () => {
      const target = join(box.workspace, "other.txt");
      const held = await client.call("write_file", { path: target, content: "A" });
      expect(held.status).toBe(200);
      expect(held.body.error.code).toBe(-32002);
      expect(await acs.approve(held.body.error.data.workItemId, held.body.error.data.actionHash)).toBe(200);
      const different = await client.call("write_file", { path: target, content: "B" });
      expect(different.status).toBe(200);
      expect(different.body.error.code).toBe(-32002);
      expect(different.body.error.data.acsCode).toBe("require_approval");
      expect(existsSync(target)).toBe(false);
    });

    it("fails closed at ACS for unknown, unsupported, and out-of-containment requests", async () => {
      const unknown = await client.call("definitely_not_a_tool", {});
      expect(unknown.status).toBe(200);
      expect(unknown.body.error.code).toBe(-32001);
      expect(unknown.body.error.data.kind).toBe("managed_authorization_denied");

      const unsupported = await client.call("kill_process", { pid: 1 });
      expect(unsupported.status).toBe(200);
      expect(unsupported.body.error.code).toBe(-32001);

      const outside = await client.call("read_file", { path: "/etc/hostname" });
      expect(outside.status).toBe(200);
      expect(outside.body.error.code).toBe(-32001);
    });

    it("strips a client-forged capability: it never substitutes for ACS authorization", async () => {
      const target = join(box.workspace, "forged.txt");
      const forged = {
        payload: { toolName: "write_file", normalizedArguments: { path: target, content: "x" } },
        keyId: "e2e-capability-key",
        signature: "A".repeat(86)
      };
      const response = await client.call(
        "write_file",
        { path: target, content: "x" },
        { acsCapability: forged, capability: forged }
      );
      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(-32002);
      expect(response.body.error.data.acsCode).toBe("require_approval");
      expect(existsSync(target)).toBe(false);
    });

    it("rejects an unauthenticated caller at the edge before ACS or the executor", async () => {
      const anonymous = new McpHttpClient(`${edge.origin}/mcp`, () => ({}));
      const response = await anonymous.call("read_file", { path: join(box.workspace, "hello.txt") });
      expect(response.status).toBe(401);
    });

    it("rejects a forged gateway attestation at the bridge without forwarding", async () => {
      const direct = new McpHttpClient(`http://127.0.0.1:${bridge.port}/mcp`, () => ({
        "x-dc-agent": "attacker",
        "x-dc-attestation": `${Buffer.from(JSON.stringify({ sub: "attacker", exp: 9_999_999_999 })).toString("base64url")}.forged`
      }));
      const response = await direct.initialize();
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain("gateway attestation invalid");
      expect(EXECUTION_TOKEN.length).toBeGreaterThan(16);
    });
  }
);
