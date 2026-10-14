/**
 * Node's built-in fetch routes requests through HTTP(S)_PROXY when env proxy mode is on
 * (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`). The loopback check on the base URL does not stop that,
 * so a prompt could leave the machine through the proxy. Refuse to start in that configuration unless
 * Node itself would bypass the proxy for the advisor's base URL.
 *
 * `nodeWouldProxy` mirrors Node 24's implementation exactly rather than guessing at NO_PROXY semantics:
 *   - lib/internal/process/pre_execution.js `setupHttpProxy`: active only when `--use-env-proxy` is set
 *     (NODE_USE_ENV_PROXY must equal "1", src/node_options.cc) and one of the proxy variables is non-empty.
 *   - deps/undici/src/lib/dispatcher/env-http-proxy-agent.js: lowercase variables win via `??`
 *     (`no_proxy ?? NO_PROXY`, `http_proxy ?? HTTP_PROXY`, `https_proxy ?? HTTPS_PROXY`), so a defined
 *     but empty lowercase value still shadows the uppercase one. Entries split on `,` and whitespace; a
 *     trailing `:<digits>` is a port that must equal the target port; a leading `.` or `*.` is stripped;
 *     a host matches when equal or when it is a dot-suffix. `*` disables proxying only as the whole value.
 *     The target host keeps IPv6 brackets, so only `[::1]` matches `[::1]`. No CIDR support.
 */
export class EgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

export function envProxyModeOn(env: Env, execArgv: readonly string[]): boolean {
  const flag = (value: string) => value === "--use-env-proxy";
  const fromOptions = (env.NODE_OPTIONS ?? "").split(/\s+/u);
  // Command-line and NODE_OPTIONS flags take effect over the env var; a later --no-use-env-proxy disables it.
  const flags = [...fromOptions, ...execArgv].filter(
    (value) => value === "--use-env-proxy" || value === "--no-use-env-proxy"
  );
  const last = flags.at(-1);
  if (last !== undefined) return flag(last);
  return env.NODE_USE_ENV_PROXY === "1";
}

function proxyFor(target: URL, env: Env): string | undefined {
  const http = env.http_proxy ?? env.HTTP_PROXY;
  if (target.protocol === "https:") {
    const https = env.https_proxy ?? env.HTTPS_PROXY;
    return https ? https : http ? http : undefined;
  }
  return http ? http : undefined;
}

/** True when Node's env-proxy dispatcher would send a request for `target` to a proxy. */
export function nodeWouldProxy(target: URL, env: Env): boolean {
  if (!env.HTTP_PROXY && !env.HTTPS_PROXY && !env.http_proxy && !env.https_proxy) return false;
  if (proxyFor(target, env) === undefined) return false;
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
  const entries = noProxy
    .split(/[,\s]/u)
    .filter((entry) => entry !== "")
    .map((entry) => {
      const parsed = /^(.+):(\d+)$/u.exec(entry);
      return {
        hostname: (parsed ? parsed[1]! : entry).replace(/^\*?\./u, "").toLowerCase(),
        port: parsed ? Number.parseInt(parsed[2]!, 10) : 0
      };
    });
  if (entries.length === 0) return true;
  if (noProxy === "*") return false;
  const hostname = target.host.replace(/:\d*$/u, "").toLowerCase();
  const port = Number.parseInt(target.port, 10) || DEFAULT_PORTS[target.protocol] || 0;
  for (const entry of entries) {
    if (entry.port && entry.port !== port) continue;
    if (hostname === entry.hostname) return false;
    if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) return false;
  }
  return true;
}

/** Throws when env proxy mode would route traffic for `baseUrl` through a proxy. Never echoes env values. */
export function assertDirectLoopbackEgress(env: Env, execArgv: readonly string[], baseUrl: string | URL): void {
  if (!envProxyModeOn(env, execArgv)) return;
  const target = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  if (!nodeWouldProxy(target, env)) return;
  throw new EgressConfigError(
    `env proxy mode is on and NO_PROXY does not exempt ${target.host}; refusing to start so advisor traffic cannot reach a proxy`
  );
}
