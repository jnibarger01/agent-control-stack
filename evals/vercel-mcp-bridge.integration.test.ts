import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  openBridgeAuthorization,
  createBridgeAuthorizationAad,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { createMcpIngressHandler } from "../apps/vercel-mcp-ingress/src/handler.js";
import { createOauthBearerAuthorizer } from "../apps/vercel-mcp-ingress/src/oauth.js";
import {
  createEncryptedAuthorizationResolver,
  createLocalAcsCaller,
  processBridgeRequest,
  type BridgeReplayPort
} from "../apps/vercel-bridge-worker/src/worker.js";

describe("OAuth Vercel-to-ACS bridge smoke", () => {
  it("keeps bearer plaintext out of transport and restores it only at loopback ACS", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
    const publicKeyPem = String(publicKey.export({ type: "spki", format: "pem" }));
    const bearer = "Bearer jwt.super-secret.payload";
    const replay: BridgeReplayPort = {
      get: () => undefined,
      put: vi.fn()
    };
    let published: BridgeResultEnvelope | undefined;
    const callAcs = createLocalAcsCaller({
      url: "http://127.0.0.1:3000/mcp",
      authorizationResolver: createEncryptedAuthorizationResolver(privateKeyPem),
      now: () => new Date("2026-09-18T16:00:01.000Z"),
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(bearer);
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "list_work_items" }] }
        });
      })
    });

    const handler = createMcpIngressHandler({
      idFactory: () => "req_smoke",
      now: () => Date.parse("2026-09-18T16:00:00.000Z"),
      requestTimeoutMs: 10_000,
      authorizer: createOauthBearerAuthorizer({
        issuer: "https://issuer.example",
        audience: "https://acs.example/mcp",
        jwksUri: "https://issuer.example/jwks",
        resourceMetadataUrl: "https://acs.example/.well-known/oauth-protected-resource/mcp",
        bridgePublicKeyPem: publicKeyPem,
        verifyToken: vi.fn(async () => undefined)
      }),
      roundTrip: async (envelope) => {
        expect(JSON.stringify(envelope)).not.toContain("super-secret");
        expect(envelope.auth).toBeDefined();
        const aad = createBridgeAuthorizationAad({
          requestId: envelope.requestId,
          resultTopic: envelope.resultTopic,
          expiresAt: envelope.expiresAt
        });
        expect(openBridgeAuthorization(envelope.auth!, privateKeyPem, aad)).toBe(bearer);

        await processBridgeRequest(envelope, {
          replay,
          callAcs,
          publishResult: async (_topic, result) => {
            published = result;
          },
          now: () => Date.parse("2026-09-18T16:00:01.000Z")
        });
        if (!published) throw new Error("bridge did not publish a result");
        return published;
      }
    });

    const response = await handler(
      new Request("https://acs.example/mcp", {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "list_work_items" }] }
    });
    expect(replay.put).toHaveBeenCalledTimes(1);
  });
});
