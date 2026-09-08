# ACS/DC v1 Managed Capability Contract

Status: Final architecture contract for `acs.dc.v1`.

This document is the implementation reference for the managed ACS to Desktop Commander capability boundary. It is normative: implementations MUST fail closed on malformed, ambiguous, incomplete, stale, mismatched, or unverifiable input.

## 1. Trust boundary and transport

ACS is the sole issuer and authority for capabilities. Desktop Commander (DC) is an untrusted capability consumer and verifier. ACS retains the Ed25519 private key; DC receives only configured public verification material.

A capability is accepted only on MCP `tools/call`, at `params._meta.acsCapability`. The value is exactly this envelope, with no extra keys:

```json
{"payload":{},"signature":"<unpadded-base64url>","keyId":"<key-id>"}
```

The envelope is not signed; `payload` is the signed object. JSON duplicate keys, unknown keys, metadata outside this location, client-supplied identity/authority fields, and environment-provided capability strings are rejected.

`keyId` is printable ASCII, 1–64 characters, matching `^[A-Za-z0-9._:-]+$`. It MUST equal the configured key ID. v1 fixes Ed25519 and therefore has no `alg` field. Key rotation is an explicit key-ID/public-key configuration change; missing, unknown, or mismatched key IDs fail closed.

## 2. Exact signed payload

The payload has exactly these keys. `approvalId` is conditional as specified below and is absent, not null or empty, when not required.

| Claim | Required representation |
|---|---|
| `version` | string exactly `acs.dc.v1` |
| `issuer` | string exactly `acs` |
| `audience` | string exactly `desktop-commander` |
| `runtimeId` | nonempty ACS ID, 1–128 ASCII chars, `^[A-Za-z0-9._:-]+$` |
| `workItemId` | nonempty ACS ID, same grammar |
| `attemptId` | nonempty ACS ID, same grammar |
| `leaseId` | nonempty ACS ID, same grammar |
| `leaseEpoch` | safe JSON integer, >= 0 |
| `toolName` | nonempty ASCII identifier, 1–128 chars |
| `normalizedArguments` | JSON plain object produced by the canonical ACS adapter validation and path normalization |
| `invocationHash` | lowercase 64-hex SHA-256 digest |
| `actionHash` | lowercase 64-hex SHA-256 digest |
| `requestHash` | lowercase 64-hex SHA-256 digest |
| `planHash` | lowercase 64-hex SHA-256 digest |
| `scopes` | nonempty, unique, sorted array from the fixed v1 vocabulary |
| `approvalId` | opaque ACS approval ID, present iff the tool policy requires approval |
| `issuedAt` | UTC RFC3339 timestamp with exactly millisecond precision |
| `expiresAt` | UTC RFC3339 timestamp with exactly millisecond precision |
| `nonce` | unpadded base64url encoding of exactly 32 cryptographically random bytes (43 chars) |

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
{"schemaVersion":1,"runtimeId":"<expected-runtime-id>","challenge":"<43-char-unpadded-base64url>","scopes":["<sorted-scope>"]}
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

## 10. ACS-owned HTTP capability issuer

Status: implemented in `apps/gateway` and `packages/desktop-commander-adapter`. This section is normative for the issuer's own request/response contract; it does not change anything in sections 1-9, which remain the authoritative wire contract between the signed envelope and Desktop Commander.

### 10.1 Purpose and trust separation

Capability issuance can run either in-process (the existing `DesktopCommanderMachineExecutor` path inside `apps/worker`, used when the same process both signs and executes locally) or over HTTP from the ACS gateway (this section), used when the actual Desktop Commander tool call is executed by a separate, untrusted process - such as an OpenClaw Desktop Commander bridge - that never holds ACS's signing key or direct database access.

The gateway process is the only process that ever holds `ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY` for the HTTP issuance path. It is read once from environment into process memory at startup and is never written to a log, an error response, an audit event, or the capability-key discovery response.

The caller of the issuer endpoint (the "bridge") is always someone who has already, through ACS's ordinary work-item lifecycle, claimed and holds an active lease for the exact attempt it is requesting a capability for. The issuer endpoint does not create work items, plans, attempts, or leases, and does not accept a caller-supplied `toolName`, `arguments`, `runtimeId`, `actionHash`, `planHash`, `fencingEpoch`, or any capability field. Every one of those values is re-derived, inside the request, directly from the authoritative work-item/attempt/lease state already recorded by `@agent-control-stack/work-items` - the same re-derivation `authorizeDesktopCommanderExecution` already performs for the in-process path. The only caller-supplied identifier is `attemptId`; `workItemId` comes from the route path, and the caller's identity comes from its authenticated gateway credential, never from a request field.

### 10.2 Endpoint: issue a capability

```
POST /work-items/{workItemId}/desktop-commander/capability
Authorization: Bearer <gateway credential token>
Content-Type: application/json

{"attemptId": "attempt_..."}
```

Request body schema (`desktopCommanderCapabilityRequestSchema` in `apps/gateway/src/public-contracts.ts`) is `.strict()`: `attemptId` is the only accepted field, matching the same identifier grammar as everywhere else in this contract (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`, 1-128 chars). Any other field - including a client-supplied `toolName`, `arguments`, `runtimeId`, `capability`, or `_meta` - is rejected with `400 invalid request` before any store or signing logic runs. There is no way to influence the signed payload's contents from this request; the only degree of freedom the caller has is *which of its own already-leased attempts* to request a capability for.

Response, `201 Created`:

```json
{"capability": {"payload": {...}, "signature": "<unpadded-base64url>", "keyId": "<key-id>"}}
```

`capability` has exactly the shape defined in section 1 and section 2 of this document. Nothing else is added to the response.

### 10.3 Bridge authentication and identity

The caller authenticates with the gateway's existing bearer-credential mechanism (`GatewayCredential`, `apps/gateway/src/server.ts`), the same mechanism used by `/work-items/:id/results`. A credential must additionally hold all of:

- role `worker`;
- scope `acs:worker` (so the credential-bound `actorId` is treated as a worker identity, as `authorizeDesktopCommanderExecution` requires);
- scope `acs:desktop-commander:issue` - a distinct, narrower scope from `acs:worker`, so a worker credential authorized to submit results does not automatically gain authority to mint signed capabilities. Operators provision this scope explicitly for a bridge-facing credential.

The caller's identity is always the credential-bound `actorId`, never a request body or header field (the gateway's established `x-acs-actor-id`-is-untrusted convention applies identically here). `authorizeDesktopCommanderExecution` then requires this identity to equal the attempt's `claimedByWorkerId` and the active lease's `workerId`; a credential authenticated as a different worker is rejected with `403 desktop_commander_lease_worker_mismatch` regardless of which attempt it names.

Missing or invalid auth: `401 unauthorized` (no/garbled credential) or `503 desktop_commander_issuer_auth_unconfigured` (auth not configured on this gateway at all - fail closed, not fail open). Insufficient role/scope: `403 insufficient_desktop_commander_issuer_authority`.

### 10.4 Policy, lease, and single-use enforcement before signing

Before any signature is produced, the issuer (`issueDesktopCommanderCapabilityForRequest` in `packages/desktop-commander-adapter/src/http-issuer.ts`) re-reads, fresh from the authoritative store for this request only:

1. the trusted work item (`404 desktop_commander_work_item_not_found` if absent);
2. the work item's currently admitted execution plan, which must have `constraints.executionMode === "desktop_commander"` (`409 desktop_commander_plan_execution_mode_mismatch` otherwise - a plan admitted only for dry-run simulation can never be issued a real capability through this path, matching the identical gate already enforced in `apps/worker`'s in-process execution);
3. the named attempt, which must belong to the route's work item and be claimed by the authenticated caller (`404 desktop_commander_attempt_not_found`, `403 desktop_commander_lease_worker_mismatch`);
4. the attempt's active lease (`409 desktop_commander_lease_missing`, `410 desktop_commander_lease_expired`, and every other lease/fencing/action-hash/plan-hash check `authorizeDesktopCommanderExecution` already performs - see section 5).

Only after all of that succeeds does `SqliteDesktopCommanderRuntimeRegistry.recordIssuance` durably commit an issuance row in the *same* transaction that re-verifies runtime identity, scope, and (when required) approval binding - see section 5 and 6 of this document, unchanged. Signing (`signPreparedDesktopCommanderCapability`) happens only after that commit succeeds; a failed or rejected issuance is never signed.

Exactly one capability may ever be issued per `(leaseId, attemptId)` pair. This is enforced atomically at the database layer by a unique index added in migration `024_desktop_commander_capability_issuance_once.sql` on `desktop_commander_capability_issuances(lease_id, attempt_id)`, not merely by application logic - a second issuance request for the same attempt, whether a deliberate replay or a genuine concurrent race from two bridge instances, fails closed with `409 desktop_commander_capability_already_issued`. This is in addition to, not a replacement for, Desktop Commander's own independent `(keyId, nonce)` replay reservation described in section 6.

### 10.5 Key discovery

```
GET /desktop-commander/capability-key
Authorization: Bearer <gateway credential token with acs:read>
```

Returns `200 {"keyId": "<key-id>", "publicKey": "<base64url SPKI DER>"}` - the current signing key's public half only, derived in-process from the same private key the issuer signs with and never cached or persisted separately. `503 desktop_commander_issuer_unconfigured` if no issuer is configured on this gateway. This is a convenience discovery surface; it does not replace static `DESKTOP_COMMANDER_ACS_PUBLIC_KEY`/`DESKTOP_COMMANDER_ACS_KEY_ID` configuration on the Desktop Commander side (section 3), which remains the authoritative distribution mechanism until an operator rotates it.

### 10.6 Configuration

The gateway resolves issuer configuration from the same `ACS_DESKTOP_COMMANDER_*` environment variables already used by the in-process worker path (`ACS_DESKTOP_COMMANDER_RUNTIME_ID`, `..._RUNTIME_IDENTITY_CONFIG_FINGERPRINT`, `..._RUNTIME_SCOPES_JSON`, `..._CAPABILITY_KEY_ID`, `..._CAPABILITY_PRIVATE_KEY`, `..._ALLOWED_ROOTS`, `..._DENIED_ROOTS`) via `desktopCommanderCapabilityIssuerConfigFromEnv()`, but does **not** require `ACS_DESKTOP_COMMANDER_COMMAND`/`ARGS_JSON` or a local Desktop Commander subprocess entrypoint to exist on the gateway host, since the gateway only ever signs - it never spawns Desktop Commander itself. If none of the Desktop Commander environment variables are set at all, the issuance and discovery routes answer `503` rather than the gateway process failing to start; if they are partially set, the gateway fails closed at startup, matching the existing `desktopCommanderAdapterConfigFromEnv` contract.

### 10.7 Required future bridge-side change (not implemented here)

The Desktop Commander bridge (commit `dfec865`, developed in a separate worktree) is an external, untrusted consumer and is not modified by this change. For the OpenClaw Desktop Commander bridge to use this issuer instead of a raw/unmanaged call to Desktop Commander, its ACS-facing integration needs to:

1. Hold a gateway credential scoped `["acs:worker", "acs:desktop-commander:issue"]`, bound to the same `actorId` ACS used to claim the attempt it is executing on behalf of.
2. Before calling Desktop Commander for a given attempt, call `POST /work-items/{workItemId}/desktop-commander/capability` with exactly `{"attemptId": "<attempt id>"}` and that credential.
3. Attach the returned `capability` object **verbatim**, unmodified, at `params._meta.acsCapability` on the corresponding `tools/call` request to Desktop Commander. The bridge must not construct, mutate, or re-derive any capability field itself - it is only ever a transport for the object ACS already signed.
4. Treat a non-2xx issuer response as "do not call Desktop Commander for this attempt" - there is no fallback path that invokes Desktop Commander without an ACS-issued capability attached.
5. Discover the current key id/public key either via `GET /desktop-commander/capability-key` or static configuration (section 3); either is acceptable, but the bridge itself never verifies signatures (Desktop Commander's own MCP server does, independently, per section 6).

Until that bridge-side change exists, this issuer endpoint has no caller in the OpenClaw bridge deployment path; it is exercised today only by the tests in `apps/gateway/src/desktop-commander-capability.test.ts` and `apps/gateway/src/desktop-commander-e2e.test.ts`, and remains available for the in-process worker path to adopt as an alternative to its existing local signing.
