/**
 * E2E JC-3: native Jace Commander under real, authenticated ACS authority.
 *
 *   MCP client --OAuth--> edge (server.js) --issuance--> ACS (real gateway, SQLite, acs.jc.v1)
 *              --attested--> [interceptor] --> bridge.js --stdio--> apps/jace-commander (sandboxed workloads)
 *              --result--> ACS (audited outcome)
 *
 * The interceptor sits between the edge and the bridge so a test can act in
 * the window AFTER ACS issued a capability and BEFORE JC executes it
 * (revocation, lease expiry) and can capture an issued envelope (replay).
 * Proves: approved shell execution runs sandboxed and is reported back to ACS;
 * unapproved calls never run; post-issuance revocation and lease expiry are
 * refused by JC's live authority check; a replayed capability is refused; one
 * principal cannot see or touch another's process session.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  E2E_ENABLED,
  EXECUTION_TOKEN,
  McpHttpClient,
  sandbox,
  waitFor,
  type Sandbox,
  type ServiceProcess
} from "../support/chain-harness.js";
import {
  JC_AUTHORITY_READ_TOKEN,
  JC_BRIDGE_WORKER_TOKEN,
  jcAccessToken,
  requireJaceCommanderBuild,
  startJcAcs,
  startJcBridge,
  startJcEdge,
  type JcAcsHandle
} from "../support/jc-harness.js";

type Call = Awaited<ReturnType<McpHttpClient["call"]>>;
type Hold = { tool: string; before: (body: Record<string, any>) => Promise<void> };

/** Transparent HTTP proxy edge -> bridge that can hold or capture one governed tools/call. */
function startInterceptor(target: number) {
  let hold: Hold | undefined;
  const captured: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      let parsed: Record<string, any> | undefined;
      try {
        parsed = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
      } catch {
        parsed = undefined;
      }
      if (parsed?.method === "tools/call" && parsed.params?._meta?.acsCapability) {
        captured.push(structuredClone(parsed));
        if (hold && parsed.params.name === hold.tool) {
          const current = hold;
          hold = undefined;
          try {
            await current.before(parsed);
          } catch (error) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end(`interceptor hook failed: ${String(error)}`);
            return;
          }
        }
      }
      // The body is re-sent whole: drop the edge's chunked framing before setting a length.
      const { "transfer-encoding": _framing, ...rest } = req.headers;
      const headers = { ...rest, host: `127.0.0.1:${target}`, "content-length": String(raw.length) };
      const upstream = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers }, (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(raw);
    });
  });
  return {
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))),
    holdNext: (next: Hold) => {
      hold = next;
    },
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function attestedHeaders(sub: string) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub, client_id: "e2e-replay", jti: `j-${iat}-${Math.random()}`, iat, exp: iat + 60 })).toString("base64url");
  const signature = createHmac("sha256", EXECUTION_TOKEN).update(payload).digest("base64url");
  return { "x-dc-agent": sub, "x-dc-attestation": `${payload}.${signature}` };
}

interface Stack {
  box: Sandbox;
  acs: JcAcsHandle;
  bridge: ServiceProcess;
  edge: ServiceProcess & { origin: string; jcUrl: string };
  interceptor: ReturnType<typeof startInterceptor>;
  alice: McpHttpClient;
  bob: McpHttpClient;
  project: string;
  stop(): Promise<void>;
}

/** A complete, independent chain: real ACS, edge, interceptor, bridge, native JC. */
async function startStack(prefix: string, options: { authorityToken?: string | null } = {}): Promise<Stack> {
  const box = sandbox(prefix);
  const project = join(box.workspace, "project");
  mkdirSync(project, { recursive: true });
  const acs = await startJcAcs(box, [box.workspace]);
  const bridge = await startJcBridge(box, acs, [box.workspace], { authorityToken: options.authorityToken });
  const interceptor = startInterceptor(bridge.port);
  const port = await interceptor.listen();
  const edge = await startJcEdge(box, acs, { ...bridge, port });
  const alice = new McpHttpClient(edge.jcUrl, () => ({ authorization: `Bearer ${jcAccessToken(edge.origin, undefined, "alice")}` }));
  const bob = new McpHttpClient(edge.jcUrl, () => ({ authorization: `Bearer ${jcAccessToken(edge.origin, undefined, "bob")}` }));
  for (const client of [alice, bob]) {
    const init = await client.initialize();
    expect(init.status, `${JSON.stringify(init.body)}\n${bridge.output()}`).toBe(200);
  }
  return {
    box, acs, bridge, edge, interceptor, alice, bob, project,
    async stop() {
      await alice.close();
      await bob.close();
      await edge.stop();
      await interceptor.close();
      await bridge.stop();
      await acs.close().catch(() => undefined);
      box.cleanup();
    }
  };
}

function heldForApproval(call: Call): { workItemId: string; actionHash: string } {
  expect(call.status, JSON.stringify(call.body)).toBe(200);
  expect(call.body.error?.data?.acsCode, JSON.stringify(call.body)).toBe("require_approval");
  return call.body.error.data as { workItemId: string; actionHash: string };
}

/** Ask, have the operator approve that exact action in ACS, ask again. */
async function approved(stack: Stack, client: McpHttpClient, tool: string, args: Record<string, unknown>) {
  const held = heldForApproval(await client.call(tool, args));
  expect(await stack.acs.approve(held.workItemId, held.actionHash)).toBe(200);
  return { workItemId: held.workItemId, call: await client.call(tool, args) };
}

/**
 * Put the live lease into the state ACS's own lifecycle produces. This edits
 * ACS's database directly (the admission permit is left for ACS to recover),
 * so each such scenario runs on its own stack.
 */
function setLease(stack: Stack, workItemId: string, change: "revoked" | "expired") {
  const db = new DatabaseSync(join(stack.box.root, "acs-jc.db"));
  try {
    const sql = change === "revoked"
      ? "UPDATE attempt_leases SET status = 'revoked', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_item_id = ? AND status = 'active'"
      // ACS's lease reconciler transition (expires_at itself is an immutable binding).
      : "UPDATE attempt_leases SET status = 'expired', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_item_id = ? AND status = 'active'";
    expect(db.prepare(sql).run(workItemId).changes).toBe(1);
  } finally {
    db.close();
  }
}

/** The governed call is held after ACS issued its capability, the lease changes, then it reaches JC. */
async function refusedAfterIssuance(change: "revoked" | "expired", reason: RegExp) {
  const stack = await startStack(`acs-jc-${change}-e2e-`);
  try {
    const marker = join(stack.project, `${change}.txt`);
    const args = { command: `touch ${marker}`, cwd: stack.project, waitMs: 5000 };
    const held = heldForApproval(await stack.alice.call("run_command", args));
    expect(await stack.acs.approve(held.workItemId, held.actionHash)).toBe(200);
    stack.interceptor.holdNext({ tool: "run_command", before: async () => setLease(stack, held.workItemId, change) });
    const refused = await stack.alice.call("run_command", args);
    expect(refused.body.result?.isError, JSON.stringify(refused.body)).toBe(true);
    expect(refused.body.result.structuredContent.error.code).toBe("JC_AUTHORITY_REVOKED");
    expect(refused.body.result.structuredContent.error.message).toMatch(reason);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await stack.stop();
  }
}

describe.skipIf(!E2E_ENABLED)("E2E JC-3: native JC under authenticated ACS authority", { timeout: 180_000 }, () => {
  let stack: Stack;
  const operatorRead = async (path: string) =>
    (await fetch(`${stack.acs.url}${path}`, { headers: { authorization: "Bearer e2e-jc-operator-token" } })).json() as Promise<any>;

  beforeAll(async () => {
    requireJaceCommanderBuild();
    stack = await startStack("acs-jc-native-e2e-");
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it("an unapproved run_command never runs; the approved one runs sandboxed and ACS records the outcome", async () => {
    const { alice, project, acs } = stack;
    const marker = join(project, "ran.txt");
    const args = {
      command: `echo native > ${marker}; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${EXECUTION_TOKEN}'; echo pids=$(ls /proc | grep -c '^[0-9]')`,
      cwd: project,
      waitMs: 10_000
    };
    const held = heldForApproval(await alice.call("run_command", args));
    expect(existsSync(marker)).toBe(false);
    expect(await acs.approve(held.workItemId, held.actionHash)).toBe(200);
    const executed = await alice.call("run_command", args);
    expect(executed.body.result?.isError, JSON.stringify(executed.body)).toBeUndefined();
    const out = executed.body.result.structuredContent;
    expect(out.exitCode).toBe(0);
    // The workload ran, and could not see the bridge's execution token in any environ.
    expect(existsSync(marker)).toBe(true);
    expect(out.stdout).toMatch(/^0\n/);
    expect(Number(/pids=(\d+)/.exec(out.stdout)?.[1])).toBeLessThanOrEqual(6);

    // Audited outcome: the terminal result reached ACS, bound to the lease and the JC worker.
    const item = await waitFor(async () => {
      const current = await operatorRead(`/work-items/${held.workItemId}`);
      return current.workItem.status !== "running" ? current : undefined;
    });
    expect(item.workItem.status).toBe("succeeded");
    expect(item.workItem.requesterSubject).toBe("chatgpt:alice");
    const accepted = (item.events as Array<{ name: string; attributes: Record<string, string>; body: any }>)
      .find((event) => event.name === "execution_result.accepted");
    expect(accepted, JSON.stringify(item.events.map((event: { name: string }) => event.name))).toBeDefined();
    expect(accepted!.attributes["worker.id"]).toBe("acs-jc-bridge");
    expect(accepted!.attributes["execution.outcome"]).toBe("succeeded");
    expect(accepted!.body.simulationMetadata).toMatchObject({ executionMode: "jace_commander", simulated: false, toolName: "run_command" });
  });

  it("a captured capability cannot be replayed, even by an attested caller", async () => {
    const { alice, project, interceptor, bridge } = stack;
    const marker = join(project, "replay.txt");
    const args = { command: `echo x >> ${marker}`, cwd: project, waitMs: 5000 };
    const first = await approved(stack, alice, "run_command", args);
    expect(first.call.body.result?.isError, JSON.stringify(first.call.body)).toBeUndefined();
    const envelope = interceptor.captured.filter((body) => body.params.name === "run_command").at(-1)!;
    const direct = new McpHttpClient(`http://127.0.0.1:${bridge.port}/mcp`, () => attestedHeaders("alice"));
    try {
      expect((await direct.initialize()).status).toBe(200);
      const replay = await direct.post({ ...envelope, id: 4242 });
      expect(JSON.stringify(replay.body)).toMatch(/JC_CAPABILITY_NONCE_REPLAY/);
    } finally {
      await direct.close();
    }
    expect(readFileSync(marker, "utf8")).toBe("x\n");
  });

  it("principals are isolated: bob cannot list, read or write to alice's session", async () => {
    const { alice, bob, project } = stack;
    const started = await approved(stack, alice, "run_command", { command: "sleep 20", cwd: project, waitMs: 0 });
    const sessionId = started.call.body.result.structuredContent.sessionId as string;
    expect(sessionId).toMatch(/^proc_/);
    expect(JSON.stringify((await alice.call("list_processes", {})).body)).toContain(sessionId);
    expect(JSON.stringify((await bob.call("list_processes", {})).body)).not.toContain(sessionId);
    const bobRead = await bob.call("read_process_output", { sessionId });
    expect(bobRead.body.result.structuredContent.error.code).toBe("not_found");
    const bobInput = await approved(stack, bob, "interact_with_process", { sessionId, input: "echo hijack\n" });
    expect(bobInput.call.body.result.isError, JSON.stringify(bobInput.call.body)).toBe(true);
    expect(bobInput.call.body.result.structuredContent.error.code).toBe("not_found");
    const killed = await approved(stack, alice, "kill_process", { sessionId });
    expect(killed.call.body.result.isError, JSON.stringify(killed.call.body)).toBeUndefined();
  });

  it("JC's authority token is acs:read only: ACS lets it read the work item and refuses every mutation", async () => {
    const { alice, project, acs } = stack;
    const held = heldForApproval(await alice.call("run_command", { command: "true", cwd: project }));
    const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    const read = await fetch(`${acs.url}/work-items/${held.workItemId}`, { headers: as(JC_AUTHORITY_READ_TOKEN) });
    expect(read.status).toBe(200);
    const attempts = [
      ["approve", `/work-items/${held.workItemId}/approve`, { actionHash: held.actionHash, reason: "self-approval attempt" }],
      ["issue a capability", "/jc/capability/issue", { tool: "run_command", arguments: { command: "true", cwd: project } }],
      ["submit a result", `/work-items/${held.workItemId}/results`, { outcome: "succeeded" }],
      ["create a work item", "/work-items", { title: "x", intent: "x", target: {} }]
    ] as const;
    for (const [what, path, body] of attempts) {
      const response = await fetch(`${acs.url}${path}`, { method: "POST", headers: as(JC_AUTHORITY_READ_TOKEN), body: JSON.stringify(body) });
      expect([401, 403], `the read-only authority token could ${what} (HTTP ${response.status})`).toContain(response.status);
    }
    // The approve attempt above did not approve anything: it still needs the operator.
    expect((await operatorRead(`/work-items/${held.workItemId}`)).workItem.status).not.toBe("running");
    // Distinct tokens: the worker token is never JC's authority token.
    expect(JC_AUTHORITY_READ_TOKEN).not.toBe(JC_BRIDGE_WORKER_TOKEN);
  });

  it("without the dedicated authority token an approved call is refused and the lane is not ready", async () => {
    const bare = await startStack("acs-jc-noauthority-e2e-", { authorityToken: null });
    try {
      const marker = join(bare.project, "unauthorized.txt");
      const args = { command: `touch ${marker}`, cwd: bare.project, waitMs: 5000 };
      const held = heldForApproval(await bare.alice.call("run_command", args));
      expect(await bare.acs.approve(held.workItemId, held.actionHash)).toBe(200);
      const refused = await bare.alice.call("run_command", args);
      expect(refused.body.result?.isError, JSON.stringify(refused.body)).toBe(true);
      expect(refused.body.result.structuredContent.error.code).toBe("ACS_UNAVAILABLE");
      expect(refused.body.result.structuredContent.error.message).toMatch(/JC_ACS_AUTHORITY_TOKEN/);
      expect(existsSync(marker)).toBe(false);
      const authority = await (await fetch(`http://127.0.0.1:${bare.bridge.port}/authority`)).json();
      expect(authority.enforcement.currentAuthorityCredentialConfigured).toBe(false);
      const ready = await fetch(`${bare.edge.origin}/jc/ready`);
      expect(ready.status).toBe(503);
      expect((await ready.json()).bridgeReady).toBe(false);
    } finally {
      await bare.stop();
    }
  });

  it("with the dedicated read-only token the lane reports ready", async () => {
    const authority = await (await fetch(`http://127.0.0.1:${stack.bridge.port}/authority`)).json();
    expect(authority.enforcement.currentAuthorityCredentialConfigured).toBe(true);
    const ready = await fetch(`${stack.edge.origin}/jc/ready`);
    expect(await ready.json()).toMatchObject({ bridgeReady: true });
  });

  it("a lease revoked after issuance is refused by JC before anything runs", async () => {
    await refusedAfterIssuance("revoked", /lease_not_active/);
  });

  it("a lease that expired after issuance is refused by JC before anything runs", async () => {
    await refusedAfterIssuance("expired", /lease_not_active/);
  });
});
