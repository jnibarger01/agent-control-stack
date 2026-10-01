# Immutable Change Sets

## Current implementation boundary

`packages/work-items` owns `acs.change-set.v1` and its durable revisions.
`SqliteWorkItemStore.submitChangeSet` submits a proposal for an existing mission
work item. It does **not** approve the mission, admit an execution plan, mint a
permit, or execute a tool. HTTP/MCP intake, Policy Gate admission, human bundle
approval, Autonomous Authority Grants, and the durable execution loop still
require integration. Existing execution-plan approvals remain authoritative
on the currently wired runtime path.

This contract supersedes the proposed bundle review artifact as the intended
mission execution snapshot. It is not a second policy evaluator or an authority
source. Policy Gate must derive tool effects and privileges from the canonical
runtime invocation and check the agent's declarations before authorization.

## Snapshot

A revision contains:

- Mission ID and the canonical existing `executionPlanSubjectInputHash` of
  mission inputs; executing actor ID; objective.
- Resource scope and maximum requested privileges. Resource names are exact
  identifiers at this stage, not an implemented filesystem or network sandbox.
- Expiration, runtime budget, concurrency limit, and failure behavior.
- Ordered operations with IDs, runtime, tool, action parameters, resources,
  requested privileges, declared effects, dependencies, and bounded retries.
- Verification requirements with IDs, covered operations, evidence kind,
  nonempty expected evidence, and independence requirements.
- Revision number and parent manifest hash.

Every snapshot field is included in the domain-separated SHA-256 hash of
strict canonical JSON. Operation IDs, expiration, retry budgets, and verification
are included. No caller-supplied approval state is accepted. Unsupported JSON,
unknown fields, and definitions exceeding 1 MiB are rejected.

Dependency graphs must be acyclic and reference known operations. Operations
must declare resources inside the snapshot scope and privileges inside its
maximum. Declared mutations require machine verification; declared privileged
operations also require independent review. Those declarations are untrusted:
the future policy boundary must derive the actual effect from the tool contract.
A `read_only` label cannot authorize a mutating tool.

## Submission and amendments

Submission supplies `definition`, `submissionId`, `expectedHeadHash`, and the
authenticated `createdByActorId`. An external route must inject provenance from
its authenticated principal rather than accept a body-supplied identity.

The store validates current mission inputs and expiration inside its existing
write transaction. Initial submission requires a null expected head. An amendment
requires the exact current manifest hash. The store creates the next revision,
appends its audit event, and advances the head in the same transaction.
SQLite uniqueness constraints fence duplicate revision and submission IDs.
Replaying the same submission with identical definition, parent, and creator
returns the recorded revision without another audit event. A changed payload
under the same submission ID is rejected. A competing stale head is rejected.

Revision rows cannot be updated or deleted through ordinary SQL: append-only
triggers enforce this. Reads recompute every hash in the selected revision's
ancestry, check contiguous revision and parent bindings, and validate the linked
submission audit event, including its event hash. Current-head reads reject a
missing, mismatched, or rolled-back head. Historical revision reads are evidence
retrieval; they are not authorization to execute that older revision.

The immutable `auditEventId` connects a returned revision to
`change_set.submitted`, which records mission ID, revision, manifest hash, parent
hash, submission ID, executing actor, and creator without raw operation data.
The existing hash-chained audit log remains the audit owner. Local hashes cannot
prevent an administrator rewriting the entire database and audit chain; retain
independent audit exports and protect database custody.

## Errors

| Code                             | Condition                                                               |
| -------------------------------- | ----------------------------------------------------------------------- |
| `change_set_input_mismatch`      | Proposal is not bound to current mission inputs                         |
| `change_set_submission_conflict` | Submission ID reused for different content, parent, or creator          |
| `change_set_revision_conflict`   | Expected head does not match current head                               |
| `change_set_mission_terminal`    | A new revision targets a terminal mission                               |
| `change_set_expired`             | New snapshot is already expired                                         |
| `change_set_integrity_mismatch`  | Persisted snapshot, ancestry, head, or audit binding fails verification |

Schema-invalid submissions fail validation before persistence. Database and
audit failures roll back both revision and head. This migration adds new tables
and does not rewrite existing execution plans, approvals, or released migrations.

## Required next integration

One canonical path must consume the current immutable snapshot:

```text
Mission -> Change Set -> deterministic Policy Gate
  -> exact-hash human approval or scoped Autonomous Authority Grant
  -> operation-bound permit -> fenced claim -> governed runtime
  -> evidence -> independent verification -> mission completion + audit
```

Amendments must force policy reevaluation and new authorization. Cancellation,
expiration, and supersession must revoke further operation issuance. No existing
global execution-mode switch should grant a Change Set authority. JEV remains an
observational side channel and must not change this authorization chain.

Validation: `npm run typecheck`, targeted Change Set/migration/state-machine
tests, then `npm run check`. Tests use isolated temporary databases; this source
migration must not be applied to a live database without rollout authorization.
