/**
 * E2E: Jace Commander read-only filesystem over the managed /jc/mcp lane,
 * through both interfaces:
 *
 *   MCP client  -> edge /jc/mcp -> ACS /jc/capability/issue -> jc bridge -> jace-commander serve
 *   jc CLI      -> (the same, as an MCP client of /jc/mcp)
 *
 * Every hop is the real implementation. Proves: tools/list is the manifest;
 * the bridge runs the monorepo build by default; CLI and MCP return the same
 * structured result from the same handler; ACS containment denials, approval
 * challenges and authority loss surface as stable CLI exit codes and JSON,
 * never as a crash; a refused call does not break a healthy MCP session.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jcToolNames } from "@agent-control-stack/jc-tool-manifest";
import { DC_ROOT, E2E_ENABLED, McpHttpClient, sandbox, type Sandbox, type ServiceProcess } from "../support/chain-harness.js";
import {
  jcAccessToken,
  requireJaceCommanderBuild,
  runJc,
  startJcAcs,
  startJcBridge,
  startJcEdge,
  type JcAcsHandle
} from "../support/jc-harness.js";

describe.skipIf(!E2E_ENABLED)("E2E JC-1: read-only filesystem via /jc/mcp (MCP + CLI)", { timeout: 90_000 }, () => {
  let box: Sandbox;
  let acs: JcAcsHandle;
  let bridge: ServiceProcess;
  let edge: ServiceProcess & { origin: string; jcUrl: string };
  let mcp: McpHttpClient;
  let cliEnv: Record<string, string>;
  let project: string;

  beforeAll(async () => {
    requireJaceCommanderBuild();
    box = sandbox("acs-jc-fs-e2e-");
    project = join(box.workspace, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"project"}\n');
    writeFileSync(
      join(project, "src", "verifier.ts"),
      `${Array.from({ length: 30 }, (_, i) => `// line ${i}`).join("\n")}\nexport class JcCapabilityVerifier {}\n`
    );
    writeFileSync(join(project, ".env"), "SECRET=do-not-read\n");
    acs = await startJcAcs(box, [box.workspace]);
    bridge = await startJcBridge(box, acs, [box.workspace]);
    edge = await startJcEdge(box, acs, bridge);
    mcp = new McpHttpClient(edge.jcUrl, () => ({ authorization: `Bearer ${jcAccessToken(edge.origin)}` }));
    cliEnv = {
      HOME: box.home,
      JC_STATE_DIR: join(box.home, ".jace-commander-cli"),
      JC_MCP_URL: edge.jcUrl,
      JC_MCP_TOKEN: jcAccessToken(edge.origin)
    };
  }, 90_000);

  afterAll(async () => {
    await mcp?.close();
    await edge?.stop();
    await bridge?.stop();
    await acs?.close().catch(() => undefined);
    box?.cleanup();
  });

  it("the jc bridge runs the monorepo's own Desktop Commander build by default (no legacy checkout)", async () => {
    const authority = (await (await fetch(`http://127.0.0.1:${bridge.port}/authority`)).json()) as {
      runtime: { dir: string; monorepoDefault: boolean };
    };
    expect(authority.runtime.monorepoDefault).toBe(true);
    expect(realpathSync(authority.runtime.dir)).toBe(realpathSync(DC_ROOT));
  });

  it("tools/list over /jc/mcp is exactly the canonical manifest", async () => {
    expect((await mcp.initialize()).status, edge.output()).toBe(200);
    const listed = await mcp.post({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} });
    const names = (listed.body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual([...jcToolNames()].sort());
    const cli = await runJc(["tools", "--remote", "--json"], cliEnv);
    expect(cli.code, cli.stderr).toBe(0);
    expect((cli.json() as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(names);
  });

  it("jc ls / stat / read / cat work against contained paths", async () => {
    const ls = await runJc(["ls", project, "--json"], cliEnv);
    expect(ls.code, ls.stderr).toBe(0);
    // .env is omitted entirely: credential files are not even named in listings.
    expect(ls.json().entries.map((entry: { path: string }) => entry.path)).toEqual(["package.json", "src"]);

    const human = await runJc(["ls", project, "--depth", "2"], cliEnv);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("src/verifier.ts");

    const stat = await runJc(["stat", join(project, "src", "verifier.ts"), "--json"], cliEnv);
    expect(stat.code, stat.stderr).toBe(0);
    expect(stat.json()).toMatchObject({ type: "file", lineCount: 31 });

    const read = await runJc(["read", join(project, "src", "verifier.ts"), "--offset", "30", "--length", "5", "--json"], cliEnv);
    expect(read.code, read.stderr).toBe(0);
    expect(read.json()).toMatchObject({ content: "export class JcCapabilityVerifier {}", totalLines: 31, hasMore: false });

    const cat = await runJc(["cat", join(project, "package.json")], cliEnv);
    expect(cat.code, cat.stderr).toBe(0);
    expect(cat.stdout.trim()).toBe('{"name":"project"}');
  });

  it("the CLI resolves relative paths against its own working directory before ACS signs them", async () => {
    const read = await runJc(["read", "src/verifier.ts", "--offset", "-1", "--json"], cliEnv, project);
    expect(read.code, read.stderr).toBe(0);
    expect(read.json().path).toBe(join(project, "src", "verifier.ts"));
  });

  it("CLI --json and a direct MCP tools/call return the same structured result (one handler)", async () => {
    const args = { path: join(project, "src", "verifier.ts"), offset: 0, length: 3 };
    const direct = await mcp.call("read_file", args);
    expect(direct.status).toBe(200);
    const cli = await runJc(["read", args.path, "--offset", "0", "--length", "3", "--json"], cliEnv);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.json()).toEqual(direct.body.result.structuredContent);
  });

  it("a path outside the ACS roots is DENIED by ACS (exit 3), nothing is read, and the MCP session stays healthy", async () => {
    const denied = await runJc(["read", "/etc/hostname", "--json"], cliEnv);
    expect(denied.code).toBe(3);
    expect(denied.json()).toMatchObject({ ok: false, kind: "managed_authorization_denied" });
    expect(denied.json().code).toMatch(/path_outside_allow_root/u);

    // Refused on the MCP path too: HTTP 503 today, a JSON-RPC error once the
    // edge carries PR #204's transport. Either way, not a tool result.
    const session = await mcp.call("read_file", { path: "/etc/hostname" });
    const refused = session.status !== 200 || session.body?.error !== undefined || session.body?.result?.isError === true;
    expect(refused).toBe(true);
    const after = await mcp.call("get_file_info", { path: join(project, "package.json") });
    expect(after.status).toBe(200);
    expect(after.body.result.structuredContent.type).toBe("file");
  });

  it("a credential file inside a root is denied (exit 3) and never read", async () => {
    const denied = await runJc(["cat", join(project, ".env"), "--json"], cliEnv);
    expect(denied.code).toBe(3);
    expect(denied.stdout).not.toContain("do-not-read");
    const human = await runJc(["cat", join(project, ".env")], cliEnv);
    expect(human.code).toBe(3);
    expect(human.stderr).toContain("DENIED by ACS");
  });

  it("privileged_exec from the CLI surfaces an ACS APPROVAL REQUIRED challenge (exit 4); nothing runs", async () => {
    const human = await runJc(["sudo", "--", "/usr/bin/id", "-u"], cliEnv);
    expect(human.code).toBe(4);
    expect(human.stderr).toContain("APPROVAL REQUIRED");
    expect(human.stderr).toMatch(/Work item: wrk_/u);
    const json = await runJc(["sudo", "--json", "--", "/usr/bin/id", "-u"], cliEnv);
    expect(json.code).toBe(4);
    expect(json.json()).toMatchObject({ ok: false, kind: "managed_authorization_required", retryable: true });
    expect(json.json().workItemId).toMatch(/^wrk_/u);
    expect(json.json().actionHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("invalid CLI arguments exit 2 without contacting the server", async () => {
    const bad = await runJc(["read", join(project, "package.json"), "--length", "many"], cliEnv);
    expect(bad.code).toBe(2);
    const missing = await runJc(["stat"], cliEnv);
    expect(missing.code).toBe(2);
  });

  it("no credential, or a token for the wrong audience, is NOT CONNECTED (exit 6)", async () => {
    const none = await runJc(["ls", project, "--json"], { ...cliEnv, JC_MCP_TOKEN: "" });
    expect(none.code).toBe(6);
    expect(none.json().kind).toBe("not_connected");
    const wrongAudience = await runJc(["ls", project], { ...cliEnv, JC_MCP_TOKEN: jcAccessToken(edge.origin, `${edge.origin}/mcp`) });
    expect(wrongAudience.code).toBe(6);
  });

  it("with ACS down, every call fails closed as AUTHORIZATION UNAVAILABLE (exit 5); nothing runs", async () => {
    await acs.close();
    const down = await runJc(["cat", join(project, "package.json"), "--json"], cliEnv);
    expect(down.code).toBe(5);
    expect(down.json().kind).toBe("managed_authorization_unavailable");
    expect(down.stdout).not.toContain('"name":"project"');
  });
});
