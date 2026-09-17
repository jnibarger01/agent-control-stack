# ACS/DC v1 Managed Capability Contract

Status: Final architecture contract for `acs.dc.v1`.

This document is the implementation reference for the managed ACS to Desktop Commander capability boundary. It is normative: implementations MUST fail closed on malformed, ambiguous, incomplete, stale, mismatched, or unverifiable input.

## 1. Trust boundary and transport

ACS is the sole issuer and authority for capabilities. Desktop Commander (DC) is an untrusted capability consumer and verifier. ACS retains the Ed25519 private key; DC receives only configured public verification material.

A capability is accepted only on MCP `tools/call`, at `params._meta.acsCapability`. The value is exactly this envelope, with no extra keys:

```json
{ "payload": {}, "signature": "<unpadded-base64url>", "keyId": "<key-id>" }
```

The envelope is not signed; `payload` is the signed object. JSON duplicate keys, unknown keys, metadata outside this location, client-supplied identity/authority fields, and environment-provided capability strings are rejected.

`keyId` is printable ASCII, 1–64 characters, matching `^[A-Za-z0-9._:-]+$`. It MUST equal the configured key ID. v1 fixes Ed25519 and therefore has no `alg` field. Key rotation is an explicit key-ID/public-key configuration change; missing, unknown, or mismatched key IDs fail closed.

## 2. Exact signed payload

The payload has exactly these keys. `approvalId` is conditional as specified below and is absent, not null or empty, when not required.

| Claim                 | Required representation                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `version`             | string exactly `acs.dc.v1`                                                                |
| `issuer`              | string exactly `acs`                                                                      |
| `audience`            | string exactly `desktop-commander`                                                        |
| `runtimeId`           | nonempty ACS ID, 1–128 ASCII chars, `^[A-Za-z0-9._:-]+$`                                  |
| `workItemId`          | nonempty ACS ID, same grammar                                                             |
| `attemptId`           | nonempty ACS ID, same grammar                                                             |
| `leaseId`             | nonempty ACS ID, same grammar                                                             |
| `leaseEpoch`          | safe JSON integer, >= 0                                                                   |
| `toolName`            | nonempty ASCII identifier, 1–128 chars                                                    |
| `normalizedArguments` | JSON plain object produced by the canonical ACS adapter validation and path normalization |
| `invocationHash`      | lowercase 64-hex SHA-256 digest                                                           |
| `actionHash`          | lowercase 64-hex SHA-256 digest                                                           |
| `requestHash`         | lowercase 64-hex SHA-256 digest                                                           |
| `planHash`            | lowercase 64-hex SHA-256 digest                                                           |
| `scopes`              | nonempty, unique, sorted array from the fixed v1 vocabulary                               |
| `approvalId`          | opaque ACS approval ID, present iff the tool policy requires approval                     |
| `issuedAt`            | UTC RFC3339 timestamp with exactly millisecond precision                                  |
| `expiresAt`           | UTC RFC3339 timestamp with exactly millisecond precision                                  |
| `nonce`               | unpadded base64url encoding of exactly 32 cryptographically random bytes (43 chars)       |

The fixed v1 scope vocabulary is: `fs.read`, `fs.write`, `process.exec`, `process.spawn`, `network.read`, `network.write`. Payload scopes MUST equal the exact sorted-unique required scope set for `toolName`; missing and extra scopes are rejected.

For v1, the adapter mapping is:

- filesystem reads: `fs.read`
- filesystem create/write/edit/move: `fs.write`
- `start_process`: `process.spawn`
- `list_sessions`, `list_processes`, `read_process_output`, `get_usage_stats`: `process.exec`

## 3. Canonicalization and signature

Both ACS and DC implement `strictCanonicalJsonV1`:

1. Recursively sort own enumerable plain-object keys by UTF-16/Unicode code-unit lexicographic order.
2. Preserve array element order.
3. Encode primitives with JSON encoding, without whitespace or a trailing newline.
4. Reject `undefined`, sparse arrays, non-finite numbers, bigint, symbol, function, accessors, non-enumerable properties, extra array properties, non-plain objects, and cycles.
5. Do not normalize Unicode, coerce types, reorder arrays, or omit fields.

The signed bytes are exactly:

`UTF-8(strictCanonicalJsonV1(payload))`

The signature is the raw 64-byte Ed25519 signature over those bytes, encoded as unpadded base64url. ACS uses a PKCS#8 DER private key from `ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY` (base64url). DC uses a base64url SPKI DER public key from `DESKTOP_COMMANDER_ACS_PUBLIC_KEY` and `DESKTOP_COMMANDER_ACS_KEY_ID`. No HMAC, shared private key, fallback key, or alternate canonicalizer is permitted.

## 4. Hash and argument binding

`normalizedArguments` is the exact Zod-validated, containment/path-normalized argument object ACS will send to DC. DC validates and normalizes the actual request identically, then compares it structurally and exactly.

v1 retains the existing ACS invocation fingerprint. It is not replaced by strict signing canonicalization:

`invocationHash = SHA-256(UTF-8("acs:desktop-commander-invocation:v1" + LF + canonicalJson({"toolName": toolName, "arguments": normalizedArguments})))`

The separator is one actual byte `0x0a` (LF). `canonicalJson` here is the existing ACS representation: recursively sorted object keys with JSON.stringify semantics. Validated v1 arguments contain no `undefined`, so legacy undefined handling is unreachable for this payload.

`actionHash`, `requestHash`, and `planHash` are ACS-produced lowercase SHA-256/64-hex values. DC treats them as opaque and compares them exactly against its trusted request/lease context; it MUST NOT recompute them under another domain.

## 5. Approval, lease, and issuance requirements

ACS signs only after rechecking, in the authoritative transaction where required:

- active policy and exact normalized invocation;
- current work item, attempt, lease ID, and lease epoch/fencing ownership;
- active registered runtime identity and exact allowed scopes;
- `actionHash`, `requestHash`, and `planHash` bindings;
- approval requirement and approval binding.

When approval is required, the ACS approval record is consumed transactionally and MUST bind `planHash`, `actionHash`, `requestHash`, `runtimeId`, exact scopes, subject, and expiry. Reused, expired, revoked, missing, malformed, or mismatched approvals fail closed. DC does not grant authority from `approvalId`; it compares the opaque value exactly and enforces presence/absence according to tool policy.

## 6. Time and nonce replay

ACS capability lifetime MUST be no greater than 30 seconds. DC allows at most 5 seconds of clock skew and accepts only:

- `issuedAt <= now + 5 seconds`;
- `expiresAt > now - 5 seconds`;
- `expiresAt > issuedAt`;
- `expiresAt - issuedAt <= 30 seconds`.

DC atomically reserves `(keyId, nonce)` before invoking a handler and retains the reservation through `expiresAt + 5 seconds`. A second use is rejected. Replay-store exhaustion or unavailability fails closed. ACS may persist only a one-way nonce hash for audit/provenance; raw nonces must not be logged or persisted unnecessarily.

## 7. Managed runtime identity bootstrap

Before any managed lease or capability issuance, ACS sends this exact private-stdio MCP initialize request field:

`initialize.params._meta.acsRuntimeBootstrap`

```json
{
  "schemaVersion": 1,
  "runtimeId": "<expected-runtime-id>",
  "challenge": "<43-char-unpadded-base64url>",
  "scopes": ["<sorted-scope>"]
}
```

The object has exactly those four keys. `schemaVersion` is integer `1`; `challenge` encodes exactly 32 random bytes and MUST be echoed byte-for-byte; scopes are nonempty, known, unique, and lexicographically sorted. The field is present only in managed mode. Standalone mode omits and ignores it.

DC replies in initialize result metadata with exactly:

`_meta.acsRuntimeIdentity = {schemaVersion: 1, runtimeId, challenge, scopes}`

ACS registers `(runtimeId, DC public identity/config fingerprint, allowed scopes, active status)` in authoritative storage. Missing response, challenge mismatch, runtime or identity drift, scope drift, revoked status, malformed/extra fields, or any mismatch aborts managed startup and prevents issuance. A revocation or drift signal terminates the managed session. Runtime identity authenticates presence; it does not replace signed capability authorization.

## 8. Required rejection behavior

Implementations expose stable, non-secret structured rejection codes for missing/malformed/extra/unknown capability fields, key or signature failure, version/issuer/audience mismatch, runtime/work-item/attempt/lease/epoch/tool/argument/hash/scope/approval mismatch, invalid time or nonce, nonce replay, and missing/drifted/revoked runtime identity. Errors MUST NOT include capability contents, normalized arguments, signatures, private material, or secrets.

## 9. Interoperability vector

The following values are test-only. Seed: `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`. Raw public key, base64url: `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`.

For the canonical payload in the companion architecture decision, the authoritative v1 invocation hash uses the actual LF separator and is:

`6af81e88c93e386faa99e6632a2ae5ffddc020bce94fe328457333cb2b5d065c`

With that corrected hash and the published test seed, the authoritative raw signature, unpadded base64url, is:

`AuwuJGjaMYpo6aQ9rJwGAzNZ3sYD2qfFETKavOk5kYOMVFpfFXven56q3eBdczDI-GSl7ujzqKDuxURqOwp5BA`

A conforming implementation verifies the vector and rejects every single-claim mutation, duplicate or extra key, wrong key ID, reordered array, changed normalized argument, expired timestamp, or second use of the nonce.

A future invocation-hash algorithm requires a new capability version and new vectors. v1 MUST never silently reinterpret stored hashes.
