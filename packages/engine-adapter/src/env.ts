// Mirrors packages/machine-controller/src/command.ts's subprocessEnvAllowlist
// and harness/claude-cli-provider.ts's claudeCliEnvAllowlist: deny-by-default,
// not redact-after-the-fact. Model-backed engine CLIs need outbound network
// access to their own API (see docs/adr - engine-adapter network scope is a
// separate, tracked gap: this allowlist controls which *environment values*
// reach the child, not whether the child can reach the network at all).
const baseEngineEnvAllowlist = [
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
] as const;

export interface EngineEnvOptions {
  /** Additional allowlisted variable names (e.g. an engine-specific API key). */
  extra?: readonly string[];
  source?: NodeJS.ProcessEnv;
}

export function engineSubprocessEnv(options: EngineEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const allowlist = new Set<string>([...baseEngineEnvAllowlist, ...(options.extra ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
