import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MachineController, loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { afterEach, describe, expect, it } from "vitest";
import { McpStdioServer, frameMessage } from "./server.js";

/**
 * Framing hardening: a malformed frame must be answered with a JSON-RPC error and must
 * never abort the read loop. Before the fix, the rejected `drain()` promise was voided,
 * so one bad frame both produced an unhandled rejection and stopped the server from
 * answering every later request.
 */
describe("MCP stdio server framing hardening", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("answers a non-JSON body with a parse error and keeps serving", async () => {
    const server = startServer();
    try {
      const bad = await server.sendRaw("Content-Length: 9\r\n\r\n{not json");
      expect(bad.id).toBeNull();
      expect(bad.error.code).toBe(-32700);

      const recovered = await server.send({ jsonrpc: "2.0", id: 11, method: "initialize" });
      expect(recovered.error).toBeUndefined();
      expect(recovered.id).toBe(11);
      expect(recovered.result.protocolVersion).toBe("2024-11-05");
    } finally {
      server.dispose();
    }
  }, 20_000);

  it("answers a request envelope that fails the schema with -32600 instead of rejecting", async () => {
    const server = startServer();
    try {
      // Valid JSON, valid id, missing "method": previously threw out of handleMcpRequest.
      const bad = await server.send({ jsonrpc: "2.0", id: 12 });
      expect(bad.id).toBe(12);
      expect(bad.error.code).toBe(-32600);

      const recovered = await server.send({ jsonrpc: "2.0", id: 13, method: "tools/list" });
      expect(recovered.id).toBe(13);
      expect(Array.isArray(recovered.result.tools)).toBe(true);
    } finally {
      server.dispose();
    }
  }, 20_000);

  it("resyncs after a header without Content-Length and still serves the next frame", async () => {
    const server = startServer();
    try {
      const bad = await server.sendRaw("X-Not-A-Length: 1\r\n\r\n");
      expect(bad.id).toBeNull();
      expect(bad.error.code).toBe(-32700);

      const recovered = await server.send({ jsonrpc: "2.0", id: 14, method: "initialize" });
      expect(recovered.id).toBe(14);
    } finally {
      server.dispose();
    }
  }, 20_000);

  it("refuses an oversized declared frame without buffering the body and keeps serving", async () => {
    const server = startServer();
    try {
      const bad = await server.sendRaw("Content-Length: 500000000\r\n\r\n");
      expect(bad.id).toBeNull();
      expect(bad.error.code).toBe(-32700);

      const recovered = await server.send({ jsonrpc: "2.0", id: 15, method: "initialize" });
      expect(recovered.id).toBe(15);
    } finally {
      server.dispose();
    }
  }, 20_000);

  function startServer(): {
    send: (body: unknown) => Promise<any>;
    sendRaw: (text: string) => Promise<any>;
    dispose: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-framing-"));
    temporaryDirectories.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        paths: { allow: [dir], deny: [] },
        commands: { allow_readonly: ["node"], deny: ["rm"] },
        audit: { log_path: join(dir, "audit.jsonl") }
      })
    );
    const input = new PassThrough();
    const output = new PassThrough();
    new McpStdioServer(input, output, new MachineController(loadMachineControllerConfig(configPath))).start();
    return {
      send: async (body) => {
        const response = readFrame(output);
        input.write(frameMessage(body));
        return await withTimeout(response, 3_000);
      },
      sendRaw: async (text) => {
        const response = readFrame(output);
        input.write(text);
        return await withTimeout(response, 3_000);
      },
      dispose: () => {
        input.end();
        output.end();
      }
    };
  }
});

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no MCP response within ${ms}ms`)), ms);
      if (typeof timer.unref === "function") timer.unref();
    })
  ]);
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
