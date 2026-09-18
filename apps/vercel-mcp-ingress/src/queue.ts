import { PollingQueueClient, type VercelRegion } from "@vercel/queue";
import {
  VERCEL_BRIDGE_REQUEST_TOPIC,
  bridgeResultEnvelopeSchema,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { BridgeTimeoutError, type BridgeRoundTrip } from "./handler.js";

export interface PollingQueuePort {
  send(
    topic: string,
    payload: unknown,
    options?: {
      idempotencyKey?: string;
      retentionSeconds?: number;
    }
  ): Promise<{ messageId: string | null }>;
  receive(
    topic: string,
    consumerGroup: string,
    handler: (message: unknown) => Promise<void>,
    options?: {
      limit?: number;
      visibilityTimeoutSeconds?: number;
    }
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "empty" }
    | { ok: false; reason: "not_found" | "not_available" | "already_processed"; messageId: string }
  >;
}

export interface QueueRoundTripOptions {
  consumerGroup?: string;
  pollDelayMs?: number;
  resultVisibilityTimeoutSeconds?: number;
  requestRetentionSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export function createQueueRoundTrip(queue: PollingQueuePort, options: QueueRoundTripOptions = {}): BridgeRoundTrip {
  const consumerGroup = options.consumerGroup ?? "acs-mcp-ingress";
  const pollDelayMs = options.pollDelayMs ?? 100;
  const visibilityTimeoutSeconds = options.resultVisibilityTimeoutSeconds ?? 60;
  const retentionSeconds = options.requestRetentionSeconds ?? 300;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  return async (request: BridgeRequestEnvelope, timeoutMs: number) => {
    await queue.send(VERCEL_BRIDGE_REQUEST_TOPIC, request, {
      idempotencyKey: request.requestId,
      retentionSeconds
    });

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      let resolved: BridgeResultEnvelope | undefined;
      const receiveResult = await queue.receive(
        request.resultTopic,
        consumerGroup,
        async (message) => {
          const parsed = bridgeResultEnvelopeSchema.safeParse(message);
          if (!parsed.success) {
            throw new Error("invalid bridge result envelope");
          }
          if (parsed.data.requestId !== request.requestId) {
            throw new Error("bridge result correlation mismatch");
          }
          resolved = parsed.data;
        },
        {
          limit: 1,
          visibilityTimeoutSeconds
        }
      );

      if (resolved) {
        return resolved;
      }
      if (receiveResult.ok === false) {
        if (receiveResult.reason !== "empty") {
          throw new Error(`bridge result receive failed: ${receiveResult.reason}`);
        }
      }
      if (pollDelayMs > 0) {
        await sleep(Math.min(pollDelayMs, Math.max(0, deadline - now())));
      }
    }

    throw new BridgeTimeoutError();
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VercelQueueRoundTripOptions extends QueueRoundTripOptions {
  region: VercelRegion;
  token?: string;
}

type PollingQueueFactory = (options: { region: VercelRegion; token?: string; deploymentId: null }) => PollingQueuePort;

export function createVercelQueueRoundTrip(
  options: VercelQueueRoundTripOptions,
  factory: PollingQueueFactory = (clientOptions) => new PollingQueueClient(clientOptions) as PollingQueuePort
): BridgeRoundTrip {
  const clientOptions: {
    region: VercelRegion;
    token?: string;
    deploymentId: null;
  } = {
    region: options.region,
    ...(options.token ? { token: options.token } : {}),
    deploymentId: null
  };
  const queue = factory(clientOptions);
  return createQueueRoundTrip(queue, options);
}
