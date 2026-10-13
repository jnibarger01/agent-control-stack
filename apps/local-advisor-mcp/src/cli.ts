#!/usr/bin/env node
import {
  DEFAULT_MODEL_ROUTES,
  chatModelNames,
  listInstalledOllamaModels,
  OllamaProvider,
  parseModelRoutes,
  runAdvisor,
  selectModelRoute,
  type AdvisorRequest,
  type AdvisorResponse,
  type ModelRoute
} from "@agent-control-stack/local-advisor";
import { LocalAdvisorMcpServer } from "./server.js";

/**
 * stdio MCP server. Does not listen on a port and does not edit client config.
 *
 *   ACS_LOCAL_ADVISOR_MODEL=qwen2.5-coder:7b          pin one installed model
 *   ACS_LOCAL_ADVISOR_EXPECTED_DIGEST=sha256:<64hex>  optional pin
 *   ACS_LOCAL_ADVISOR_BASE_URL=http://127.0.0.1:11434 loopback only
 *   ACS_LOCAL_ADVISOR_ROUTES=<json>                  overrides DEFAULT_MODEL_ROUTES when MODEL is unset
 *   ACS_LOCAL_ADVISOR_MIN_FREE_BYTES=<n>             refuse inference under memory pressure
 */
function routesFromEnv(): readonly ModelRoute[] {
  const raw = process.env.ACS_LOCAL_ADVISOR_ROUTES;
  if (!raw) return DEFAULT_MODEL_ROUTES;
  return parseModelRoutes(JSON.parse(raw));
}

function asDigest(value: string | undefined): `sha256:${string}` | undefined {
  if (value === undefined) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error("expected digest must be sha256:<64 hex>");
  }
  return value as `sha256:${string}`;
}

function digestFromEnv(): `sha256:${string}` | undefined {
  const raw = process.env.ACS_LOCAL_ADVISOR_EXPECTED_DIGEST;
  if (!raw) return undefined;
  return asDigest(raw);
}

const providers = new Map<string, OllamaProvider>();

async function advise(request: AdvisorRequest, signal: AbortSignal): Promise<AdvisorResponse> {
  const baseUrl = process.env.ACS_LOCAL_ADVISOR_BASE_URL;
  const pinnedDigest = digestFromEnv();
  let model = process.env.ACS_LOCAL_ADVISOR_MODEL;
  let expected = pinnedDigest;
  if (!model) {
    const installed = await listInstalledOllamaModels({ baseUrl, signal });
    const route = selectModelRoute(routesFromEnv(), request.operation, chatModelNames(installed));
    model = route.model;
    expected = asDigest(route.expectedDigest) ?? pinnedDigest;
  }
  let provider = providers.get(model);
  if (!provider) {
    const minRaw = process.env.ACS_LOCAL_ADVISOR_MIN_FREE_BYTES;
    provider = new OllamaProvider({
      model,
      baseUrl,
      expectedDigest: expected,
      maxConcurrency: 1,
      retries: 1,
      minFreeMemoryBytes: minRaw ? Number(minRaw) : undefined
    });
    providers.set(model, provider);
  }
  return runAdvisor(request, provider, { signal });
}

const server = new LocalAdvisorMcpServer(process.stdin, process.stdout, (request, signal) =>
  advise(request as AdvisorRequest, signal)
);

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});

server.start();
