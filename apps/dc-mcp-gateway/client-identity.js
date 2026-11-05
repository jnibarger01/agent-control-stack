import crypto from "node:crypto";

/**
 * JC OAuth subject bound to one client_id.
 *
 * Raw client ids do not fit `x-jc-actor`: registration ids are base64url
 * (underscore) and CIMD ids are URLs (slash, and often longer than 128).
 * `chatgpt:` plus this subject is 82 characters and matches
 * `/^[A-Za-z0-9._:@-]{1,128}$/u`. The exact client_id stays in the token
 * `client_id` claim and in the ACS issue body; ACS fences grants on that id.
 */
export function jcClientSubject(clientId) {
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error("client_id required");
  }
  return `jc-client:${crypto.createHash("sha256").update(clientId).digest("hex")}`;
}

export function jcActorForClient(clientId) {
  return `chatgpt:${jcClientSubject(clientId)}`;
}

/** Desktop Commander keeps the owner subject. Each JC client gets its own. */
export function tokenSubject(lane, clientId) {
  return lane && lane.name === "jc" ? jcClientSubject(clientId) : "jacen";
}
