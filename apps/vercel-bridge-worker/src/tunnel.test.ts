import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAcsTunnelSignaturePayload, createSignedTunnelHeaders } from "./tunnel.js";

describe("local ACS tunnel signing", () => {
  it("matches the existing ACS tunnel signature payload format", () => {
    expect(
      createAcsTunnelSignaturePayload({
        connectorId: "vercel-prod",
        tunnelId: "tunnel_1",
        sessionId: "session_1",
        issuedAt: "2026-09-18T02:00:00.000Z"
      })
    ).toBe("acs-tunnel-v1\nvercel-prod\ntunnel_1\nsession_1\n2026-09-18T02:00:00.000Z");
  });

  it("creates a verifiable Ed25519 assertion without exposing key material", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
    const issuedAt = "2026-09-18T02:00:00.000Z";
    const identity = {
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1"
    };
    const headers = createSignedTunnelHeaders({
      ...identity,
      privateKeyPem,
      issuedAt
    });
    const payload = createAcsTunnelSignaturePayload({ ...identity, issuedAt });
    const encodedSignature = headers["x-acs-signature"].replace("ed25519=", "");

    expect(verifySignature(null, Buffer.from(payload), publicKey, Buffer.from(encodedSignature, "base64url"))).toBe(
      true
    );
    expect(headers).toMatchObject({
      "x-acs-connector-id": identity.connectorId,
      "x-acs-tunnel-id": identity.tunnelId,
      "x-acs-session-id": identity.sessionId,
      "x-acs-issued-at": issuedAt
    });
    expect(JSON.stringify(headers)).not.toContain("PRIVATE KEY");
  });

  it("does not accept an invalid private key", () => {
    expect(() =>
      createSignedTunnelHeaders({
        connectorId: "vercel-prod",
        tunnelId: "tunnel_1",
        sessionId: "session_1",
        privateKeyPem: "not-a-key",
        issuedAt: "2026-09-18T02:00:00.000Z"
      })
    ).toThrow();
  });
});
