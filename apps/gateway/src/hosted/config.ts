export interface HostedGatewayConfig {
  readonly databaseUrl: string;
  readonly oauthIssuer: string;
  readonly oauthAudience: string;
  readonly oauthJwksUri: string;
  readonly publicOrigin: string;
  readonly maxPendingWorkItems: number;
  readonly maxLeaseMs: number;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required for the hosted ACS gateway`);
  return value;
}

function httpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return parsed.toString().replace(/\/$/u, "");
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Loads the Vercel/Neon gateway contract. This path deliberately rejects all
 * tunnel configuration: the hosted control plane is OAuth/JWT only.
 */
export function loadHostedGatewayConfig(source: NodeJS.ProcessEnv = process.env): HostedGatewayConfig {
  const forbiddenTunnelKeys = [
    "ACS_AUTH_MODE",
    "ACS_TRUSTED_TUNNEL_PROXY",
    "ACS_ALLOWED_TUNNEL_IDS",
    "ACS_TUNNEL_SCOPES",
    "ACS_ALLOW_UNSIGNED_TUNNEL_ID_DEV"
  ] as const;
  const configuredTunnelKey = forbiddenTunnelKeys.find((key) => source[key]?.trim());
  if (configuredTunnelKey) {
    throw new Error(`${configuredTunnelKey} is not supported by the hosted ACS gateway; use OAuth/JWT`);
  }

  const databaseUrl = required(source, "DATABASE_URL");
  const parsedDatabase = new URL(databaseUrl);
  if (parsedDatabase.protocol !== "postgres:" && parsedDatabase.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }

  const oauthIssuer = httpsUrl(required(source, "ACS_OAUTH_ISSUER"), "ACS_OAUTH_ISSUER");
  const oauthAudience = httpsUrl(required(source, "ACS_OAUTH_AUDIENCE"), "ACS_OAUTH_AUDIENCE");
  const oauthJwksUri = httpsUrl(required(source, "ACS_OAUTH_JWKS_URI"), "ACS_OAUTH_JWKS_URI");
  const publicOrigin = httpsUrl(source.ACS_PUBLIC_ORIGIN?.trim() || oauthAudience, "ACS_PUBLIC_ORIGIN");

  return {
    databaseUrl,
    oauthIssuer,
    oauthAudience,
    oauthJwksUri,
    publicOrigin,
    maxPendingWorkItems: positiveInt(source.ACS_MAX_PENDING_WORK_ITEMS, 250, "ACS_MAX_PENDING_WORK_ITEMS"),
    maxLeaseMs: Math.min(positiveInt(source.ACS_MAX_LEASE_MS, 15 * 60_000, "ACS_MAX_LEASE_MS"), 60 * 60_000)
  };
}
