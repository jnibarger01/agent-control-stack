import { createRemoteJWKSet, jwtVerify } from "jose";
import { createBridgeAuthorizationAad, sealBridgeAuthorization } from "@agent-control-stack/vercel-bridge-contract";
import type { IngressAuthorizer } from "./handler.js";

export interface OauthBearerAuthorizerOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  resourceMetadataUrl: string;
  bridgePublicKeyPem: string;
  verifyToken?: (token: string) => Promise<void>;
}

export function createOauthBearerAuthorizer(options: OauthBearerAuthorizerOptions): IngressAuthorizer {
  requireHttps(options.issuer, "issuer");
  requireHttps(options.jwksUri, "jwksUri");
  requireHttps(options.resourceMetadataUrl, "resourceMetadataUrl");

  const verifyToken =
    options.verifyToken ??
    createJwtVerifier({
      issuer: options.issuer,
      audience: options.audience,
      jwksUri: options.jwksUri
    });

  return async (request, context) => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return {
        ok: false,
        wwwAuthenticate: discoveryChallenge(options.resourceMetadataUrl)
      };
    }
    const token = match[1];
    try {
      await verifyToken(token);
    } catch {
      return {
        ok: false,
        wwwAuthenticate: `${discoveryChallenge(options.resourceMetadataUrl)}, error="invalid_token"`
      };
    }

    const aad = createBridgeAuthorizationAad(context);
    return {
      ok: true,
      auth: sealBridgeAuthorization(`Bearer ${token}`, options.bridgePublicKeyPem, aad)
    };
  };
}

function createJwtVerifier(input: {
  issuer: string;
  audience: string;
  jwksUri: string;
}): (token: string) => Promise<void> {
  const jwks = createRemoteJWKSet(new URL(input.jwksUri));
  return async (token: string) => {
    await jwtVerify(token, jwks, {
      issuer: input.issuer,
      audience: input.audience
    });
  };
}

function discoveryChallenge(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}"`;
}

function requireHttps(value: string, name: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
}
