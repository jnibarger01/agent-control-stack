import { z } from "zod";
export { createBridgeAuthorizationAad, openBridgeAuthorization, sealBridgeAuthorization } from "./crypto.js";
export type { BridgeAuthorizationAadInput, BridgeEncryptedAuthorization } from "./crypto.js";

export const VERCEL_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const VERCEL_BRIDGE_REQUEST_TOPIC = "acs-mcp-requests-v1";
export const MAX_BRIDGE_ENVELOPE_BYTES = 256 * 1024;

const bridgeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const bridgeTopicSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9_-]+$/);

export function serializedEnvelopeBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Number.POSITIVE_INFINITY;
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function enforceEnvelopeSize(value: unknown, ctx: z.RefinementCtx): void {
  if (serializedEnvelopeBytes(value) > MAX_BRIDGE_ENVELOPE_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `bridge envelope exceeds ${MAX_BRIDGE_ENVELOPE_BYTES} bytes`
    });
  }
}
const base64UrlSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/);

export const bridgeEncryptedAuthorizationSchema = z
  .object({
    version: z.literal(1),
    ephemeralPublicKey: base64UrlSchema.max(256),
    salt: base64UrlSchema.max(128),
    iv: base64UrlSchema.max(64),
    tag: base64UrlSchema.max(64),
    ciphertext: base64UrlSchema
  })
  .strict();

export const bridgeRequestEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(VERCEL_BRIDGE_PROTOCOL_VERSION),
    requestId: bridgeIdSchema,
    resultTopic: bridgeTopicSchema,
    expiresAt: z.string().datetime(),
    auth: bridgeEncryptedAuthorizationSchema.optional(),
    body: z.unknown()
  })
  .strict()
  .superRefine(enforceEnvelopeSize);

export const bridgeResultEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(VERCEL_BRIDGE_PROTOCOL_VERSION),
    requestId: bridgeIdSchema,
    statusCode: z.number().int().min(100).max(599),
    body: z.unknown().optional(),
    wwwAuthenticate: z.string().max(4096).optional()
  })
  .strict()
  .superRefine(enforceEnvelopeSize);

export type BridgeRequestEnvelope = z.infer<typeof bridgeRequestEnvelopeSchema>;
export type BridgeResultEnvelope = z.infer<typeof bridgeResultEnvelopeSchema>;
