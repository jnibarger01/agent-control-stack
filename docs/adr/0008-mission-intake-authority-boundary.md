# ADR 0008: Mission intake is advisory; ACS is the sole execution authority

## Status

Accepted for migration Phases 0–2. De-authorization and retirement remain separately gated.

## Context

Mission Router and Agent Control Stack currently overlap in risk classification, approval, lifecycle, dispatch, persistence, and audit. Two authorities can disagree about whether a request is approved, cancelled, dispatched, completed, or safe. That is a split-brain security defect, not redundancy.

## Decision

ACS is the sole target authority for final policy, approval, lifecycle, cancellation, execution authorization, worker leases, results, audit, and replay.

Mission intake and classifiers are advisory evidence. They may increase scrutiny but may never lower or bypass ACS policy. A compatibility client may submit requests and read ACS state; it may not approve or execute locally.

```text
Client -> Intake normalization/classifier -> ACS work item
       -> ACS policy -> ACS approval -> ACS claim/lease
       -> governed execution -> ACS result/audit -> LoopTrace projection
```

## Canonical contracts

All hashes use deterministic canonical JSON with explicit contract and policy versions. Legacy hashes are provenance only.

### `acs.mission-intake.v1`

Required fields:

- `schemaVersion`: literal `acs.mission-intake.v1`
- `goal`: non-empty bounded string
- `origin`: closed origin enum
- `constraints`: allowed tools, workspace, network mode, timeout, success criteria, rollback requirement
- `submitted`: optional declared task type and risk; these are claims, not authority
- `legacyProvenance`: optional source version, mission ID, and legacy envelope hash

Normalization is deterministic, rejects unknown keys, and returns warnings separately. Raw sensitive fields must follow ACS redaction and retention policy before audit projection.

### `acs.classifier-evidence.v1`

- `schemaVersion`
- `classifierId` and `classifierVersion`
- `inputHash` of the normalized intake
- task-type recommendation and matched signals
- risk recommendation and matched signals
- sensitivity categories and matched signals

Classifier evidence is immutable evidence. ACS final policy risk is separate and may only be equal or stricter.

### `acs.action-manifest.v1`

Each execution-authorizable action is represented by:

- contract version
- work-item ID
- authenticated requester identity
- policy version
- canonical action kind, description, and parameters
- normalized/realpath-contained target and cwd
- canonical command/paths where applicable
- network, write, destructive, timeout, and rollback constraints
- creation nonce or immutable creation identity

`actionManifestHash = stableHash(actionManifest)`.

### `acs.approval-binding.v1`

An approval binds to:

- contract version
- work-item ID
- action-manifest hash
- policy version
- immutable approval-request nonce

The grant is authenticated, expiring, one-time, stored hash-only where a bearer token exists, and consumed atomically with dispatch authorization. Claim time re-evaluates current policy and rejects changed manifests, expired/consumed grants, or stricter current policy.

A legacy Mission Router envelope hash must never be accepted as an ACS execution grant.

### Idempotency

Submission identity is scoped to authenticated principal plus caller idempotency key. Reusing a key with a different normalized intake hash is a conflict, not a replay. Identical submissions return the original ACS work-item ID.

### Trace correlation

ACS generates the authoritative `workItemId` and root `traceId`. Optional `legacyMissionId`, `legacyEnvelopeHash`, and LoopTrace `runId` are correlation/projection fields. LoopTrace is not a second lifecycle or approval authority.

## Migration state model

- **Freeze:** no new Mission Router authority or deployed ingress.
- **De-authorize:** compatibility remains, but local approval/dispatch is impossible.
- **Archive/delete:** only after integration inventory, history preservation, parity tests, clean ACS verification, observation, and rollback proof.

This ADR authorizes only Phase 0–2 contract/test work. It does not authorize deployed-command changes, service disablement, real-history migration, or deletion.

## Required tests before runtime migration

- Mission intake rejects unknown keys and unsafe paths.
- Normalization is deterministic and legacy envelope hashes remain provenance only.
- Classifier output is deterministic, versioned, and advisory.
- Classifier recommendations cannot reduce ACS policy risk.
- Any action-manifest field change invalidates approval.
- Policy-version or nonce changes invalidate approval.
- Expired and consumed grants cannot execute.
- Idempotency-key reuse with a different body is rejected.
- Trace correlation preserves both ACS and legacy identifiers without granting authority.

## Rejected alternatives

### Keep both control planes authoritative

Rejected because approval, lifecycle, cancellation, dispatch, and audit can diverge.

### Treat Mission Router approval as upstream ACS approval

Rejected because its actor is not authenticated, its hash covers a different payload, and its grant is not consumed at dispatch.

### Delete Mission Router immediately

Rejected until consumers, history, CLI parity, LoopTrace behavior, clean verification, and rollback are proven.
