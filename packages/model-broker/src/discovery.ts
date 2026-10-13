import type { ProviderAvailability } from "./types.js";

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const DISCOVERY_TIMEOUT_MS = 2_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * A "local" provider must be on this machine. That classification decides which privacy classes it may serve, so an
 * endpoint that is not loopback is refused rather than quietly treated as local.
 */
export function assertLoopback(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("local provider URL must be http(s)");
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`local provider must be on loopback, not ${url.hostname}`);
  }
  if (url.username || url.password) throw new Error("local provider URL must not embed credentials");
  return url;
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(providerId: string, now: Date, error: unknown): ProviderAvailability {
  return {
    providerId,
    kind: "local",
    reachable: false,
    models: [],
    loadedModels: [],
    checkedAt: now.toISOString(),
    // The error class only: a message from a local server can echo request content.
    error: error instanceof Error ? error.name : "error"
  };
}

function names(value: unknown, key: string): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return undefined;
  return [
    ...new Set(
      list
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined))
        .map((entry) => (typeof entry?.name === "string" ? entry.name : typeof entry?.id === "string" ? entry.id : undefined))
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    )
  ].sort();
}

/** Ollama: `/api/tags` lists installed models and `/api/ps` the ones currently resident in memory. */
export async function discoverOllama(
  fetchFn: FetchLike,
  baseUrl = "http://127.0.0.1:11434",
  now: () => Date = () => new Date(),
  providerId = "ollama"
): Promise<ProviderAvailability> {
  const root = assertLoopback(baseUrl).origin;
  try {
    const installed = names(await getJson(fetchFn, `${root}/api/tags`), "models");
    if (!installed) throw new TypeError("unexpected response shape");
    let loaded: string[] = [];
    try {
      loaded = names(await getJson(fetchFn, `${root}/api/ps`), "models") ?? [];
    } catch {
      // Residency is an optimization input. Not knowing it only means a model is assumed not loaded.
    }
    return { providerId, kind: "local", reachable: true, models: installed, loadedModels: loaded, checkedAt: now().toISOString() };
  } catch (error) {
    return unreachable(providerId, now(), error);
  }
}

/** Any OpenAI-compatible local server (llama.cpp, vLLM, LM Studio): `/v1/models`. */
export async function discoverOpenAiCompatible(
  fetchFn: FetchLike,
  providerId: string,
  baseUrl: string,
  now: () => Date = () => new Date()
): Promise<ProviderAvailability> {
  const root = assertLoopback(baseUrl).origin;
  try {
    const body = (await getJson(fetchFn, `${root}/v1/models`)) as unknown;
    const models = names(body, "data");
    if (!models) throw new TypeError("unexpected response shape");
    return { providerId, kind: "local", reachable: true, models, loadedModels: [], checkedAt: now().toISOString() };
  } catch (error) {
    return unreachable(providerId, now(), error);
  }
}

/**
 * Hosted providers are reported as configured, not as reachable or valid: a credential's presence says nothing about its
 * validity, and a live call would spend money and send traffic. Only the presence of the named variables is read; no value
 * is retained. Which models a hosted provider serves comes from the catalog, not from here.
 */
export function discoverHostedProviders(
  env: Record<string, string | undefined>,
  providers: Array<{ providerId: string; credentialEnv: string }>,
  now: () => Date = () => new Date()
): ProviderAvailability[] {
  return providers.map(({ providerId, credentialEnv }) => ({
    providerId,
    kind: "hosted" as const,
    reachable: "unknown" as const,
    credentialPresent: typeof env[credentialEnv] === "string" && env[credentialEnv]!.length > 0,
    models: [],
    loadedModels: [],
    checkedAt: now().toISOString()
  }));
}
