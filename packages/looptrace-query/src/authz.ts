import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { QueryError } from "./types.js";

/**
 * Agent-specific, resource-level authorization for the read-only query tools.
 *
 * A grant is an HMAC-SHA256-signed, expiring document issued by the operator
 * (never by an agent). It lists scopes (which tool) and a visibility rule (which
 * work items). Holding a grant does not authorise any action; it only bounds what
 * evidence can be read. Fail-closed: no key, bad signature, expired, wrong scope
 * or out-of-visibility all deny, and out-of-visibility is indistinguishable from
 * "not found" (no existence oracle).
 */

export const SCOPES = ["looptrace:trace", "looptrace:gaps", "looptrace:verify"] as const;
export type Scope = (typeof SCOPES)[number];

const visibilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("work_items"), ids: z.array(z.string().min(1).max(160)).min(1).max(200) }).strict(),
  z.object({ mode: z.literal("roots"), ids: z.array(z.string().min(1).max(160)).min(1).max(200) }).strict(),
  z.object({ mode: z.literal("requester_subjects"), subjects: z.array(z.string().min(1).max(160)).min(1).max(50) }).strict(),
  z.object({ mode: z.literal("assigned_to"), ids: z.array(z.string().min(1).max(160)).min(1).max(50) }).strict()
]);

export const grantPayloadSchema = z
  .object({
    v: z.literal(1),
    sub: z.string().min(1).max(160),
    scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
    visibility: visibilitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive()
  })
  .strict();

export type GrantPayload = z.infer<typeof grantPayloadSchema>;

export interface Principal {
  id: string;
  scopes: ReadonlySet<Scope>;
  visibility: GrantPayload["visibility"];
}

/** What visibility rules may look at. Populated from ACS-owned columns only. */
export interface WorkItemRef {
  id: string;
  root_work_item_id: string | null;
  requester_subject: string | null;
  assigned: string[];
}

const b64 = (buf: Buffer): string => buf.toString("base64url");

export function signGrant(payload: GrantPayload, key: Buffer): string {
  const parsed = grantPayloadSchema.parse(payload);
  const body = b64(Buffer.from(JSON.stringify(parsed), "utf8"));
  const sig = b64(createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export function authenticate(token: string | undefined | null, key: Buffer | null, now: Date): Principal {
  if (!key || key.length < 16) throw new QueryError("UNAUTHENTICATED", "no grant key configured; access denied");
  if (!token || token.length > 8192) throw new QueryError("UNAUTHENTICATED", "missing or oversized grant");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new QueryError("UNAUTHENTICATED", "malformed grant");
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[1], "base64url");
  } catch {
    throw new QueryError("UNAUTHENTICATED", "malformed grant");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new QueryError("UNAUTHENTICATED", "grant signature invalid");
  }
  let payload: GrantPayload;
  try {
    payload = grantPayloadSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
  } catch {
    throw new QueryError("UNAUTHENTICATED", "grant payload invalid");
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.exp <= nowSec) throw new QueryError("UNAUTHENTICATED", "grant expired");
  if (payload.iat > nowSec + 300) throw new QueryError("UNAUTHENTICATED", "grant issued in the future");
  return { id: payload.sub, scopes: new Set(payload.scopes), visibility: payload.visibility };
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) throw new QueryError("UNAUTHENTICATED", `grant lacks scope ${scope}`);
}

export function canSee(principal: Principal, ref: WorkItemRef): boolean {
  const v = principal.visibility;
  switch (v.mode) {
    case "all":
      return true;
    case "work_items":
      return v.ids.includes(ref.id);
    case "roots":
      return v.ids.includes(ref.root_work_item_id ?? ref.id);
    case "requester_subjects":
      return ref.requester_subject !== null && v.subjects.includes(ref.requester_subject);
    case "assigned_to":
      return ref.assigned.some((a) => v.ids.includes(a));
  }
}
