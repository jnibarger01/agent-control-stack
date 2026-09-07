import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  PORTFOLIO_UNAVAILABLE_CODE,
  createPortfolioClient,
  createPortfolioClientFromEnv,
  portfolioClientConfigSchema
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
});
