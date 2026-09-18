import type { VercelRegion } from "@vercel/queue";
import { DEFAULT_MCP_INGRESS_TIMEOUT_MS, createMcpIngressHandler } from "../src/handler.js";
import { createVercelQueueRoundTrip } from "../src/queue.js";
import { createIngressAuthorizerFromEnv } from "../src/auth-config.js";

const authorizer = createIngressAuthorizerFromEnv();
const region = (process.env.ACS_VERCEL_QUEUE_REGION ?? "iad1") as VercelRegion;
const requestTimeoutMs = boundedInteger(
  process.env.ACS_VERCEL_MCP_TIMEOUT_MS,
  DEFAULT_MCP_INGRESS_TIMEOUT_MS,
  5_000,
  110_000
);

const roundTrip = createVercelQueueRoundTrip({
  region,
  consumerGroup: "acs-mcp-ingress",
  requestRetentionSeconds: 300,
  resultVisibilityTimeoutSeconds: 60,
  pollDelayMs: 100
});

const handler = createMcpIngressHandler({
  authorizer,
  roundTrip,
  requestTimeoutMs
});

export const config = {
  maxDuration: 120
};

export default {
  fetch(request: Request) {
    return handler(request);
  }
};

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`ACS_VERCEL_MCP_TIMEOUT_MS must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
