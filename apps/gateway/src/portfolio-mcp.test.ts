import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { mcpRequiredScopes, mcpToolAnnotations, portfolioToolNames, remoteMcpToolNames } from "./public-contracts.js";
import {
  PORTFOLIO_UNAVAILABLE_CODE,
  PORTFOLIO_V2_WRITES_DENIED_CODE,
  PORTFOLIO_V2_WRITES_DENIED_MESSAGE,
  createUnavailablePortfolioClient,
  portfolioGithubWriteToolNames,
  type PortfolioClient
} from "./portfolio-client.js";
import { buildGateway } from "./server.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readPortfolioClient(overrides: Partial<PortfolioClient> = {}): PortfolioClient {
  const denyWrites = async (): Promise<never> => {
    throw new ControlStackError(PORTFOLIO_V2_WRITES_DENIED_CODE, PORTFOLIO_V2_WRITES_DENIED_MESSAGE);
  };
  return {
    getSummary: async () => ({ ok: true }),
    listRepositories: async () => ({ ok: true }),
    listAttentionRequired: async () => ({ ok: true }),
    getRepository: async () => ({ ok: true }),
    listFailures: async () => ({ ok: true }),
    listPendingWork: async () => ({ ok: true }),
    listRecentProgress: async () => ({ ok: true }),
    getSyncStatus: denyWrites,
    assertGithubWritesAllowed: denyWrites,
    refuseGithubWriteTool: denyWrites,
    ...overrides
  };
}

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
    const app = testGateway(readPortfolioClient());
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
    const app = testGateway(
      readPortfolioClient({
        getSummary: async () => ({ schemaVersion: 1, summary: { repositoryCount: 4 } }),
        listRepositories: async () => ({ repositories: [] }),
        listAttentionRequired: async () => ({ items: [] }),
        getRepository: async () => ({ repository: { fullName: "jnibarger01/visualizer" } }),
        listFailures: async () => ({ failures: [] }),
        listPendingWork: async () => ({ pendingWork: [] }),
        listRecentProgress: async () => ({ activity: [] })
      })
    );
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

  it("does not advertise reserved portfolio GitHub write tools", async () => {
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
      for (const name of portfolioGithubWriteToolNames) {
        expect(names).not.toContain(name);
        expect(remoteMcpToolNames as readonly string[]).not.toContain(name);
        expect(portfolioToolNames as readonly string[]).not.toContain(name);
      }
    } finally {
      await app.close();
    }
  });

  it("refuses portfolio GitHub write tools when proving.eligibleForV2 is false or absent", async () => {
    const app = testGateway(
      readPortfolioClient({
        refuseGithubWriteTool: async () => {
          throw new ControlStackError(PORTFOLIO_V2_WRITES_DENIED_CODE, PORTFOLIO_V2_WRITES_DENIED_MESSAGE);
        }
      })
    );
    try {
      for (const name of portfolioGithubWriteToolNames) {
        const response = await callTool(app, name, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe(-32000);
        expect(response.json().error.message).toContain(PORTFOLIO_V2_WRITES_DENIED_CODE);
        expect(response.json().error.message).toContain("eligibleForV2");
      }
    } finally {
      await app.close();
    }
  });

  it("fails closed if a write tool would be reachable without the proving gate", async () => {
    let refuseCalls = 0;
    const app = testGateway(
      readPortfolioClient({
        refuseGithubWriteTool: async (toolName) => {
          refuseCalls += 1;
          expect(toolName).toBe("portfolio.add_labels");
          throw new ControlStackError(PORTFOLIO_V2_WRITES_DENIED_CODE, PORTFOLIO_V2_WRITES_DENIED_MESSAGE);
        }
      })
    );
    try {
      const response = await callTool(app, "portfolio.add_labels", {
        repository: "jnibarger01/visualizer",
        labels: ["blocked"]
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain(PORTFOLIO_V2_WRITES_DENIED_CODE);
      expect(refuseCalls).toBe(1);
      // Write tools must remain outside the frozen remote allowlist.
      expect(remoteMcpToolNames).not.toContain("portfolio.add_labels");
    } finally {
      await app.close();
    }
  });
});
