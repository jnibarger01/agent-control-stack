/**
 * E2E: Jace Commander search, writes, processes, git and doctor over the
 * managed /jc/mcp lane. Every hop is the real implementation (see
 * support/jc-harness.ts). Proves: approval-gated tools do nothing until an
 * operator approves the exact arguments in ACS; containment and capability
 * refusals are structured; tool failures stay visible as tool results; a
 * disposable repository goes through git add -> commit -> push; and
 * `jace-commander doctor` reports the live chain as healthy.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jcMcpToolDescriptors, jcToolNames } from "@agent-control-stack/jc-tool-manifest";
import {
  E2E_ENABLED,
  McpHttpClient,
  sleep,
  sandbox,
  waitFor,
  type Sandbox,
  type ServiceProcess
} from "../support/chain-harness.js";
import {
  jcAccessToken,
  requireJaceCommanderBuild,
  runJc,
  startJcAcs,
  startJcBridge,
  startJcEdge,
  type JcAcsHandle
} from "../support/jc-harness.js";

type Call = Awaited<ReturnType<McpHttpClient["call"]>>;

describe.skipIf(!E2E_ENABLED)("E2E JC-2: writes, processes, git, doctor via /jc/mcp", { timeout: 120_000 }, () => {
  let box: Sandbox;
  let acs: JcAcsHandle;
  let bridge: ServiceProcess;
  let edge: ServiceProcess & { origin: string; jcUrl: string };
  let mcp: McpHttpClient;
  let cliEnv: Record<string, string>;
  let project: string;
  let repo: string;
  let remote: string;

  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: box.home }
    }).trim();

  function managedAuthorizationError(
    call: Call,
    expected: {
      jsonRpcCode: -32001 | -32002;
      kind: "managed_authorization_denied" | "managed_authorization_required";
      acsCode: string;
    }
  ): { workItemId?: string; actionHash?: string } {
    expect(call.status, JSON.stringify(call.body)).toBe(200);
    expect(call.body).toMatchObject({
      jsonrpc: "2.0",
      error: {
        code: expected.jsonRpcCode,
        data: { kind: expected.kind, acsCode: expected.acsCode }
      }
    });
    return call.body.error.data as { workItemId?: string; actionHash?: string };
  }

  /** Call; if ACS holds it for approval, approve the exact action as the operator and call again. */
  async function approved(tool: string, args: Record<string, unknown>): Promise<Call> {
    const held = await mcp.call(tool, args);
    const refusal = managedAuthorizationError(held, {
      jsonRpcCode: -32002,
      kind: "managed_authorization_required",
      acsCode: "require_approval"
    });
    expect(refusal.workItemId).toBeTypeOf("string");
    expect(refusal.actionHash).toBeTypeOf("string");
    expect(await acs.approve(refusal.workItemId!, refusal.actionHash!)).toBe(200);
    const executed = await mcp.call(tool, args);
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    return executed;
  }

  beforeAll(async () => {
    requireJaceCommanderBuild();
    box = sandbox("acs-jc-ops-e2e-");
    project = join(box.workspace, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "verifier.ts"), "export class JcCapabilityVerifier {}\n");
    repo = join(box.workspace, "repo");
    remote = join(box.workspace, "remote.git");
    mkdirSync(repo);
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    git(["init", "-b", "main"]);
    git(["config", "user.email", "jc-e2e@example.com"]);
    git(["config", "user.name", "JC E2E"]);
    git(["remote", "add", "origin", remote]);
    acs = await startJcAcs(box, [box.workspace]);
    bridge = await startJcBridge(box, acs, [box.workspace]);
    edge = await startJcEdge(box, acs, bridge);
    mcp = new McpHttpClient(edge.jcUrl, () => ({ authorization: `Bearer ${jcAccessToken(edge.origin)}` }));
    expect((await mcp.initialize()).status, edge.output()).toBe(200);
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

  it("live tools/list is exactly the manifest's descriptors (36 tools)", async () => {
    const listed = await mcp.post({ jsonrpc: "2.0", id: 901, method: "tools/list", params: {} });
    const tools = listed.body.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    expect(tools).toHaveLength(36);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...jcToolNames()].sort());
    const byName = <T extends { name: string }>(left: T, right: T) => left.name.localeCompare(right.name);
    expect(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort(byName)
    ).toEqual(jcMcpToolDescriptors().sort(byName));
  });

  it("start_search + get_more_search_results find content; /etc is denied by ACS", async () => {
    const started = await mcp.call("start_search", { path: project, pattern: "JcCapabilityVerifier", mode: "content" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const searchId = started.body.result.structuredContent.searchId as string;
    let results = (started.body.result.structuredContent.results ?? []) as Array<{ path: string }>;
    for (let attempt = 0; attempt < 20 && results.length === 0; attempt += 1) {
      const more = await mcp.call("get_more_search_results", { searchId });
      expect(more.status).toBe(200);
      results = [...results, ...(more.body.result.structuredContent.results as Array<{ path: string }>)];
      if (results.length === 0) await sleep(100);
    }
    expect(results.some((result) => result.path.endsWith("verifier.ts"))).toBe(true);
    const denied = await mcp.call("start_search", { path: "/etc", pattern: "root", mode: "content" });
    const refusal = managedAuthorizationError(denied, {
      jsonRpcCode: -32001,
      kind: "managed_authorization_denied",
      acsCode: "jace_commander_path_outside_allow_root"
    });
    expect(refusal.workItemId).toBeUndefined();
  });

  it("start_search never names or returns credential files, denied dirs, or symlink escapes (PR #212 B1)", async () => {
    // All values are fake. Before the fix these came back as search hits.
    const secrets = join(project, "secrets");
    mkdirSync(join(secrets, ".ssh"), { recursive: true });
    mkdirSync(join(secrets, ".aws"), { recursive: true });
    writeFileSync(join(secrets, ".env"), "API_TOKEN=FAKE_E2E_SECRET_ENV\n");
    writeFileSync(join(secrets, "credentials.json"), '{"secret":"FAKE_E2E_SECRET_CREDS"}\n');
    writeFileSync(join(secrets, ".ssh", "id_ed25519"), "FAKE_E2E_SECRET_SSH\n");
    writeFileSync(join(secrets, ".aws", "credentials"), "aws_secret_access_key = FAKE_E2E_SECRET_AWS\n");
    writeFileSync(join(secrets, "device-key.pem"), "FAKE_E2E_SECRET_PEM\n");
    const outside = join(box.home, "outside-roots");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loot.txt"), "FAKE_E2E_SECRET_OUTSIDE\n");
    symlinkSync(join(outside, "loot.txt"), join(secrets, "escape-file.txt"));
    symlinkSync(outside, join(secrets, "escape-dir"));
    writeFileSync(join(secrets, "ok.txt"), "FAKE_E2E_SECRET_NOT_REALLY_OK\n");

    const content = await mcp.call("start_search", {
      path: project,
      pattern: "FAKE_E2E_SECRET",
      mode: "content",
      limit: 100
    });
    expect(content.status, JSON.stringify(content.body)).toBe(200);
    const hits = content.body.result.structuredContent.results as Array<{ path: string; text?: string }>;
    expect(hits.map((hit) => hit.path)).toEqual([join(secrets, "ok.txt")]);

    const names = await mcp.call("start_search", { path: project, pattern: "*", mode: "filename", limit: 100 });
    expect(names.status, JSON.stringify(names.body)).toBe(200);
    const named = (names.body.result.structuredContent.results as Array<{ path: string }>).map((hit) => hit.path);
    for (const leaked of [
      ".env",
      "credentials.json",
      "id_ed25519",
      "credentials",
      "device-key.pem",
      "loot.txt",
      "escape-file.txt"
    ]) {
      expect(
        named.some((path) => path.endsWith(`/${leaked}`)),
        `${leaked} named in ${JSON.stringify(named)}`
      ).toBe(false);
    }
    expect(JSON.stringify(names.body)).not.toContain("FAKE_E2E_SECRET");
    expect(named).toContain(join(secrets, "ok.txt"));
  });

  it("write_file does nothing until the operator approves those exact arguments", async () => {
    const target = join(project, "approved.txt");
    const held = await mcp.call("write_file", { path: target, content: "approved content" });
    const heldRefusal = managedAuthorizationError(held, {
      jsonRpcCode: -32002,
      kind: "managed_authorization_required",
      acsCode: "require_approval"
    });
    expect(existsSync(target)).toBe(false);
    expect(await acs.approve(heldRefusal.workItemId!, heldRefusal.actionHash!)).toBe(200);
    const different = await mcp.call("write_file", { path: target, content: "something else" });
    managedAuthorizationError(different, {
      jsonRpcCode: -32002,
      kind: "managed_authorization_required",
      acsCode: "require_approval"
    });
    expect(existsSync(target)).toBe(false);
    const executed = await mcp.call("write_file", { path: target, content: "approved content" });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body.result.isError).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("approved content");
  });

  it("writes outside the roots are denied by ACS before any approval is requested", async () => {
    const outside = await mcp.call("write_file", { path: "/tmp/jc-e2e-outside.txt", content: "x" });
    managedAuthorizationError(outside, {
      jsonRpcCode: -32001,
      kind: "managed_authorization_denied",
      acsCode: "jace_commander_path_outside_allow_root"
    });
    expect(existsSync("/tmp/jc-e2e-outside.txt")).toBe(false);
  });

  it("releases the execution-admission permit when the governed call reaches its terminal result", async () => {
    // The permit is bound to the attempt and released only by the canonical
    // result the bridge reports back to ACS. If that reporting is missing the
    // permit is held for the whole lease and every later governed call on the
    // single JC executor queues behind it until it expires.
    const file = join(project, "permit-release.txt");
    writeFileSync(file, "permit release");
    expect((await acs.admission()).global).toMatchObject({ active: 0, queued: 0 });

    const read = await mcp.call("read_file", { path: file });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.result.content[0].text).toContain("permit release");

    await waitFor(async () => {
      const snapshot = await acs.admission();
      return snapshot.global.active === 0 && snapshot.global.queued === 0 ? true : undefined;
    });
  });

  it("JC itself refuses a call that arrives without, or with a forged, ACS capability", async () => {
    const direct = new McpHttpClient(`http://127.0.0.1:${bridge.port}/mcp`, () => ({}));
    try {
      expect((await direct.initialize()).status).toBe(200);
      const target = join(project, "bypass.txt");
      const missing = await direct.call("write_file", { path: target, content: "x" });
      expect(JSON.stringify(missing.body)).toMatch(/JC_CAPABILITY_MISSING/u);
      const forged = await direct.post({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: { path: target, content: "x" },
          _meta: {
            acsCapability: {
              payload: {
                version: "acs.jc.v1",
                toolName: "write_file",
                scopes: ["fs.write"],
                expiresAt: "2020-01-01T00:00:00Z"
              },
              keyId: "e2e-jc-key",
              signature: "A".repeat(86)
            }
          }
        }
      });
      expect(JSON.stringify(forged.body)).toMatch(/JC_CAPABILITY_/u);
      expect(existsSync(target)).toBe(false);
    } finally {
      await direct.close();
    }
  });

  it("start_process needs approval, then runs argv; a tool failure stays a visible tool result", async () => {
    const started = await approved("start_process", {
      argv: ["/bin/echo", "jc-e2e-process"],
      cwd: project,
      timeoutMs: 5000
    });
    expect(started.body.result.isError).toBeUndefined();
    const sessionId = started.body.result.structuredContent.sessionId as string;
    await sleep(300);
    const output = await mcp.call("read_process_output", { sessionId });
    expect(output.status).toBe(200);
    expect(output.body.result.structuredContent.stdout).toContain("jc-e2e-process");

    const missing = await mcp.call("read_process_output", { sessionId: "proc_does_not_exist" });
    expect(missing.status).toBe(200);
    expect(missing.body.result.isError).toBe(true);
    expect(missing.body.result.structuredContent.error.code).toBe("not_found");

    const shell = await approved("start_process", { argv: ["/bin/sh", "-c", "id"], cwd: project });
    expect(shell.body.result.isError).toBe(true);
    expect(shell.body.result.structuredContent.error.code).toBe("command_denied");
  });

  it("git add -> commit -> push a disposable repository through approvals", async () => {
    writeFileSync(join(repo, "README.md"), "# disposable\n");
    const status = await mcp.call("git_status", { repo });
    expect(status.status).toBe(200);
    expect(status.body.result.structuredContent.untracked).toContain("README.md");

    const added = await approved("git_add", { repo, paths: ["README.md"] });
    expect(added.body.result.isError, JSON.stringify(added.body)).toBeUndefined();
    const committed = await approved("git_commit", { repo, message: "docs: disposable readme" });
    expect(committed.body.result.isError, JSON.stringify(committed.body)).toBeUndefined();
    const head = committed.body.result.structuredContent.head as string;
    expect(head).toMatch(/^[a-f0-9]{40}$/u);

    const pushed = await approved("git_push", { repo, remote: "origin", expectedHead: head });
    expect(pushed.body.result.isError, JSON.stringify(pushed.body)).toBeUndefined();
    expect(pushed.body.result.structuredContent).toMatchObject({
      pushed: head,
      branch: "main",
      secretScan: { clean: true }
    });
    expect(git(["rev-parse", "refs/heads/main"], remote)).toBe(head);

    const cliLog = await runJc(["git", "log", "--repo", repo, "--json"], cliEnv);
    expect(cliLog.code, cliLog.stderr).toBe(0);
    expect(cliLog.json().commits[0].sha).toBe(head);
  });

  it("git_push of an unapproved commit is refused even after approval when HEAD moved", async () => {
    const stale = git(["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(["add", "later.txt"]);
    git(["commit", "-q", "-m", "later"]);
    const pushed = await approved("git_push", { repo, remote: "origin", expectedHead: stale });
    expect(pushed.body.result.isError).toBe(true);
    expect(pushed.body.result.structuredContent.error.code).toBe("head_moved");
    expect(git(["rev-parse", "refs/heads/main"], remote)).toBe(stale);
  });

  it("jace-commander doctor reports the live chain healthy", async () => {
    const doctor = await runJc(["doctor", "--json"], cliEnv);
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    const report = doctor.json();
    expect(report.ok).toBe(true);
    const client = Object.fromEntries(
      report.client.map((check: { name: string; ok: boolean }) => [check.name, check.ok])
    );
    expect(client).toMatchObject({
      "cli parity": true,
      "jc mcp endpoint": true,
      "tools/list drift": true,
      jc_doctor: true
    });
    const server = Object.fromEntries(
      report.server.checks.map((check: { name: string; ok: boolean }) => [check.name, check.ok])
    );
    expect(server).toMatchObject({ manifest: true, "capability verification": true, "bridge path": true, acs: true });
    expect(report.server.liveHandlerCount).toBe(36);
  });
});
