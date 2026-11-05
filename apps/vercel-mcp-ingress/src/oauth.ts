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
/**
 * Only these jose errors are a verdict on the TOKEN. Everything else, including `ERR_JOSE_GENERIC` (what jose throws when the
 * JWKS endpoint answers 404/500/502 or an HTML error page) and "no matching key" (which an empty key set during an outage also
 * produces), is a failure to reach a verdict: 503, never "sign in again". Both deny; only the client's reaction differs.
 */
const TOKEN_VERDICT_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JOSE_ALG_NOT_ALLOWED"
]);
export const AUTH_RETRY_AFTER_SECONDS = 5;

function classifyVerifierFailure(error: unknown, resourceMetadataUrl: string): IngressAuthResult {
  if (error instanceof errors.JOSEError && TOKEN_VERDICT_CODES.has(error.code)) {
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
