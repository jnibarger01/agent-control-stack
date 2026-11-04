# ARES external worker contract

ACS owns authorization, approvals, leases, result acceptance and authoritative outcomes.
ARES executes only the approved action within its own isolation boundary. This integration does
not attest that isolation or enable REA/Ghidra. No unmanaged fallback is permitted.

## Request and independent approval

An ARES work item has exactly one action from `ARES_ACTION_KIND_LIST` in work-items:
`ares.analyze.local`, `ares.adapter.ghidra`, `ares.adapter.rea`, `ares.spec.seal`,
`ares.oracle.run`, or `ares.task.decide`. Unknown, repeated and mixed ARES actions are
rejected at creation; malformed persisted ARES items are ineligible for worker claims.

The authenticated requester credential supplies `requester` and `requesterSubject`;
body values cannot override them. `params.aresPrincipal` is an ARES-local identifier,
not ACS identity or authority. ARES owns its local-principal-to-ACS-subject linking and
must independently verify that mapping before execution. ACS does not certify it.

Every ARES action requires approval regardless of its declared risk. The HTTP approval
route requires a live `user` credential with the operator role, `acs:approve`, and no
service/worker role. Neither the requester subject nor an executor in `target.services`
may approve. Device tokens cannot approve. Approval binds the exact policy action hash;
claim re-evaluates current content and consumes the approval transactionally. Target,
arguments and plan are included in the execution/attempt bindings.

## Claim and result

ARES plans explicitly use `constraints.executionMode: "ares"`, derived from the work-item
kind independently of the process-wide local-worker backend. An existing plan labelled
`dry_run` cannot authorize ARES execution: create a new plan and obtain fresh approval.
ARES must honor the approved plan constraints; ACS does not attest the external executor.

`POST /worker/claim` accepts optional `workItemId` for a single known ARES item and optional
`leaseMs` (positive integer, at most one hour). Worker identity is derived from the live
worker credential (`worker` role, `acs:worker`, bound actor ID). Caller-supplied identity
fields are rejected. Exact-ID and claim-next both require that `target.services` name
that worker, with existing assignment/routing constraints intact. Concurrent claims can
produce only one active lease. No approval or no eligible item yields `claimed: false`.

ACS caps the initial lease, renewal and result-acceptance window at the approved plan's
`maxRuntimeMs`, starting with the attempt's first lease. Re-leasing an interrupted attempt,
even with fresh independent approval, does not reset that deadline. Expiry returns
`worker_lease_expired`; no further result or renewal authority is granted. The default
ARES plan budget is five minutes; longer experiments need a correspondingly bounded plan
and independent approval. ACS fences authority and results; ARES must stop its own process
within the approved deadline. This integration does not attest external process termination.

Results use the existing strict worker envelope and attempt-derived idempotency key.
Work item, worker, attempt, lease, action/plan/input hashes, fencing epoch and expiry are
checked in the acceptance transaction. ARES results require mode `ares`, `simulated: false`,
backend `ares-studio`, `toolName` equal to the action kind and `requestId` equal to the
attempt ID. An optional receipt `approvalId` must match the plan approval bound to the lease.
These receipt checks also run in the store, not just the HTTP route.

When approved params include `aresArgsHash`, the receipt must include the same hash in
`structuredOutput.aresArgsHash` and a null or SHA-256 `resultDigest`. Its invocation fingerprint
must equal ACS `stableHash({ domain: "ares.invocation.v1", attemptId, argsHash, resultDigest })`.
ARES computes its local args hash using its own canonical form; ACS binds that digest as
approved input rather than treating it as independent proof of execution. Items without
that optional local digest still bind all exact arguments through the action and attempt
input hashes; they do not gain a local-digest receipt guarantee.

An exact result replay returns the original result (`200`) without a new execution or audit
acceptance. A changed replay is refused. A consumed lease cannot start another execution.
A worker report is evidence; ACS accepting it does not independently prove adapter behavior.

## Device consent and migration

`ACS_DEVICE_CLIENT_IDS` enables public device-flow clients (comma separated validated IDs).
Unset defaults to `acs-cli`; adding `ares-studio` requires deployment configuration outside
this slice. A client ID is a public label, not an authenticated application identity.
The authenticated verification page displays the stored client ID, escaped device name,
public-key fingerprint and requested scopes. It excludes device codes, tokens and keys;
anonymous visitors receive no pending-device details. Consent viewing/decisions and remote
device revocation require configured human operator authority. Device/service/worker tokens,
including ARES's work-creation token, cannot enroll another device or revoke devices.
The disposable loopback HTTP test exercises real device-flow keys/tokens, principal binding,
independent approval, concurrent claim, runtime cap, result binding, replay and revocation
with synthetic data; it does not launch an adapter or an ARES Studio process.

Migration 075 rebuilds the two leaf result tables to add the ARES metadata mode. Existing
column order, rows, indexes, triggers and binding constraints are tested against v74.
Its source comment references the original `gen-075.py`, which is not committed. Reproduce
schema comparison by applying canonical migrations through 074 to an in-memory SQLite DB
and comparing `sqlite_master` plus `PRAGMA table_info` before/after 075, as implemented in
`packages/work-items/src/migration-075.test.ts`. Those low-level seeds intentionally omit
some unrelated parent rows; a separate disposable upgrade harness in the release evidence
checks a valid v74 attempt/result/audit chain and v75 `/readyz` without touching real data.
Migration-number collision checks against current remote PRs remain a release prerequisite.

## Review and limits

Run `npm run typecheck`, the ARES gateway/domain/migration and device-auth test files, then
`npm run check`. Record exact commits, exit statuses, exclusions and unchanged-base comparisons.
No live REA/Ghidra run, production migration rehearsal, deployment, remote PR reservation or
ARES Studio end-to-end proof is established by these ACS tests. A real-data migration
rehearsal requires a separately authorized backup copy, never the production database.
