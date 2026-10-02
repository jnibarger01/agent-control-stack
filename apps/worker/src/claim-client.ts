import { z } from "zod";
import { ControlStackError } from "@agent-control-stack/shared";
import { workItemSchema, type ClaimedWorkItem } from "@agent-control-stack/work-items";

const claimedWorkItemSchema = workItemSchema
  .extend({
    workerId: z.string().min(1),
    leaseToken: z.string().min(16).max(512),
    leaseId: z.string().min(1),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().min(1),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    fencingEpoch: z.number().int().positive(),
    workspaceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startedAt: z.string().datetime({ offset: true }),
    leaseExpiresAt: z.string().datetime({ offset: true })
  })
  .strict();

const claimResponseSchema = z.discriminatedUnion("claimed", [
  z.object({ claimed: z.literal(false) }).strict(),
  z.object({ claimed: z.literal(true), workItem: claimedWorkItemSchema }).strict()
]);

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const MAX_CLAIM_RESPONSE_BYTES = 256_000;

export interface AuthenticatedWorkerClaimConfig {
  workerId: string;
  token: string;
  gatewayUrl: URL;
  timeoutMs: number;
}

export type AuthenticatedWorkerClaim = () => Promise<ClaimedWorkItem | undefined>;

export function authenticatedWorkerClaimConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AuthenticatedWorkerClaimConfig | undefined {
  if (env.ACS_NIMBLE_ROUTING_ENABLED !== "1") return undefined;

  const workerId = env.ACS_WORKER_ID?.trim();
  const token = env.ACS_WORKER_TOKEN?.trim();
  if (!workerId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workerId) || !token || token.length < 16) {
    throw new ControlStackError(
      "worker_claim_config_invalid",
      "Nimble worker mode requires ACS_WORKER_ID and ACS_WORKER_TOKEN"
    );
  }

  const gatewayUrl = parseLoopbackGatewayUrl(env.ACS_WORKER_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  const timeoutRaw = env.ACS_WORKER_CLAIM_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_CLAIM_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new ControlStackError(
      "worker_claim_config_invalid",
      "ACS_WORKER_CLAIM_TIMEOUT_MS must be between 100 and 60000"
    );
  }

  return { workerId, token, gatewayUrl, timeoutMs };
}

export function createAuthenticatedWorkerClaim(
  config: AuthenticatedWorkerClaimConfig,
  fetchImpl: typeof fetch = fetch
): AuthenticatedWorkerClaim {
  const endpoint = new URL("/worker/claim", config.gatewayUrl);
  return async () => {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json"
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch {
      throw new ControlStackError("worker_claim_unavailable", "authenticated ACS worker claim request failed");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const code =
        [408, 425, 429].includes(response.status) || response.status >= 500
          ? "worker_claim_unavailable"
          : "worker_claim_rejected";
      throw new ControlStackError(code, `authenticated ACS worker claim returned HTTP ${response.status}`);
    }

    const body = await readBoundedBody(response, MAX_CLAIM_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ControlStackError(
        "worker_claim_invalid_response",
        "authenticated ACS worker claim returned invalid JSON"
      );
    }
    const parsed = claimResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ControlStackError(
        "worker_claim_invalid_response",
        "authenticated ACS worker claim returned an invalid response"
      );
    }
    if (!parsed.data.claimed) return undefined;
    if (parsed.data.workItem.workerId !== config.workerId || parsed.data.workItem.status !== "running") {
      throw new ControlStackError(
        "worker_claim_identity_mismatch",
        "authenticated ACS worker claim did not match this worker"
      );
    }
    return parsed.data.workItem;
  };
}

export function authenticatedWorkerClaimFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): { workerId: string; authenticatedClaim: AuthenticatedWorkerClaim } | undefined {
  const config = authenticatedWorkerClaimConfigFromEnv(env);
  return config
    ? { workerId: config.workerId, authenticatedClaim: createAuthenticatedWorkerClaim(config, fetchImpl) }
    : undefined;
}

function parseLoopbackGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlStackError("worker_claim_config_invalid", "ACS_WORKER_GATEWAY_URL must be a loopback HTTP URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new ControlStackError("worker_claim_config_invalid", "ACS_WORKER_GATEWAY_URL must be a loopback HTTP origin");
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ControlStackError(
          "worker_claim_invalid_response",
          "authenticated ACS worker claim response exceeded its size bound"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
