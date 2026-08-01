import { z } from "zod";
import { loadRuntimeConfig } from "@agent-control-stack/shared";

const portSchema = z.coerce.number().int().min(1).max(65_535);

export interface GatewayListenConfig {
  host: string;
  port: number;
}

export function gatewayListenConfig(env: NodeJS.ProcessEnv = process.env): GatewayListenConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  if (env.NODE_ENV === "production" && !isLoopbackHost(host) && !env.ACS_GATEWAY_TOKEN) {
    throw new Error("ACS_GATEWAY_TOKEN is required for remote production binding");
  }
  if (
    env.NODE_ENV === "production" &&
    !isLoopbackHost(host) &&
    env.ACS_GATEWAY_TOKEN &&
    !(env.ACS_OAUTH_ISSUER && env.ACS_OAUTH_AUDIENCE && env.ACS_OAUTH_JWKS_URI) &&
    !(env.ACS_AUTH_MODE === "tunnel_id" && env.ACS_TRUSTED_TUNNEL_PROXY)
  ) {
    throw new Error("remote production binding requires complete OAuth or trusted tunnel authentication");
  }
  const config = loadRuntimeConfig(env);
  return { host: config.gateway.host, port: portSchema.parse(env.PORT ?? config.gateway.port) };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
