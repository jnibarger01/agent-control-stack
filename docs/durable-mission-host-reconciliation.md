# Durable mission host reconciliation

## Inspected lineage

Inspection on 2026-10-02 uses fetched `origin/main` at
`253de521331984a1f9b28f2599b3042b41288a75`. Implementation preparation is isolated
on `integrate/durable-mission-host-main-20261002`. The dirty host worktree at
`53c41629` and both protected durable mission worktrees are preserved.

This is an inspection and reconciliation plan, not a production wiring claim.
No production controller or observer has been configured or exercised.

## Contracts to reuse

| Boundary                         | Existing source                                                                                                                            | Actual behavior                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic selection               | `packages/actor-router/src/authoritative.ts`, `nimble-client.ts`, `nimble-config.ts`                                                       | Hard eligibility precedes Nimble Choice; a valid eligible choice wins. Decisions and evidence are persisted; deterministic fallback is explicit.                                                                                                                            |
| Authenticated worker claim       | `packages/policy-gate/src/authoritative-dispatch.ts`, `apps/gateway/src/server.ts` (`POST /worker/claim`)                                  | With Nimble enabled, the authenticated worker must match the persisted selected executor. Policy and canonical attempt/lease claim remain authoritative.                                                                                                                    |
| Worker composition               | `apps/worker/src/cli.ts`, `mission-client.ts`, `mission-runner.ts`                                                                         | `ACS_MISSION_ID` opts into `runConfiguredMission()`. The bounded runner reconstructs canonical ACS progress and invokes permit-bound MCP tools with separate gateway/runtime credentials.                                                                                   |
| Typed mutation proposal          | `packages/work-items/src/change-set.ts`, `change-set-store.ts`                                                                             | The canonical versioned snapshot and manifest hash cover operations, resources, dependencies, retry keys, and verification. Reuse this representation.                                                                                                                      |
| Human authority                  | `packages/work-items/src/change-set-approval.ts`, `change-set-approval-store.ts`, `store.ts`                                               | Approval binds the exact revision, manifest hash, subject input, executing actor, policy, expiration, and audit provenance. Active authority checks reject stale heads and revocation. The canonical field is `manifestHash`; do not mint a parallel `actionHash` approval. |
| Operation permit                 | `packages/work-items/src/change-set-operation-permit.ts`, `store.ts`; gateway `/work-items/:id/change-sets/operations/:operationId/permit` | ACS reserves an immutable, unique operation permit and child execution item. It binds runtime, tool, invocation hash, worker, actor, snapshot, policy, and approval or grant authorization.                                                                                 |
| Runtime execution                | Gateway `changeSetPermitWorkItem`, `claimWithAdmissionPermit`, DC/JC capability issue routes                                               | Exact permit/invocation matching, current authority, admission, and canonical lease/attempt claim precede capability issuance. Keep this executor authority.                                                                                                                |
| Result acceptance and completion | `packages/work-items/src/change-set-progress.ts`, `store.ts`; gateway result, progress, review, and complete routes                        | ACS verifies accepted result, worker, attempt, lease/fence, input/plan/action hashes, audit provenance, machine evidence, and independent reviews. Tool return success cannot complete a mission.                                                                           |
| Existing deployment request      | `packages/coding-mission/src/default-runtime.ts` (`deployMerge`, `observeDeployment`), `controller.ts`, `store.ts`                         | Creates and reconciles GitHub deployment records bound to a merge SHA and Change Set hash. A matching GitHub record does not prove the running production release.                                                                                                          |
| Artifact integrity               | `packages/release-integrity/src/index.js`, `scripts/release-integrity.mjs`, `docs/runbooks/release-integrity.md`                           | Verifies sealed release files, dependency bytes, pinned Node, commit, and runtime digest. It does not independently locate the running production process.                                                                                                                  |
| Runtime identity attestation     | `apps/dc-mcp-gateway/managed.js`                                                                                                           | Managed DC bootstrap uses a verified release runtime digest and ACS challenge/attestation. This is not a general production release observation API.                                                                                                                        |
| Health                           | Gateway `/healthz` and `/readyz`, `scripts/gateway-post-deploy-healthcheck.sh`                                                             | Health/readiness evidence exists. It must not establish deployment occurrence or release identity.                                                                                                                                                                          |

## Integration gaps verified in source

Main no longer contains `apps/gateway/src/semantic-dispatch.ts` or the
`/routing/dispatch` route. Reuse the current authoritative router instead of
recreating the old router or endpoint.

The canonical mission runner calls governed MCP runtimes. The capability path
claims its permit's execution child through `claimWithAdmissionPermit`; it does
not call `/worker/claim` or the Nimble selector. Permit issuance currently binds
the worker to the configured DC/JC bridge and records an assignment whose agent
field is the executing actor and routing decision field is the manifest hash.
This assignment is not evidence of a Nimble semantic decision. The normal
authenticated worker claim path and canonical mission path therefore cannot yet
be claimed as one end-to-end routing chain.

`claimNextAuthoritativeWorkItem` compares the selected registry executor ID
directly with the authenticated worker ID. It has no explicit agent-to-worker
binding map. Reconciliation must preserve the two identity namespaces and bind
the selected executor to the canonical permit worker. It must also integrate
real admission: the helper accepts an admission port, but the current HTTP claim
route does not pass it.

Canonical submission currently supports only `fs_inspect` and
`independent_review` machine-verification vocabulary. Production HTTP health,
running version, and service verification kinds are rejected before authority.
Grant-backed permits also refuse arbitrary process, remote, network, deployment,
service, and secret operations where confinement cannot be established. Preserve
these refusals; they are not production adapter configuration switches.

No inspected contract implements both a physical production rollout controller
and independent observation of the running release. The concrete target release
mechanism and independent observation source must be identified before writing
its production adapter. Neither a shell exit code, GitHub deployment record,
declared producer SHA, nor verification of an arbitrary artifact directory is
enough.

## Preserve and transplant deliberately

The old host's uncommitted deployment changes retain useful semantics:

- durable `PENDING` intent before mutation;
- stable deployment identity and immutable Change Set/release/permit binding;
- distinct `EXECUTING`, `SUCCEEDED`, `FAILED`, and `UNKNOWN` states;
- observation before any restart recovery;
- exact observed release identity required for success;
- unavailable or different release observation leaves `UNKNOWN` without replay;
- health and declared production checks remain separate completion requirements.

Do not transplant the host's local claim/dispatch path, legacy untyped
`MutationApplier`, duplicate Change Set persistence, or independent
`DeploymentAuthorization` authority. Use main's canonical operation permit,
authenticated runtime client, accepted results, progress, and completion checks.
The stable mission execution ID remains
`domainHash("acs:mission-execution:v1", { missionId, operationId })`; carrying it
must not replace canonical permit/attempt/lease identity.

Main's canonical migrations end at `050_authoritative_routing.sql`. The old
host's `044_mission_runtime.sql` and uncommitted
`045_mission_deployment_operations.sql` collide with main's applied migration
numbers. Do not copy those files or rewrite main's history. A deployment journal
adapted to canonical permits needs a new additive migration after version 50,
with fresh-database and version-50 upgrade tests. Do not install the legacy
mission aggregate merely to satisfy the old deployment table's foreign key.

## Implementation order and acceptance gate

1. Bind main's existing semantic decision, explicit executor-to-worker mapping,
   canonical permit, real admission, and authenticated execution into one path.
   Validate assignment and authority again at claim; do not add a local claim
   authority or permit issuer.
2. Bind a deployment operation to the exact canonical approved operation,
   successful prerequisite mutation, release identity, and existing permit.
   Persist intent before dispatch. Reuse canonical result acceptance rather than
   accepting success from the runner's transport response.
3. Wrap the identified deployment mechanism through its existing governed
   execution authority. Add an independent observer for the actual running
   release. Missing observation retains `UNKNOWN`; a differing release is not
   proof that the prior deployment never started.
4. Extend canonical verification with implemented, validated production checks
   before allowing a proposal to request them. Require successful deployment
   evidence, exact live release identity, health, every declared check, and
   required independent review before canonical completion.
5. Reuse CLI mission opt-in and reconstruct durable progress at startup. Add a
   live-gated acceptance path; ordinary CI must not require external targets.

Crash acceptance must cover persisted intent before invocation, side effect
before receipt, unknown deployment response, stale approval, mismatched hash,
wrong-worker claim, and restart after accepted apply/deploy. Assert no duplicate
mutation and no retry without positive, authoritative non-execution evidence.
Routing tests must prove a valid Nimble choice survives deterministic scoring
and that JEV cannot select, override, approve, or dispatch.

No commit, push, merge, rollout, service restart, or worker activation is part of
this inspection. Live acceptance remains blocked until the deployment target and
independent release identity source are established and the gaps above are wired.
