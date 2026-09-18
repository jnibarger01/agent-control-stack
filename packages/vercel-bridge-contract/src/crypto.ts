import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from "node:crypto";

export interface BridgeEncryptedAuthorization {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface BridgeAuthorizationAadInput {
  requestId: string;
  resultTopic: string;
  expiresAt: string;
}

const INFO = Buffer.from("acs-vercel-bridge-auth-v1", "utf8");

export function createBridgeAuthorizationAad(input: BridgeAuthorizationAadInput): string {
  return ["acs-vercel-bridge-auth-v1", input.requestId, input.resultTopic, input.expiresAt].join("\n");
}
export function sealBridgeAuthorization(
  authorization: string,
  recipientPublicKeyPem: string,
  aad: string
): BridgeEncryptedAuthorization {
  const recipient = createPublicKey(recipientPublicKeyPem);
  if (recipient.asymmetricKeyType !== "x25519") {
    throw new Error("bridge authorization public key must be X25519");
  }

  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient
  });
  const salt = randomBytes(32);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
  const plaintext = Buffer.from(authorization, "utf8");
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ephemeralPublicKey = ephemeral.publicKey.export({
      type: "spki",
      format: "der"
    });

    return {
      version: 1,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString("base64url"),
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
    shared.fill(0);
  }
}
export function openBridgeAuthorization(
  sealed: BridgeEncryptedAuthorization,
  recipientPrivateKeyPem: string,
  aad: string
): string {
  if (sealed.version !== 1) {
    throw new Error("unsupported bridge authorization envelope version");
  }
  const recipient = createPrivateKey(recipientPrivateKeyPem);
  if (recipient.asymmetricKeyType !== "x25519") {
    throw new Error("bridge authorization private key must be X25519");
  }
  const ephemeralPublicKey = createPublicKey({
    key: Buffer.from(sealed.ephemeralPublicKey, "base64url"),
    type: "spki",
    format: "der"
  });
  if (ephemeralPublicKey.asymmetricKeyType !== "x25519") {
    throw new Error("bridge authorization ephemeral key must be X25519");
  }

  const shared = diffieHellman({
    privateKey: recipient,
    publicKey: ephemeralPublicKey
  });
  const salt = Buffer.from(sealed.salt, "base64url");
  const key = Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
  const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } finally {
    plaintext?.fill(0);
    ciphertext.fill(0);
    key.fill(0);
    shared.fill(0);
  }
}
