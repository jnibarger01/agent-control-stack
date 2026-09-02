import { readFileSync } from "node:fs";
import {
  DEFAULT_MOA_CONFIG,
  loadMoaConfig,
  moaGatewayPlugin,
  type GatewayDeps,
  type MoaConfig,
  type ModelCaller
} from "@agent-control-stack/moa-orchestrator";
import type { WorkItemStore } from "@agent-control-stack/work-items";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createMoaAcsClient } from "./acs-client.js";
import { HashChainedJsonlAuditSink } from "./audit-sink.js";
import { SqliteMoaIdempotencyStore } from "./idempotency.js";
import { createRoutingModelCaller } from "./model-caller.js";
import {
  HashChainedInferenceAuditSink,
  openAiCompatibleConfigFromEnv,
  registerOpenAiCompatibleGateway
} from "./openai-compatible.js";
import { createSharedRedactor } from "./redactor.js";

export interface MoaGatewayOverrides {
  config?: MoaConfig;
  caller?: ModelCaller;
  auditLogPath?: string;
}

export interface MoaGatewayWiring {
  dbPath: string;
  store: WorkItemStore;
  authenticate: (request: FastifyRequest) => Promise<{ actor: string } | null>;
  overrides?: MoaGatewayOverrides;
}

export function resolveMoaConfig(env: NodeJS.ProcessEnv = process.env): MoaConfig {
  const configPath = env.ACS_MOA_CONFIG;
  return configPath ? loadMoaConfig(JSON.parse(readFileSync(configPath, "utf8"))) : DEFAULT_MOA_CONFIG;
}

export async function registerMoaGateway(app: FastifyInstance, wiring: MoaGatewayWiring): Promise<void> {
  const inference = openAiCompatibleConfigFromEnv();
  if (inference) {
    registerOpenAiCompatibleGateway(app, {
      authenticate: wiring.authenticate,
      apiKey: inference.apiKey,
      upstreamBaseUrl: inference.upstreamBaseUrl,
      allowedModels: inference.allowedModels,
      audit: new HashChainedInferenceAuditSink(inference.auditLogPath),
      maxBodyBytes: inference.maxBodyBytes
    });
  }

  const deps: GatewayDeps = {
    config: wiring.overrides?.config ?? resolveMoaConfig(),
    caller: wiring.overrides?.caller ?? createRoutingModelCaller(),
    acs: createMoaAcsClient(wiring.store),
    audit: new HashChainedJsonlAuditSink(
      wiring.overrides?.auditLogPath ?? process.env.ACS_MOA_AUDIT_LOG ?? "storage/moa-audit.jsonl"
    ),
    redactor: createSharedRedactor(),
    idempotency: new SqliteMoaIdempotencyStore(wiring.dbPath),
    authenticate: wiring.authenticate
  };
  await moaGatewayPlugin(deps)(app);
}

export { createMoaAcsClient, rederiveMoaRisk, verifyExecutableGrant } from "./acs-client.js";
export { SqliteMoaIdempotencyStore } from "./idempotency.js";
export {
  HashChainedInferenceAuditSink,
  openAiCompatibleConfigFromEnv,
  registerOpenAiCompatibleGateway
} from "./openai-compatible.js";
