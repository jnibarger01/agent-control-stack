import { afterEach, describe, expect, it } from "vitest";
import { McpStdioClient, type McpRuntimeBootstrap } from "./mcp-stdio-client.js";

const bootstrap: McpRuntimeBootstrap = {
  schemaVersion: 1,
  runtimeId: "runtime_1",
  challenge: "A".repeat(43),
  scopes: ["fs.read", "fs.write"]
};

const serverProgram = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      const mode = process.env.TEST_IDENTITY_MODE;
      const identity = mode === "missing" ? undefined : mode === "drift"
        ? { ...request.params._meta.acsRuntimeBootstrap, challenge: "B".repeat(43) }
        : mode === "extra"
          ? { ...request.params._meta.acsRuntimeBootstrap, extra: true }
          : request.params._meta.acsRuntimeBootstrap;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake" }, _meta: identity === undefined ? {} : { acsRuntimeIdentity: identity } } }) + "\\n");
    }
  }
});`;

const clients: McpStdioClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function client(mode: "ok" | "missing" | "drift" | "extra"): McpStdioClient {
  const value = new McpStdioClient({
    command: process.execPath,
    args: ["-e", serverProgram],
    env: { TEST_IDENTITY_MODE: mode },
    connectTimeoutMs: 1_000,
    onStderr: (chunk) => process.stderr.write(chunk)
  });
  clients.push(value);
  return value;
}

describe("McpStdioClient managed runtime bootstrap", () => {
  it("sends the exact bootstrap field and accepts only an exact identity echo", async () => {
    const result = await client("ok").connect(bootstrap);
    expect(result.runtimeIdentity).toEqual(bootstrap);
  });

  it.each(["missing", "drift", "extra"] as const)("fails closed on %s runtime identity", async (mode) => {
    await expect(client(mode).connect(bootstrap)).rejects.toThrow(/runtime identity/);
  });
});
