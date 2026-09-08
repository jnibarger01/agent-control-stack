#!/usr/bin/env node
/**
 * Local portfolio MCP client smoke.
 * Starts an ephemeral fake Visualizer on 127.0.0.1 unless --live is passed
 * (then ACS_PORTFOLIO_BASE_URL must already point at a loopback Visualizer).
 * Not part of CI; CI uses portfolio-client.test.ts / portfolio-mcp.test.ts.
 */
import { createServer } from "node:http";

const LIVE = process.argv.includes("--live");
const TIMEOUT_MS = Number(process.env.ACS_PORTFOLIO_TIMEOUT_MS ?? 5000);

const envelope = {
  schemaVersion: 1,
  generatedAt: "2026-09-08T00:00:00.000Z",
  correlationId: "10000000-0000-4000-8000-000000000085"
};

function assertLoopback(baseUrl) {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("ACS_PORTFOLIO_BASE_URL must be loopback (127.0.0.1 or localhost)");
  }
}

async function getJson(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${path}`);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`non-object JSON for ${path}`);
    }
    if ("token" in body || "privateKey" in body || "authorization" in body) {
      throw new Error(`credential fields in ${path}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function startFakeVisualizer() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/portfolio") {
      response.end(JSON.stringify({ ...envelope, summary: { repositoryCount: 1 } }));
      return;
    }
    if (request.url === "/api/v1/portfolio/attention") {
      response.end(
        JSON.stringify({
          ...envelope,
          items: [{ fullName: "jnibarger01/visualizer", status: "ATTENTION" }]
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected tcp address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function main() {
  let server = null;
  let baseUrl = process.env.ACS_PORTFOLIO_BASE_URL?.trim();
  if (LIVE) {
    if (!baseUrl) throw new Error("--live requires ACS_PORTFOLIO_BASE_URL");
    assertLoopback(baseUrl);
  } else {
    const fake = await startFakeVisualizer();
    server = fake.server;
    baseUrl = fake.baseUrl;
  }
  try {
    assertLoopback(baseUrl);
    const summary = await getJson(baseUrl, "/api/v1/portfolio");
    const attention = await getJson(baseUrl, "/api/v1/portfolio/attention");
    if (!summary || typeof summary !== "object") throw new Error("summary missing");
    if (!attention || !Array.isArray(attention.items)) throw new Error("attention.items missing");
    console.log("PASS portfolio smoke");
    console.log(JSON.stringify({ mode: LIVE ? "live" : "fake", baseUrl, summaryKeys: Object.keys(summary), attentionCount: attention.items.length }, null, 2));
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

main().catch((error) => {
  console.error("FAIL portfolio smoke:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
