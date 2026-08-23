// Persistent local device identity for RFC 8628 device authorization.
// Ed25519 via node:crypto - the same primitive apps/gateway/src/auth.ts already uses to
// verify tunnel-connector signatures. No new cryptography is introduced.
import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { credentialsPath, readCredentials, writeCredentials, type StoredCredentials } from "./credential-store.js";

export interface DeviceIdentity {
  devicePrivateKeyPem: string;
  devicePublicKeyPem: string;
  deviceName: string;
}

/**
 * Loads the existing local device keypair, or generates one and persists it. The
 * private key never leaves this function's caller's process; only the public key is
 * ever sent to a server (in the device-code request body).
 */
export function loadOrCreateDeviceIdentity(
  acsUrl: string,
  clientId: string,
  options: { credentialsPathOverride?: string; env?: NodeJS.ProcessEnv } = {}
): DeviceIdentity {
  const path = options.credentialsPathOverride ?? credentialsPath(options.env);
  const existing = readCredentials(path);
  if (existing && existing.acsUrl === acsUrl && existing.clientId === clientId) {
    return {
      devicePrivateKeyPem: existing.devicePrivateKeyPem,
      devicePublicKeyPem: existing.devicePublicKeyPem,
      deviceName: existing.deviceName
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity: DeviceIdentity = {
    devicePrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    devicePublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    deviceName: hostname() || "unknown-device"
  };
  // Switching acsUrl/clientId means a new identity for a different server: any prior
  // session was bound to the old acsUrl and is correctly discarded here.
  const record: StoredCredentials = {
    v: 1,
    acsUrl,
    clientId,
    deviceName: identity.deviceName,
    devicePrivateKeyPem: identity.devicePrivateKeyPem,
    devicePublicKeyPem: identity.devicePublicKeyPem
  };
  writeCredentials(path, record);
  return identity;
}
