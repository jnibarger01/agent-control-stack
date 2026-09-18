import { createPrivateKey, sign } from "node:crypto";

export interface AcsTunnelIdentity {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
}

export interface SignedTunnelInput extends AcsTunnelIdentity {
  privateKeyPem: string;
  issuedAt?: string;
}

export function createAcsTunnelSignaturePayload(input: AcsTunnelIdentity & { issuedAt: string }): string {
  return ["acs-tunnel-v1", input.connectorId, input.tunnelId, input.sessionId, input.issuedAt].join("\n");
}

export function createSignedTunnelHeaders(input: SignedTunnelInput): Record<string, string> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const payload = createAcsTunnelSignaturePayload({ ...input, issuedAt });
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("ACS tunnel private key must be Ed25519");
  }
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");

  return {
    "x-acs-connector-id": input.connectorId,
    "x-acs-tunnel-id": input.tunnelId,
    "x-acs-session-id": input.sessionId,
    "x-acs-issued-at": issuedAt,
    "x-acs-signature": `ed25519=${signature}`
  };
}
