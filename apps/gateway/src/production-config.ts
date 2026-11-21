import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface ProductionConfigIssue {
  key: string;
  message: string;
}

export class ProductionConfigError extends Error {
  readonly code = "production_config_invalid" as const;
  readonly issues: readonly ProductionConfigIssue[];

  constructor(issues: readonly ProductionConfigIssue[]) {
    super(formatProductionConfigError(issues));
    this.name = "ProductionConfigError";
    this.issues = issues;
  }

  toJSON(): { error: "production_config_invalid"; issues: readonly ProductionConfigIssue[] } {
    return { error: this.code, issues: this.issues };
  }
}

export function isStrictConfigMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.ACS_STRICT_CONFIG === "1";
}

/**
 * Fail-fast production / strict-config checks before the gateway listens.
 * Local and ordinary development stay permissive when this returns without throwing.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isStrictConfigMode(env)) {
    return;
  }

  const issues: ProductionConfigIssue[] = [];
  validateCredentials(env, issues);
  validateAuthMode(env, issues);
  validateBindHostAuth(env, issues);
  validateDbPathWritable(env, issues);
  validateForbiddenLocalDevOpts(env, issues);

  if (issues.length > 0) {
    throw new ProductionConfigError(issues);
  }
}

export function reportProductionConfigFailure(
  error: ProductionConfigError,
  stream: { write(chunk: string): unknown } = process.stderr
): void {
  stream.write(`${JSON.stringify(error.toJSON())}\n`);
}

function formatProductionConfigError(issues: readonly ProductionConfigIssue[]): string {
  const keys = issues.map((issue) => issue.key).join(", ");
  return `production_config_invalid: ${keys}`;
}

function validateCredentials(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  const raw = env.ACS_GATEWAY_CREDENTIALS_JSON?.trim();
  if (!raw) {
    issues.push({
      key: "ACS_GATEWAY_CREDENTIALS_JSON",
      message: "required when NODE_ENV=production or ACS_STRICT_CONFIG=1"
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push({
      key: "ACS_GATEWAY_CREDENTIALS_JSON",
      message: "must be valid JSON"
    });
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    issues.push({
      key: "ACS_GATEWAY_CREDENTIALS_JSON",
      message: "must be a non-empty JSON array of credentials"
    });
    return;
  }

  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      issues.push({
        key: "ACS_GATEWAY_CREDENTIALS_JSON",
        message: `entry ${index} must be an object`
      });
      continue;
    }
    const credential = entry as Record<string, unknown>;
    if (typeof credential.id !== "string" || credential.id.length === 0) {
      issues.push({
        key: "ACS_GATEWAY_CREDENTIALS_JSON",
        message: `entry ${index} requires a non-empty id`
      });
    }
    if (typeof credential.token !== "string" || credential.token.length < 32) {
      issues.push({
        key: "ACS_GATEWAY_CREDENTIALS_JSON",
        message: `entry ${index} requires a token of at least 32 characters`
      });
    }
    if (typeof credential.actor !== "string" || credential.actor.length === 0) {
      issues.push({
        key: "ACS_GATEWAY_CREDENTIALS_JSON",
        message: `entry ${index} requires a non-empty actor`
      });
    }
    if (typeof credential.actorId !== "string" || credential.actorId.length === 0) {
      issues.push({
        key: "ACS_GATEWAY_CREDENTIALS_JSON",
        message: `entry ${index} requires a non-empty actorId`
      });
    }
  }
}

function validateAuthMode(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  const oauthKeys = ["ACS_OAUTH_ISSUER", "ACS_OAUTH_AUDIENCE", "ACS_OAUTH_JWKS_URI"] as const;
  const oauthPresent = oauthKeys.map((key) => Boolean(env[key]?.trim()));
  const oauthAny = oauthPresent.some(Boolean);
  const oauthAll = oauthPresent.every(Boolean);
  if (oauthAny && !oauthAll) {
    for (const [index, key] of oauthKeys.entries()) {
      if (!oauthPresent[index]) {
        issues.push({
          key,
          message: "required together with the other ACS_OAUTH_* values"
        });
      }
    }
  }
  if (oauthAll) {
    validateResourceMetadataUrl(env, issues);
  }

  if (env.ACS_AUTH_MODE === "tunnel_id" && !env.ACS_TRUSTED_TUNNEL_PROXY?.trim()) {
    issues.push({
      key: "ACS_TRUSTED_TUNNEL_PROXY",
      message: "required when ACS_AUTH_MODE=tunnel_id"
    });
  }
}

/**
 * The protected-resource metadata URL is the gateway's own endpoint. It cannot be derived from the
 * OAuth audience: the audience identifies the resource and usually lives on the issuer's host, so a
 * derived URL points the MCP client at a path the issuer does not serve.
 */
function validateResourceMetadataUrl(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  const raw = env.ACS_MCP_RESOURCE_METADATA_URL?.trim();
  if (!raw) {
    issues.push({
      key: "ACS_MCP_RESOURCE_METADATA_URL",
      message: "required with OAuth: the gateway's https://<gateway>/.well-known/oauth-protected-resource/mcp URL"
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push({ key: "ACS_MCP_RESOURCE_METADATA_URL", message: "must be an absolute URL" });
    return;
  }
  if (parsed.protocol !== "https:") {
    issues.push({ key: "ACS_MCP_RESOURCE_METADATA_URL", message: "must use https" });
  }
  // The resource server publishes this document. The authorization server (the issuer) must not.
  const issuer = env.ACS_OAUTH_ISSUER?.trim();
  if (issuer) {
    try {
      if (new URL(issuer).origin === parsed.origin) {
        issues.push({
          key: "ACS_MCP_RESOURCE_METADATA_URL",
          message: "must be served by the gateway origin, not the OAuth issuer origin"
        });
      }
    } catch {
      // An invalid issuer is reported by its own validation path.
    }
  }
  if (!parsed.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    issues.push({
      key: "ACS_MCP_RESOURCE_METADATA_URL",
      message: "path must be a /.well-known/oauth-protected-resource endpoint of the gateway"
    });
  }
}

function validateBindHostAuth(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  const host = env.HOST?.trim() || "127.0.0.1";
  if (isLoopbackHost(host)) {
    return;
  }

  if (!env.ACS_MCP_ALLOWED_ORIGINS?.trim()) {
    issues.push({
      key: "ACS_MCP_ALLOWED_ORIGINS",
      message: "required for non-loopback bind hosts"
    });
  }

  const oauthConfigured = Boolean(
    env.ACS_OAUTH_ISSUER?.trim() && env.ACS_OAUTH_AUDIENCE?.trim() && env.ACS_OAUTH_JWKS_URI?.trim()
  );
  const tunnelConfigured = env.ACS_AUTH_MODE === "tunnel_id" && Boolean(env.ACS_TRUSTED_TUNNEL_PROXY?.trim());
  if (!oauthConfigured && !tunnelConfigured) {
    issues.push({
      key: "ACS_AUTH_MODE",
      message:
        "non-loopback bind requires complete OAuth (ACS_OAUTH_ISSUER/AUDIENCE/JWKS_URI) or ACS_AUTH_MODE=tunnel_id with ACS_TRUSTED_TUNNEL_PROXY"
    });
  }
}

function validateDbPathWritable(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  const dbPath = env.ACS_DB_PATH?.trim() || "storage/local.db";
  const directory = dirname(dbPath);
  if (isDbDirectoryWritable(directory)) {
    return;
  }
  issues.push({
    key: "ACS_DB_PATH",
    message: `directory is not writable: ${directory}`
  });
}

function validateForbiddenLocalDevOpts(env: NodeJS.ProcessEnv, issues: ProductionConfigIssue[]): void {
  if (env.ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT === "1") {
    issues.push({
      key: "ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT",
      message: "must not be enabled when NODE_ENV=production or ACS_STRICT_CONFIG=1"
    });
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isDbDirectoryWritable(directory: string): boolean {
  try {
    if (existsSync(directory)) {
      accessSync(directory, constants.W_OK);
      return true;
    }
    let current = directory;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
    accessSync(current, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
