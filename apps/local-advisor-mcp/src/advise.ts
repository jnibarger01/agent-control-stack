import {
  DEFAULT_MODEL_ROUTES,
  assertOllamaBaseUrl,
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

/** Deadline for route discovery (`/api/tags`). Discovery runs before the request budget timer starts. */
export const DISCOVERY_TIMEOUT_MS = 2_000;

export type AdvisorEnv = Readonly<Record<string, string | undefined>>;

export interface AdviseDeps {
  readonly fetchImpl?: typeof fetch;
  readonly discoveryTimeoutMs?: number;
}

function routesFromEnv(env: AdvisorEnv): readonly ModelRoute[] {
  const raw = env.ACS_LOCAL_ADVISOR_ROUTES;
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

function digestFromEnv(env: AdvisorEnv): `sha256:${string}` | undefined {
  const raw = env.ACS_LOCAL_ADVISOR_EXPECTED_DIGEST;
  if (!raw) return undefined;
  return asDigest(raw);
}

export type Advise = (request: AdvisorRequest, signal: AbortSignal) => Promise<AdvisorResponse>;

function minFreeBytesFromEnv(env: AdvisorEnv): number | undefined {
  const raw = env.ACS_LOCAL_ADVISOR_MIN_FREE_BYTES;
  if (raw === undefined || raw === "") return undefined;
  const value = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value)) throw new Error("ACS_LOCAL_ADVISOR_MIN_FREE_BYTES must be a non-negative integer");
  return value;
}

export function createAdvise(env: AdvisorEnv, deps: AdviseDeps = {}): Advise {
  const providers = new Map<string, OllamaProvider>();
  // Validate every setting once, at startup, so misconfiguration fails before the server accepts a call.
  const pinnedDigest = digestFromEnv(env);
  const baseUrl = env.ACS_LOCAL_ADVISOR_BASE_URL || undefined;
  assertOllamaBaseUrl(baseUrl);
  const minFreeMemoryBytes = minFreeBytesFromEnv(env);
  // Parse routes once so a bad ACS_LOCAL_ADVISOR_ROUTES fails at startup instead of on every call.
  const routes = routesFromEnv(env);
  const discoveryTimeoutMs = deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  return async (request, signal) => {
    let model = env.ACS_LOCAL_ADVISOR_MODEL;
    let expected = pinnedDigest;
    if (!model) {
      const installed = await listInstalledOllamaModels({
        baseUrl,
        fetchImpl: deps.fetchImpl,
        signal: AbortSignal.any([signal, AbortSignal.timeout(discoveryTimeoutMs)])
      });
      const route = selectModelRoute(routes, request.operation, chatModelNames(installed));
      model = route.model;
      expected = asDigest(route.expectedDigest) ?? pinnedDigest;
    }
    // The digest pin and base URL are frozen into a provider, so both are part of its identity.
    const cacheKey = JSON.stringify([model, expected ?? null, baseUrl ?? null]);
    let provider = providers.get(cacheKey);
    if (!provider) {
      provider = new OllamaProvider({
        model,
        baseUrl,
        expectedDigest: expected,
        fetchImpl: deps.fetchImpl,
        maxConcurrency: 1,
        retries: 1,
        minFreeMemoryBytes
      });
      providers.set(cacheKey, provider);
    }
    return runAdvisor(request, provider, { signal });
  };
}
