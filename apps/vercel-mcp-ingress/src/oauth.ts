import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { createBridgeAuthorizationAad, sealBridgeAuthorization } from "@agent-control-stack/vercel-bridge-contract";
import type { IngressAuthorizer, IngressAuthResult } from "./handler.js";

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
    } catch (error) {
      return classifyVerifierFailure(error, options.resourceMetadataUrl);
    }

    const aad = createBridgeAuthorizationAad(context);
    return {
      ok: true,
      auth: sealBridgeAuthorization(`Bearer ${token}`, options.bridgePublicKeyPem, aad)
    };
  };
}

/**
 * "Sign in again" versus "try again later". Only a token the verifier actually judged unusable is a 401 invalid_token
 * (RFC 6750), which makes a client refresh or reconnect. Anything that stops us reaching a verdict (key fetch timeout,
 * network failure, an unexpected error) is a 503 with Retry-After and no challenge, so an outage can never look like
 * expired authorization. The description is fixed text; verifier details are never echoed.
 */
const SERVICE_ERROR_CODES = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"]);
export const AUTH_RETRY_AFTER_SECONDS = 5;

function classifyVerifierFailure(error: unknown, resourceMetadataUrl: string): IngressAuthResult {
  if (error instanceof errors.JOSEError && !SERVICE_ERROR_CODES.has(error.code)) {
    const description =
      error instanceof errors.JWTExpired ? "the access token expired" : "the access token is not valid";
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: `${discoveryChallenge(resourceMetadataUrl)}, error="invalid_token", error_description="${description}"`
    };
  }
  return { ok: false, status: 503, retryAfterSeconds: AUTH_RETRY_AFTER_SECONDS };
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
