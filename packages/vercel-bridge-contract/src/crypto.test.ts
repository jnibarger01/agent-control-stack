import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBridgeAuthorizationAad, openBridgeAuthorization, sealBridgeAuthorization } from "./crypto.js";

describe("bridge authorization encryption", () => {
  it("round-trips a long bearer token using X25519 + AES-256-GCM", () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
    const publicKeyPem = String(publicKey.export({ type: "spki", format: "pem" }));
    const authorization = `Bearer header.${"x".repeat(2400)}.signature`;
    const aad = createBridgeAuthorizationAad({
      requestId: "req_auth",
      resultTopic: "acs-mcp-result-req_auth",
      expiresAt: "2026-09-18T18:00:00.000Z"
    });

    const sealed = sealBridgeAuthorization(authorization, publicKeyPem, aad);

    expect(JSON.stringify(sealed)).not.toContain(authorization);
    expect(openBridgeAuthorization(sealed, privateKeyPem, aad)).toBe(authorization);
  });
  it("binds ciphertext to the request correlation metadata", () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const sealed = sealBridgeAuthorization(
      "Bearer secret",
      String(publicKey.export({ type: "spki", format: "pem" })),
      createBridgeAuthorizationAad({
        requestId: "req_a",
        resultTopic: "acs-mcp-result-req_a",
        expiresAt: "2026-09-18T18:00:00.000Z"
      })
    );

    expect(() =>
      openBridgeAuthorization(
        sealed,
        String(privateKey.export({ type: "pkcs8", format: "pem" })),
        createBridgeAuthorizationAad({
          requestId: "req_b",
          resultTopic: "acs-mcp-result-req_a",
          expiresAt: "2026-09-18T18:00:00.000Z"
        })
      )
    ).toThrow();
  });

  it("rejects non-X25519 keys", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(() =>
      sealBridgeAuthorization("Bearer secret", String(publicKey.export({ type: "spki", format: "pem" })), "aad")
    ).toThrow("X25519");
  });
});
