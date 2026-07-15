import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65_535);

export interface GatewayListenConfig {
  host: string;
  port: number;
}

export function gatewayListenConfig(env: NodeJS.ProcessEnv = process.env): GatewayListenConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = portSchema.parse(env.PORT ?? 3000);
  if (env.NODE_ENV === "production" && !isLoopbackHost(host)) {
    if (!env.ACS_GATEWAY_TOKEN) {
      throw new Error("ACS_GATEWAY_TOKEN is required for remote production binding");
    }
    const oauthConfigured = Boolean(env.ACS_OAUTH_ISSUER && env.ACS_OAUTH_AUDIENCE && env.ACS_OAUTH_JWKS_URI);
    const tunnelConfigured = env.ACS_AUTH_MODE === "tunnel_id" && Boolean(env.ACS_TRUSTED_TUNNEL_PROXY);
    if (!oauthConfigured && !tunnelConfigured) {
      throw new Error("remote production binding requires complete OAuth or trusted tunnel authentication");
    }
  }
  return { host, port };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
