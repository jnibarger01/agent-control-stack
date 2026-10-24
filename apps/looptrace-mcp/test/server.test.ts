import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LoopTraceQueryService, signGrant } from "@agent-control-stack/looptrace-query";
import { createFixture, seedScenario, at, T0, type Fixture } from "../../../packages/looptrace-query/test/fixture.js";
import { configFromEnv } from "../src/config.js";
import { LoopTraceMcpServer, TOOL_DEFINITIONS } from "../src/server.js";

const KEY = Buffer.alloc(32, 3);
const fixtures: Fixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const token = (scopes: Array<"looptrace:trace" | "looptrace:gaps" | "looptrace:verify"> = ["looptrace:trace", "looptrace:gaps", "looptrace:verify"]): string =>
  signGrant({ v: 1, sub: "agent:t", scopes, visibility: { mode: "all" }, iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600 }, KEY);

function harness(grant: string | null = token()) {
  const f = createFixture();
  fixtures.push(f);
  const id = f.create();
  const db = f.db();
  seedScenario(db, id);
  db.close();
  const svc = new LoopTraceQueryService({ acsDbPath: f.dbPath, jcTraceRoots: [], hermesStateDb: null, releaseRoots: [], healthTargets: [], grantKey: KEY, now: () => new Date(at(100)) });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(c));
  const server = new LoopTraceMcpServer(input, output, svc, grant);
  server.start();
  return { id, input, server, text: () => Buffer.concat(chunks).toString("utf8"), f };
}

const lsp = (m: unknown): string => {
  const body = JSON.stringify(m);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const settle = async (h: ReturnType<typeof harness>): Promise<void> => {
  await new Promise((r) => setTimeout(r, 20));
  await h.server.idle();
  await new Promise((r) => setTimeout(r, 20));
};
const parseLsp = (text: string): any[] => {
  const out: any[] = [];
  let rest = text;
  for (;;) {
    const m = /^Content-Length: (\d+)\r\n\r\n/u.exec(rest);
    if (!m) break;
    const len = Number(m[1]);
    const start = m[0].length;
    out.push(JSON.parse(rest.slice(start, start + len)));
    rest = rest.slice(start + len);
  }
  return out;
};

describe("acs-looptrace-mcp (read-only MCP server)", () => {
  it("registers exactly three discoverable tools, all annotated read-only with closed schemas", async () => {
    const h = harness();
    h.input.write(lsp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    h.input.write(lsp({ jsonrpc: "2.0", method: "notifications/initialized" }));
    h.input.write(lsp({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    await settle(h);
    const [init, list] = parseLsp(h.text());
    expect(init.result.serverInfo.name).toBe("acs-looptrace-mcp");
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(["looptrace_gaps", "looptrace_trace", "looptrace_verify"]);
    for (const t of list.result.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.inputSchema.additionalProperties).toBe(false);
      // nothing in any schema lets a caller pass a grant, path, URL, SQL or command
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/"(grant|token|path|url|sql|command|cmd)"/u);
    }
    expect(TOOL_DEFINITIONS).toHaveLength(3);
  });

  it("answers tools/call over Content-Length framing and newline-delimited JSON framing", async () => {
    const a = harness();
    a.input.write(lsp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "looptrace_gaps", arguments: { work_item_id: a.id } } }));
    await settle(a);
    const ra = parseLsp(a.text())[0];
    expect(ra.result.isError).toBe(false);
    expect(ra.result.structuredContent.reports[0].work_item_id).toBe(a.id);

    const b = harness();
    b.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "looptrace_verify", arguments: { work_item_id: b.id, assertions: [{ type: "operation_completed" }] } } })}\n`);
    await settle(b);
    const rb = JSON.parse(b.text().trim());
    expect(rb.id).toBe(7);
    expect(rb.result.structuredContent.verdict).toBe("PASS");
    expect(JSON.parse(rb.result.content[0].text).verdict).toBe("PASS");
  });

  it.each([
    { scenario: "missing grant", grant: null, name: "looptrace_trace", args: { work_item_id: "x" }, code: "UNAUTHENTICATED" },
    { scenario: "insufficient scope", grant: token(["looptrace:trace"]), name: "looptrace_verify", args: { work_item_id: "x", assertions: [{ type: "approval_valid" }] }, code: "UNAUTHENTICATED" },
    { scenario: "invalid arguments", grant: token(), name: "looptrace_trace", args: {}, code: "INVALID_ARGUMENT" },
    { scenario: "unsupported assertion", grant: token(), name: "looptrace_verify", args: { work_item_id: "x", assertions: [{ type: "deploy" }] }, code: "UNSUPPORTED_ASSERTION" },
    { scenario: "missing work item", grant: token(), name: "looptrace_trace", args: { work_item_id: "wrk_nope" }, code: "NOT_FOUND" },
  ])("returns structured tool errors (isError) for $scenario", async ({ grant, name, args, code }) => {
    const h = harness(grant);
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    await settle(h);
    expect(JSON.parse(h.text().trim()).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code } },
    });
  });

    it("rejects unknown tools / methods, malformed JSON and oversized frames without crashing", async () => {
    const h = harness();
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "looptrace_apply_fix", arguments: {} } })}\n`);
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: {} })}\n`);
    h.input.write("{not json\n");
    await settle(h);
    const lines = h.text().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((l) => l.id === 1).error.code).toBe(-32602);
    expect(lines.find((l) => l.id === 2).error.code).toBe(-32601);
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700);
    const big = harness();
    big.input.write(lsp({ jsonrpc: "2.0", id: 1, method: "ping" }));
    big.input.write(`Content-Length: 99999999\r\n\r\n`);
    await settle(big);
    expect(parseLsp(big.text()).some((m) => m.error?.code === -32600)).toBe(true);
  });

  it("config: the grant key file must be private; health targets are validated; no grant comes from tool args", () => {
    const dir = mkdtempSync(join(tmpdir(), "lt-cfg-"));
    dirs.push(dir);
    const key = join(dir, "key");
    writeFileSync(key, "k".repeat(40), { mode: 0o644 });
    expect(() => configFromEnv({ LOOPTRACE_GRANT_KEY_FILE: key })).toThrow(/group\/world/);
    chmodSync(key, 0o600);
    const { config } = configFromEnv({ LOOPTRACE_GRANT_KEY_FILE: key, LOOPTRACE_HEALTH_TARGETS: '{"gw":"http://127.0.0.1:1/h"}' });
    expect(config.grantKey?.length).toBe(40);
    expect(config.healthTargets).toEqual([{ name: "gw", url: "http://127.0.0.1:1/h" }]);
    expect(() => configFromEnv({ LOOPTRACE_HEALTH_TARGETS: '{"gw":"file:///etc/passwd"}' })).toThrow(/invalid LOOPTRACE_HEALTH_TARGETS/);
  });
});
