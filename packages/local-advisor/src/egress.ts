/**
 * Node's built-in fetch can route requests through HTTP(S)_PROXY when env proxy mode is on
 * (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`). The loopback check on the base URL does not stop that,
 * so the prompt could leave the machine via the proxy. Refuse to start in that configuration unless
 * NO_PROXY covers every loopback name.
 */
export class EgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressConfigError";
  }
}

const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "::1"] as const;

function envProxyModeOn(env: Readonly<Record<string, string | undefined>>, execArgv: readonly string[]): boolean {
  const flag = (value: string) => value === "--use-env-proxy" || value.startsWith("--use-env-proxy=");
  if (env.NODE_USE_ENV_PROXY !== undefined && env.NODE_USE_ENV_PROXY !== "" && env.NODE_USE_ENV_PROXY !== "0") return true;
  if (execArgv.some(flag)) return true;
  return (env.NODE_OPTIONS ?? "").split(/\s+/u).some(flag);
}

function normalizeNoProxyEntry(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  if (value.startsWith(".")) value = value.slice(1);
  // Strip a trailing :port, but not from a bare IPv6 address.
  const colons = value.split(":").length - 1;
  if (colons === 1) value = value.slice(0, value.indexOf(":"));
  return value;
}

export function noProxyCoversLoopback(noProxy: string | undefined): boolean {
  const entries = new Set((noProxy ?? "").split(/[,\s]+/u).filter(Boolean).map(normalizeNoProxyEntry));
  if (entries.has("*")) return true;
  return LOOPBACK_NAMES.every((name) => entries.has(name) || (name === "127.0.0.1" && entries.has("127.0.0.0/8")));
}

/** Throws when env proxy mode could route loopback advisor traffic through a proxy. Never echoes env values. */
export function assertDirectLoopbackEgress(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[] = []
): void {
  if (!envProxyModeOn(env, execArgv)) return;
  if (!PROXY_VARS.some((name) => (env[name] ?? "") !== "")) return;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (noProxyCoversLoopback(noProxy)) return;
  throw new EgressConfigError(
    "env proxy mode is on and NO_PROXY does not cover 127.0.0.1, localhost and ::1; refusing to start so advisor traffic cannot reach a proxy"
  );
}
