import { createPrivateKey, sign } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { signedPayload } from "./provenance.js";
import type { IngestDraft } from "./types.js";

/**
 * Signs a draft's authoritative fields with an ACS Ed25519 private key (PKCS#8 PEM). The signature covers exactly the
 * fields verifyProvenance checks, so changing any of them afterwards invalidates it.
 *
 * This module uses node:crypto and holds key handling. It is intentionally not re-exported from the package index,
 * which the browser UI bundles. Only ACS-side code and tests may import it, and production keys must never be
 * committed, bundled, or logged. Tests use keys generated at runtime.
 */
export function signRecordDraft(draft: IngestDraft, privateKeyPem: string, keyId: string): IngestDraft {
  if (!keyId || typeof keyId !== "string") throw new Error("keyId is required");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const data = Buffer.from(canonicalJson(signedPayload(draft)), "utf8");
  const signature = sign(null, data, key).toString("base64");
  return { ...draft, provenance: { keyId, signature } };
}
