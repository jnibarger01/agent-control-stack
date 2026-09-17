import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  PORTFOLIO_UNAVAILABLE_CODE,
  PORTFOLIO_V2_WRITES_DENIED_CODE,
  PORTFOLIO_V2_WRITES_NOT_IMPLEMENTED_CODE,
  assertPortfolioGithubWritesAllowed,
  createPortfolioClient,
  createPortfolioClientFromEnv,
  createUnavailablePortfolioClient,
  isPortfolioGithubWriteTool,
  isProvingEligibleForV2,
  portfolioClientConfigSchema,
  portfolioGithubWriteToolNames
} from "./portfolio-client.js";

const envelope = {
  schemaVersion: 1,
  generatedAt: "2026-09-06T18:00:00.000Z",
  correlationId: "10000000-0000-4000-8000-000000000001"
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  return `http://127.0.0.1:${address.port}`;
}

describe("portfolio client", () => {
  it("rejects non-loopback portfolio base URLs", () => {
    expect(() => portfolioClientConfigSchema.parse({ baseUrl: "https://api.github.com", timeoutMs: 1_000 })).toThrow(
      /loopback/i
    );
  });

  it("requests exact Visualizer paths and returns the JSON object", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...envelope, summary: { repositoryCount: 1 } }));
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    const body = await client.getSummary();
    expect(seen).toEqual(["GET /api/v1/portfolio"]);
    expect(body).toMatchObject({ schemaVersion: 1, summary: { repositoryCount: 1 } });
  });

  it("filters and limits repository lists client-side because Visualizer rejects query strings", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...envelope,
          repositories: [
            { fullName: "jnibarger01/visualizer", status: "ATTENTION", lifecycle: "ACTIVE" },
            { fullName: "jnibarger01/toyota-showroom", status: "HEALTHY", lifecycle: "ACTIVE" },
            { fullName: "jnibarger01/legacy", status: "ARCHIVED", lifecycle: "ARCHIVED" }
          ]
        })
      );
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    const body = (await client.listRepositories({ status: "ATTENTION", limit: 1 })) as {
      repositories: unknown[];
    };
    expect(seen).toEqual(["GET /api/v1/portfolio/repositories"]);
    expect(body.repositories).toEqual([
      { fullName: "jnibarger01/visualizer", status: "ATTENTION", lifecycle: "ACTIVE" }
    ]);
  });

  it("fails closed when Visualizer is unreachable", async () => {
    const client = createPortfolioClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 200 });
    await expect(client.getSummary()).rejects.toMatchObject({
      code: PORTFOLIO_UNAVAILABLE_CODE
    });
  });

  it("fails closed when Visualizer hangs past the timeout", async () => {
    const baseUrl = await listen((_request, _response) => undefined);
    const client = createPortfolioClient({ baseUrl, timeoutMs: 100 });
    await expect(client.getSummary()).rejects.toMatchObject({
      code: PORTFOLIO_UNAVAILABLE_CODE
    });
  });

  it("fails closed on credential-bearing payloads", async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...envelope, token: "ghs_secret", summary: {} }));
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    await expect(client.getSummary()).rejects.toBeInstanceOf(ControlStackError);
  });

  it("stays unavailable when ACS_PORTFOLIO_BASE_URL is unset", async () => {
    const client = createPortfolioClientFromEnv({});
    await expect(client.getSummary()).rejects.toMatchObject({
      code: PORTFOLIO_UNAVAILABLE_CODE
    });
  });

  it("stays unavailable when ACS_PORTFOLIO_BASE_URL is not loopback", () => {
    const client = createPortfolioClientFromEnv({ ACS_PORTFOLIO_BASE_URL: "https://example.test" });
    return expect(client.getSummary()).rejects.toMatchObject({ code: PORTFOLIO_UNAVAILABLE_CODE });
  });

  it("requests attention path and limits items client-side", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...envelope,
          items: [
            { fullName: "jnibarger01/visualizer", status: "ATTENTION" },
            { fullName: "jnibarger01/agent-control-stack", status: "ATTENTION" }
          ]
        })
      );
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    const body = (await client.listAttentionRequired({ limit: 1 })) as { items: unknown[] };
    expect(seen).toEqual(["GET /api/v1/portfolio/attention"]);
    expect(body.items).toEqual([{ fullName: "jnibarger01/visualizer", status: "ATTENTION" }]);
  });

  it("createPortfolioClientFromEnv happy-path hits get_summary and attention", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/portfolio") {
        response.end(JSON.stringify({ ...envelope, summary: { repositoryCount: 2 } }));
        return;
      }
      response.end(JSON.stringify({ ...envelope, items: [{ fullName: "jnibarger01/visualizer" }] }));
    });
    const client = createPortfolioClientFromEnv({
      ACS_PORTFOLIO_BASE_URL: baseUrl,
      ACS_PORTFOLIO_TIMEOUT_MS: "1000"
    });
    await expect(client.getSummary()).resolves.toMatchObject({ summary: { repositoryCount: 2 } });
    await expect(client.listAttentionRequired()).resolves.toMatchObject({
      items: [{ fullName: "jnibarger01/visualizer" }]
    });
    expect(seen).toEqual(["GET /api/v1/portfolio", "GET /api/v1/portfolio/attention"]);
  });

  it("treats reserved and unknown portfolio.* mutation names as GitHub write tools", () => {
    for (const name of portfolioGithubWriteToolNames) {
      expect(isPortfolioGithubWriteTool(name)).toBe(true);
    }
    expect(isPortfolioGithubWriteTool("portfolio.get_summary")).toBe(false);
    expect(isPortfolioGithubWriteTool("portfolio.surprise_mutation")).toBe(true);
    expect(isPortfolioGithubWriteTool("create_work_item")).toBe(false);
  });

  it("requires proving.eligibleForV2 === true before allowing GitHub writes", () => {
    expect(isProvingEligibleForV2(undefined)).toBe(false);
    expect(isProvingEligibleForV2(null)).toBe(false);
    expect(isProvingEligibleForV2({})).toBe(false);
    expect(isProvingEligibleForV2({ eligibleForV2: false })).toBe(false);
    expect(isProvingEligibleForV2({ eligibleForV2: "true" })).toBe(false);
    expect(isProvingEligibleForV2({ eligibleForV2: true })).toBe(true);
    expect(() => assertPortfolioGithubWritesAllowed(undefined)).toThrow(/PORTFOLIO_V2_WRITES_DENIED/);
    expect(() => assertPortfolioGithubWritesAllowed({ eligibleForV2: false })).toThrow(/PORTFOLIO_V2_WRITES_DENIED/);
    expect(() => assertPortfolioGithubWritesAllowed({ eligibleForV2: true })).not.toThrow();
  });

  it("refuses GitHub write tools when sync-status proving flag is false or absent", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/portfolio/sync-status") {
        response.end(
          JSON.stringify({
            ...envelope,
            proving: { requiredDays: 7, startedAt: null, consecutiveDays: 0, eligibleForV2: false, blockers: [] }
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    await expect(client.assertGithubWritesAllowed()).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_DENIED_CODE
    });
    await expect(client.refuseGithubWriteTool("portfolio.add_labels")).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_DENIED_CODE
    });
    expect(seen).toEqual(["GET /api/v1/portfolio/sync-status", "GET /api/v1/portfolio/sync-status"]);
  });

  it("refuses GitHub write tools when proving object is absent from sync-status", async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...envelope, configured: true }));
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    await expect(client.refuseGithubWriteTool("portfolio.assign")).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_DENIED_CODE
    });
  });

  it("still performs no GitHub mutation when eligibleForV2 is true", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...envelope,
          proving: {
            requiredDays: 7,
            startedAt: "2026-09-01T00:00:00.000Z",
            consecutiveDays: 7,
            eligibleForV2: true,
            blockers: []
          }
        })
      );
    });
    const client = createPortfolioClient({ baseUrl, timeoutMs: 1_000 });
    await expect(client.assertGithubWritesAllowed()).resolves.toBeUndefined();
    await expect(client.refuseGithubWriteTool("portfolio.create_issue_comment")).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_NOT_IMPLEMENTED_CODE
    });
    expect(seen.every((entry) => entry.startsWith("GET "))).toBe(true);
    expect(
      seen.some((entry) => entry.startsWith("POST ") || entry.startsWith("PATCH ") || entry.startsWith("PUT "))
    ).toBe(false);
  });

  it("unavailable client denies writes because proving flag is absent", async () => {
    const client = createUnavailablePortfolioClient();
    await expect(client.assertGithubWritesAllowed()).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_DENIED_CODE
    });
    await expect(client.refuseGithubWriteTool("portfolio.add_labels")).rejects.toMatchObject({
      code: PORTFOLIO_V2_WRITES_DENIED_CODE
    });
  });
});
