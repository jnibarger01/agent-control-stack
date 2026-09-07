import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpRequiredScopes, mcpToolAnnotations, portfolioToolNames, remoteMcpToolNames } from "./public-contracts.js";
import {
  PORTFOLIO_UNAVAILABLE_CODE,
  createUnavailablePortfolioClient,
  type PortfolioClient
} from "./portfolio-client.js";
import { buildGateway } from "./server.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testGateway(portfolioClient?: PortfolioClient) {
  const directory = mkdtempSync(join(tmpdir(), "acs-portfolio-mcp-"));
  directories.push(directory);
  return buildGateway({
    dbPath: join(directory, "gateway.db"),
    logger: false,
    auth: { token: "test-token", actor: "user", actorId: "portfolio-actor" },
    mcpAuth: { localBearerToken: "test-token" },
    acpAdapter: false,
    moa: false,
    portfolioClient: portfolioClient ?? createUnavailablePortfolioClient()
  });
}

async function callTool(app: ReturnType<typeof buildGateway>, name: string, args: unknown = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer test-token" },
    payload: {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args }
    }
  });
}

describe("portfolio MCP tools", () => {
  it("lists all seven portfolio tools as remotely exposable read-only tools", async () => {
    const app = testGateway();
    try {
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer test-token" },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      expect(listed.statusCode).toBe(200);
      const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
      for (const name of portfolioToolNames) {
        expect(names).toContain(name);
        expect(remoteMcpToolNames).toContain(name);
        expect(mcpRequiredScopes(name)).toEqual(["acs:work:read"]);
        expect(mcpToolAnnotations(name)).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false
        });
        const tool = listed.json().result.tools.find((candidate: { name: string }) => candidate.name === name);
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false
        });
      }
    } finally {
      await app.close();
    }
  });

  it("returns PORTFOLIO_UNAVAILABLE without calling work-item mutation paths", async () => {
    const app = testGateway();
    try {
      const response = await callTool(app, "portfolio.get_summary");
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(-32000);
      expect(response.json().error.message).toContain("Portfolio intelligence is not available");
      expect(response.json().error.message).toContain(PORTFOLIO_UNAVAILABLE_CODE);
      const workItems = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: "Bearer test-token" }
      });
      expect(workItems.json()).toEqual({ workItems: [] });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed repository identity without creating a work item", async () => {
    const app = testGateway({
      getSummary: async () => ({ ok: true }),
      listRepositories: async () => ({ ok: true }),
      listAttentionRequired: async () => ({ ok: true }),
      getRepository: async () => ({ ok: true }),
      listFailures: async () => ({ ok: true }),
      listPendingWork: async () => ({ ok: true }),
      listRecentProgress: async () => ({ ok: true })
    });
    try {
      const response = await callTool(app, "portfolio.get_repository", { repository: "not a repo" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(-32602);
      const workItems = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: "Bearer test-token" }
      });
      expect(workItems.json()).toEqual({ workItems: [] });
    } finally {
      await app.close();
    }
  });

  it("returns Visualizer JSON from an injected read client", async () => {
    const app = testGateway({
      getSummary: async () => ({ schemaVersion: 1, summary: { repositoryCount: 4 } }),
      listRepositories: async () => ({ repositories: [] }),
      listAttentionRequired: async () => ({ items: [] }),
      getRepository: async () => ({ repository: { fullName: "jnibarger01/visualizer" } }),
      listFailures: async () => ({ failures: [] }),
      listPendingWork: async () => ({ pendingWork: [] }),
      listRecentProgress: async () => ({ activity: [] })
    });
    try {
      const response = await callTool(app, "portfolio.get_summary", {});
      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent).toEqual({
        schemaVersion: 1,
        summary: { repositoryCount: 4 }
      });
    } finally {
      await app.close();
    }
  });
});
