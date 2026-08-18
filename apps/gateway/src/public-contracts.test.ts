import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayMcpInputSchemas, publicContractExamples } from "./public-contracts.js";
import { buildGateway } from "./server.js";

type GeneratedTransportRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type GeneratedClientModule = {
  createPublicApiClient(
    transport: (request: GeneratedTransportRequest) => Promise<unknown>
  ): Record<
    string,
    (input?: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> }) => Promise<unknown>
  >;
  createGatewayMcpClient(transport: (request: GeneratedTransportRequest) => Promise<unknown>): {
    callTool(
      name: string,
      arguments_: unknown,
      options?: { id?: string | number; headers?: Record<string, string> }
    ): Promise<unknown>;
  };
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generated public contract clients", () => {
  it("exercise successful HTTP and MCP calls through generated operation bindings", async () => {
    const app = testGateway();
    const generated = await generatedClients();
    const transport = async (request: GeneratedTransportRequest) => {
      const response = await injectGenerated(app, request);
      return { statusCode: response.statusCode, body: response.json() };
    };
    const http = generated.createPublicApiClient(transport);
    const mcp = generated.createGatewayMcpClient(transport);

    const created = (await http.createWorkItem({
      headers: { authorization: "Bearer test-token" },
      body: publicContractExamples.createWorkItem
    })) as { statusCode: number; body: { id: string } };
    expect(created.statusCode).toBe(201);
    expect(created.body.id).toMatch(/^wrk_/);

    const listed = (await mcp.callTool(
      "list_work_items",
      {},
      {
        headers: { authorization: "Bearer test-token" }
      }
    )) as {
      statusCode: number;
      body: { result: { structuredContent: { result: unknown[] } } };
    };
    expect(listed.statusCode).toBe(200);
    expect(listed.body.result.structuredContent.result).toHaveLength(1);
    await app.close();
  });

  it("rejects a generated HTTP call that violates the runtime boundary", async () => {
    const app = testGateway();
    const generated = await generatedClients();
    const http = generated.createPublicApiClient(async (request) => {
      const response = await injectGenerated(app, request);
      return { statusCode: response.statusCode, body: response.json() };
    });

    const rejected = (await http.createWorkItem({
      headers: { authorization: "Bearer test-token" },
      body: { title: "", intent: "" }
    })) as { statusCode: number };
    expect(rejected.statusCode).toBe(400);
    expect(
      gatewayMcpInputSchemas.create_work_item.safeParse({ title: "", requester: "user", intent: "" }).success
    ).toBe(false);
    await app.close();
  });
});

function testGateway() {
  const directory = mkdtempSync(join(tmpdir(), "acs-public-contracts-"));
  directories.push(directory);
  return buildGateway({
    dbPath: join(directory, "gateway.db"),
    logger: false,
    auth: { token: "test-token", actor: "user" },
    mcpAuth: { localBearerToken: "test-token" },
    acpAdapter: false,
    moa: false
  });
}

async function generatedClients(): Promise<GeneratedClientModule> {
  // The module is intentionally generated JavaScript so non-TypeScript consumers can use it directly.
  // @ts-expect-error The generated client has no hand-maintained declaration file by design.
  return (await import("../../../contracts/public/v1/client.mjs")) as GeneratedClientModule;
}

function injectGenerated(app: FastifyInstance, request: GeneratedTransportRequest) {
  return app.inject({
    method: request.method as "GET" | "POST" | "PUT" | "PATCH",
    url: request.path,
    headers: request.headers,
    ...(request.body === undefined ? {} : { payload: request.body as object })
  });
}
