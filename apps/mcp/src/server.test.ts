import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MachineController, loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { describe, expect, it } from "vitest";
import { McpStdioServer, frameMessage } from "./server.js";

describe("MCP stdio server", () => {
  it("serves tool discovery and read-only calls over content-length framing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "package.json"), "{}\n");
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        paths: { allow: [allowed], deny: [] },
        commands: { allow_readonly: ["node", "git"], deny: ["rm", "sudo"] },
        audit: { log_path: join(dir, "audit.jsonl") }
      })
    );
    const input = new PassThrough();
    const output = new PassThrough();
    new McpStdioServer(input, output, new MachineController(loadMachineControllerConfig(configPath))).start();

    try {
      const initialized = await request(input, output, { jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(initialized.result.capabilities.tools).toEqual({});

      const tools = await request(input, output, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("fs.read");

      const read = await request(input, output, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fs.read", arguments: { path: join(allowed, "package.json") } }
      });
      expect(read.result.structuredContent.text).toContain("1: {}");

      const preview = await request(input, output, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "cmd.preview", arguments: { cwd: allowed, command: "rm", args: ["-rf", "/"] } }
      });
      expect(preview.result.structuredContent.risk).toBe("forbidden");
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
      resolve(JSON.parse(buffer.subarray(start, end).toString("utf8")));
    });
  });
}
