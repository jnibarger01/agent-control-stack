import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MachineController, loadMachineControllerConfig, type DirectAgentRunner } from "@agent-control-stack/machine-controller";
import { describe, expect, it } from "vitest";
import { McpStdioServer, frameMessage } from "./server.js";

describe("MCP stdio server", () => {
  it("serves tool discovery and read-only calls over content-length framing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const allowed = join(dir, "allowed");
    const denied = join(allowed, "denied");
    mkdirSync(allowed);
    mkdirSync(denied);
    writeFileSync(join(allowed, "package.json"), "{}\n");
    writeFileSync(join(denied, "secret.txt"), "nope\n");
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        paths: { allow: [allowed], deny: [denied] },
        commands: { allow_readonly: ["node", "git"], deny: ["rm", "sudo"] },
        audit: { log_path: join(dir, "audit.jsonl") }
      })
    );
    const directAgentCalls: Array<{ cwd: string; timeoutMs: number; permissionMode: string; args: string[] }> = [];
    const directAgentRunner: DirectAgentRunner = async (request) => {
      directAgentCalls.push({
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        permissionMode: request.permissionMode,
        args: request.args
      });
      return { stdout: "mcp review ok", stderr: "", exitCode: 0, durationMs: 7 };
    };
    const input = new PassThrough();
    const output = new PassThrough();
    new McpStdioServer(
      input,
      output,
      new MachineController(loadMachineControllerConfig(configPath), {
        directAgentRunner,
        enableTestAgentRunForLocalDevelopment: true
      })
    ).start();

    try {
      const initialized = await request(input, output, { jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(initialized.result.capabilities.tools).toEqual({});

      const tools = await request(input, output, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const toolNames = tools.result.tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("fs.read");
      expect(toolNames).not.toContain("test.agent.run");

      const directRun = await request(input, output, {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "test.agent.run",
          arguments: {
            agent: "codex",
            prompt: "Review apps/gateway/src/server.ts for auth bugs. Do not modify files.",
            cwd: allowed,
            timeoutSeconds: 120,
            permissionMode: "read-only"
          }
        }
      });
      expect(directRun).toMatchObject({
        error: { code: -32602 }
      });
      expect(directAgentCalls).toHaveLength(0);

      const status = await request(input, output, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "system.status", arguments: {} }
      });
      expect(status.result.structuredContent.server.transport).toBe("stdio");

      const listed = await request(input, output, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fs.list", arguments: { path: allowed } }
      });
      expect(listed.result.structuredContent.entries.map((entry: { name: string }) => entry.name)).toContain(
        "package.json"
      );
      expect(listed.result.structuredContent.entries.map((entry: { name: string }) => entry.name)).not.toContain(
        "secret.txt"
      );

      const read = await request(input, output, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "fs.read", arguments: { path: join(allowed, "package.json") } }
      });
      expect(read.result.structuredContent.text).toContain("1: {}");

      const preview = await request(input, output, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "cmd.preview", arguments: { cwd: allowed, command: "rm", args: ["-rf", "/"] } }
      });
      expect(preview.result.structuredContent.risk).toBe("forbidden");

      const refusedRun = await request(input, output, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "cmd.run", arguments: { cwd: allowed, command: "rm", args: ["-rf", "/"] } }
      });
      expect(refusedRun.error.message).toContain("command refused");

      const deniedPath = await request(input, output, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "fs.read", arguments: { path: join(denied, "secret.txt") } }
      });
      expect(deniedPath.error.message).toContain("denied by config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function request(input: PassThrough, output: PassThrough, message: unknown): Promise<any> {
  const response = readFrame(output);
  input.write(frameMessage(message));
  return await response;
}

async function readFrame(output: PassThrough): Promise<any> {
  return await new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    output.on("data", function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /^Content-Length:\s*(\d+)$/im.exec(buffer.subarray(0, headerEnd).toString("utf8"));
      if (!match) return;
      const start = headerEnd + 4;
      const end = start + Number(match[1]);
      if (buffer.length < end) return;
      output.off("data", onData);
      const body = buffer.subarray(start, end).toString("utf8");
      buffer = buffer.subarray(end);
      resolve(JSON.parse(body));
    });
  });
}
