import { createStaticBearerAuthorizer, type IngressAuthorizer } from "./handler.js";
import { createOauthBearerAuthorizer } from "./oauth.js";

type Env = NodeJS.ProcessEnv;

export function createIngressAuthorizerFromEnv(env: Env = process.env): IngressAuthorizer {
  const mode = env.ACS_VERCEL_PUBLIC_AUTH_MODE?.trim() || "static_bearer";
  if (mode === "static_bearer") {
    return createStaticBearerAuthorizer(required(env, "ACS_VERCEL_MCP_TOKEN"));
  }
  if (mode !== "oauth") {
    throw new Error("ACS_VERCEL_PUBLIC_AUTH_MODE must be static_bearer or oauth");
  }

  const resource = required(env, "ACS_VERCEL_PUBLIC_RESOURCE_URL");
  const audience = required(env, "ACS_VERCEL_OAUTH_AUDIENCE");
  if (resource !== audience) {
    throw new Error("ACS_VERCEL_PUBLIC_RESOURCE_URL must match ACS_VERCEL_OAUTH_AUDIENCE");
  }
  return createOauthBearerAuthorizer({
    issuer: required(env, "ACS_VERCEL_OAUTH_ISSUER"),
    audience,
    jwksUri: required(env, "ACS_VERCEL_OAUTH_JWKS_URI"),
    resourceMetadataUrl: required(env, "ACS_VERCEL_RESOURCE_METADATA_URL"),
    bridgePublicKeyPem: required(env, "ACS_VERCEL_BRIDGE_AUTH_PUBLIC_KEY_PEM")
  });
}

export function protectedResourceMetadataFromEnv(env: Env = process.env):
  | {
      resource: string;
      authorization_servers: string[];
      scopes_supported?: string[];
    }
  | undefined {
  const mode = env.ACS_VERCEL_PUBLIC_AUTH_MODE?.trim() || "static_bearer";
  if (mode !== "oauth") return undefined;

  const resource = required(env, "ACS_VERCEL_PUBLIC_RESOURCE_URL");
  const audience = required(env, "ACS_VERCEL_OAUTH_AUDIENCE");
  if (resource !== audience) {
    throw new Error("ACS_VERCEL_PUBLIC_RESOURCE_URL must match ACS_VERCEL_OAUTH_AUDIENCE");
  }
  const authorizationServer =
    env.ACS_VERCEL_OAUTH_AUTHORIZATION_SERVER?.trim() || required(env, "ACS_VERCEL_OAUTH_ISSUER");
  const scopes = (env.ACS_VERCEL_OAUTH_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    resource,
    authorization_servers: [authorizationServer],
    ...(scopes.length > 0 ? { scopes_supported: scopes } : {})
  };
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
