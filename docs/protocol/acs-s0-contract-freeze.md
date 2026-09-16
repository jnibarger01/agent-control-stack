# ACS S0 Contract Freeze v1

## Status and scope

This is the disabled-by-default S0 reference for the ACS Spine. It freezes wire contracts, validation semantics, and golden vectors only. It does not enable dispatch, invoke an engine, mutate lifecycle state, issue capabilities, change a database, or authorize production use.

Normative precedence is the sealed ACS Spine Authoritative Implementation Contract v1 (SHA-256 `c63d37c58880c41e7b341b884f2dd268ee906893369f8c6cd0a118d33f60c190`). Where it differs from older ADR prose, the sealed contract controls.

## Authority freeze

The only authority direction is Mission Router (untrusted intake and classifier evidence) -> ACS (sole authority) -> Codex Swarm (subordinate planner/executor) -> Desktop Commander managed runtime (fixed privileged capability boundary) -> host operation.

An S0 parser, schema, hash, fixture, or test is not an authority transition. Intake and classifier fields are claims/evidence only. Swarm evidence is untrusted and is not a result, approval, lease, promotion, grant, authorization, acceptance, or lifecycle transition.

## ACS intake and approval bindings

`acs.mission-intake.v1`, `acs.classifier-evidence.v1`, `acs.action-manifest.v1`, `acs.approval-binding.v1`, and `acs.approval-grant.v1` are defined by `packages/work-items/src/contracts.ts`.

All contract objects are strict: unknown keys reject at each defined object boundary. `acs.classifier-evidence.v1.authoritative` is exactly `false`. Hashes are SHA-256 domain hashes over the repository's legacy deterministic canonical JSON: `SHA-256(UTF-8(domain + LF + canonicalJson(value)))`. Object keys sort using the existing legacy canonicalizer; undefined object members omit; undefined array members normalize to `null`. This v1 behavior is frozen. A strict-canonical replacement requires a new schema version and new vectors.

Approval binding is content-addressed and binds approval request, work item, manifest, action, policy version and decision, requester, nonce, creation, and expiry. A changed binding field changes the binding hash. Approval consumption, lease fencing, lifecycle transition, and durable idempotency remain S1 responsibilities and are not implied by this reference.

## ACS to Codex Swarm envelope

Schema: `acs.codex-swarm-envelope.v1`.

The exact envelope body keys are `schemaVersion`, `acsWorkItemId`, `acsAttemptId`, `planId`, `admittedPlanHash`, `leaseId`, `fencingEpoch`, `auditCorrelationId`, `idempotencyKey`, `workspace`, `objective`, `permittedPaths`, `forbiddenPaths`, `permittedOwnerProfiles`, `maxLanes`, `maxLoopIterations`, `networkPolicy`, `timeoutMs`, `acceptanceCommands`, `validationCommands`, `evidenceRequirements`, `issuedAt`, and `expiresAt`. `workspace` is exactly `allocationId`, `hostPath`, and `expectedBaseSha`. The full envelope adds exactly `envelopeHash` and `mac`.

`envelopeHash` is `SHA-256(UTF-8("acs:codex-swarm-envelope:v1" + LF + legacyCanonicalJson(body)))`. `mac` is HMAC-SHA256 over legacy canonical JSON of the body plus `envelopeHash`. The two canonicalization rules are deliberately frozen together for v1 compatibility. Duplicate, missing, malformed, or unknown fields reject before any caller can treat the document as valid.

Timestamps are exact UTC milliseconds (`YYYY-MM-DDTHH:mm:ss.sssZ`). `expiresAt` must be later than `issuedAt`; lifetime is at most 30,000 ms; verification rejects an `issuedAt` more than 5,000 ms ahead of its supplied clock. The fixture has a 30-second lifetime boundary. Runtime lease/revocation, workspace ancestry, path containment, transport, and dispatch effects remain disabled and are S1/S2 responsibilities.

## Codex Swarm to ACS evidence

Schema: `acs.codex-swarm-evidence.v1`.

Evidence must echo `acsWorkItemId`, `acsAttemptId`, `envelopeHash`, `leaseId`, `fencingEpoch`, and `auditCorrelationId`. Its frozen `exitStatus` enum is `completed`, `timeout`, `cancelled`, or `spawn_error`. It carries lane results, nullable integration, aggregate verdict, nullable internal recommendation identity, loop facts, and redacted `evidenceBundle.auditLogHash` / `diffHash`.

Unknown fields reject at every defined evidence object boundary. Therefore lifecycle claim keys such as `succeeded`, `approved`, `promoted`, `granted`, `authorized`, and `accepted` reject at any defined nesting level rather than becoming evidence semantics. Matching an envelope checks identity echoes only; it never makes evidence authoritative or transitions ACS state.

## ACS to Desktop Commander reference

Schema: `acs.dc.v1`; transport location: `params._meta.acsCapability`.

The capability envelope is exactly `{payload, signature, keyId}`. Payload contains the sealed contract bindings: `version`, `issuer`, `audience`, runtime/work-item/attempt/lease/epoch identifiers, tool name, normalized arguments, invocation/action/request/plan hashes, scopes, issued/expiry timestamps, nonce, and `approvalId` only where required. This boundary uses Ed25519 and strict canonical JSON, not the Swarm HMAC canonicalizer. Scopes are fixed, sorted, and unique; TTL is at most 30 seconds; clock skew is at most 5 seconds. DC implementation and key/nonce/runtime registry are outside S0.

## Golden vector and negative corpus

The shared ACS-to-Swarm vector is `packages/engine-adapter/src/__fixtures__/codex-swarm-envelope.fixture.json`.

Its frozen expected values are:

- body schema version: `acs.codex-swarm-envelope.v1`
- issued timestamp: `2026-09-03T00:00:00.000Z`
- expiry timestamp: `2026-09-03T00:00:30.000Z`
- envelope hash: `1f2fa0cbaae1da046fbc4e93880d8e39083303dc272af1f359be0140da564073`
- MAC: `2fa94f3fc85423eacb6714d6e3a5372b3733bed5e59b9badfc09fb86a6a6b51e`

The S0 negative corpus rejects unknown/extra keys, malformed documents, hash and MAC mutation, under-length secrets, invalid network policy, non-millisecond timestamp form, non-positive chronology, TTL over 30 seconds, issued-at skew over 5 seconds, missing evidence identity echoes, and mismatched evidence identities. Each current S0 denial is a pure validation result with no authority, handler, process, filesystem, audit, or lifecycle side effect.
