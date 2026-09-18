import { PollingQueueClient, type MessageMetadata, type RetryDirective, type VercelRegion } from "@vercel/queue";
import {
  VERCEL_BRIDGE_REQUEST_TOPIC,
  bridgeRequestEnvelopeSchema,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { processBridgeRequest, type BridgeReplayPort, type LocalAcsCaller } from "./worker.js";

export const MAX_BRIDGE_DELIVERIES = 8;

export class InvalidBridgeQueueRequestError extends Error {
  constructor(message = "invalid bridge queue request") {
    super(message);
    this.name = "InvalidBridgeQueueRequestError";
  }
}

export interface WorkerQueuePort {
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
    handler: (message: unknown, metadata: MessageMetadata) => Promise<void>,
    options?: {
      limit?: number;
      visibilityTimeoutSeconds?: number;
      retry?: (error: unknown, metadata: Pick<MessageMetadata, "deliveryCount">) => RetryDirective | void;
    }
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "empty" }
    | {
        ok: false;
        reason: "not_found" | "not_available" | "already_processed";
        messageId: string;
      }
  >;
}

interface WorkerQueueClientOptions {
  region: VercelRegion;
  token: string;
}

type WorkerQueueFactory = (options: { region: VercelRegion; token: string; deploymentId: null }) => WorkerQueuePort;

export function createWorkerQueueClient(
  options: WorkerQueueClientOptions,
  factory: WorkerQueueFactory = (clientOptions) => new PollingQueueClient(clientOptions) as WorkerQueuePort
): WorkerQueuePort {
  return factory({
    region: options.region,
    token: options.token,
    deploymentId: null
  });
}
export interface PollBridgeOnceOptions {
  queue: WorkerQueuePort;
  replay: BridgeReplayPort;
  callAcs: LocalAcsCaller;
  consumerGroup?: string;
  visibilityTimeoutSeconds?: number;
  resultRetentionSeconds?: number;
  expectedAuthMode?: "oauth" | "tunnel";
  now?: () => number;
}

export async function pollBridgeOnce(
  options: PollBridgeOnceOptions
): Promise<
  | { ok: true }
  | { ok: false; reason: "empty" | "not_found" | "not_available" | "already_processed"; messageId?: string }
> {
  const consumerGroup = options.consumerGroup ?? "acs-local-bridge";
  const result = await options.queue.receive(
    VERCEL_BRIDGE_REQUEST_TOPIC,
    consumerGroup,
    async (message) => {
      const parsed = bridgeRequestEnvelopeSchema.safeParse(message);
      if (!parsed.success) {
        throw new InvalidBridgeQueueRequestError();
      }
      if (options.expectedAuthMode === "oauth" && !parsed.data.auth) {
        throw new InvalidBridgeQueueRequestError("OAuth bridge request is missing encrypted authorization");
      }
      if (options.expectedAuthMode === "tunnel" && parsed.data.auth) {
        throw new InvalidBridgeQueueRequestError("tunnel bridge request must not contain OAuth authorization");
      }

      await processBridgeRequest(parsed.data, {
        replay: options.replay,
        callAcs: options.callAcs,
        now: options.now,
        publishResult: async (topic: string, bridgeResult: BridgeResultEnvelope, requestId: string) => {
          await options.queue.send(topic, bridgeResult, {
            idempotencyKey: `result-${requestId}`,
            retentionSeconds: options.resultRetentionSeconds ?? 300
          });
        }
      });
    },
    {
      limit: 1,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 300,
      retry: bridgeRetryDirective
    }
  );

  return result;
}

export function bridgeRetryDirective(error: unknown, metadata: Pick<MessageMetadata, "deliveryCount">): RetryDirective {
  if (error instanceof InvalidBridgeQueueRequestError || metadata.deliveryCount >= MAX_BRIDGE_DELIVERIES) {
    return { acknowledge: true };
  }
  const exponent = Math.min(Math.max(metadata.deliveryCount, 1), 6);
  return { afterSeconds: Math.min(60, 2 ** exponent) };
}
