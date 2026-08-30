# ADR 0015: Advisory reasoning, machine evidence, and independent verification

## Status

Accepted

> Numbering note: the requesting brief called this "ADR 0012". `0012` is already
> taken by `0012-retire-ed25519-approval-artifact-reference.md` (Accepted), so
> this decision is filed as the next free number, 0015. Nothing else about the
> brief changed.

## Context

ACS already owns policy, approval, work-item lifecycle, worker claims/leases,
result acceptance, and the canonical hash-chained audit
([ADR 0009](0009-engine-harness-authority-and-dependencies.md),
[ADR 0011](0011-canonical-audit-sink.md)). ADR 0008 established that mission
intake and classifiers are *advisory evidence*, never authority. ADR 0014 gave
model-backed engines an ACS-enforced isolation boundary.

Two capabilities are still missing and are easy to build wrong:

1. **Reasoning as a first-class, attributable, untrusted artifact.** Today a
   plan is only ever the *admitted* `ExecutionPlanDefinition`. There is no
   distinct, content-addressed record of *what an advisory model proposed*,
   attributed to that principal, that ACS then admits (or refuses). Without it,
   model reasoning leaks into the authoritative plan with no provenance and no
   "untrusted until admitted" gate.

2. **Machine-derived execution evidence, separate from model claims, bound to
   the exact attempt and workspace, and reviewable through a surface that
   cannot act.** `packages/verification` already runs an independence-enforced
   maker/verifier loop (`runIndependentVerification` rejects a verifier whose
   `engineId` equals the implementer's), and `VerificationEvidence` already
   carries an *untrusted* `implementerClaim` alongside a `diffSummary` and
   `commandResults`. But there is no ACS-owned, content-addressed
   **evidence manifest** that pins base/result workspace revision, diff hash,
   command metadata, exit codes, bounded output hashes, test evidence, sandbox
   and network profile, and worker identity; and there is no attempt-scoped
   **read-only evidence surface** a reviewer principal can be handed without
   also handing it write/exec/approve/lifecycle capability.

Adding these carelessly produces exactly the failure ADR 0009 forbids: a second
orchestrator, a second policy engine, a second approval path, a second
lifecycle, a second lease store, a second result authority, or a second audit
sink. It also risks trusting a model's summary as a machine fact.

## Decision

> **Models may propose. Execution backends may act. Evidence collectors may
> observe. Reviewers may judge. Only ACS may authorize or conclude.**

Four principal roles are defined. They are *roles*, not new services; an
existing component may hold one.

### `CONTROL_AUTHORITY`

**ACS only** — `packages/policy-gate` (policy, risk, approval requirements,
verification policy) plus `packages/work-items` (lifecycle, leases/fencing,
plan admission, result acceptance, terminal state, canonical audit).

Owns and is the *sole* authority for:

- execution authorization and denial
- approval requirements and approval decisions
- leases, fencing, and their validity
- plan admission and the `admittedPlanHash` binding
- the canonical work-item lifecycle and every terminal transition
- **result acceptance** — `succeeded` / `failed` is set only by
  `packages/work-items`, never by a reviewer, engine, adapter, or evidence
  collector
- verification *policy* (how many reviewers, independence constraints, conflict
  resolution) and the verification **decision** that consumes review findings
- the hash-chained `audit_events` chain

No advisory component, execution backend, or evidence collector may lower,
widen, or bypass a decision ACS has made. Policy may only add restriction at a
later boundary.

### `ADVISORY_REASONER`

Examples: ChatGPT, Hermes, Codex-as-planner, Claude, local models, the
`moa-orchestrator` advisor/aggregator layer.

**May**: inspect authorized evidence; produce a `PlanProposal`; identify risks;
recommend actions; review an implementation and produce a `ReviewFinding`.

**May not**: authorize or deny execution; approve anything, including its own
proposal; mutate any canonical work-item, attempt, lease, plan, approval,
result, or audit state; mark an execution successful or failed; assert a
machine fact without a referenced `EvidenceManifest`.

A `PlanProposal` and a `ReviewFinding` are *evidence to ACS*, nothing more. A
`ReviewFinding.verdict` of `PASS` does not transition anything; ACS verification
policy decides what a set of findings means.

### `EXECUTION_PRINCIPAL`

Examples: Codex, Claude Code, OpenCode, Desktop Commander (via
`packages/desktop-commander-adapter`), ACP/ACPX runtimes, the sandbox and
engine-isolation backends.

**May**: execute exactly the capabilities ACS has already authorized and scoped
for a specific `admittedPlanHash` + `actionHash` + attempt lease.

**May not**: widen its own capability set; select or change its sandbox,
network, or tool profile; approve; own or advance lifecycle; define what counts
as canonical evidence; act as an orchestrator; bypass sandbox, policy, or audit.

### `EVIDENCE_AUTHORITY`

**ACS-controlled infrastructure only**: `packages/sandbox`,
`packages/workspace-manager`, the Git adapter inside it, the validation/test
runner (`packages/result-validation`), the process supervisor, and the audit
subsystem in `packages/work-items`.

Produces `Observation`s — machine-derived facts — that ACS assembles into a
content-addressed `EvidenceManifest`. A model-generated summary is never an
`Observation` and is never placed in an `EvidenceManifest`.

## Authority table (extends ADR 0009 §"Authority ownership")

| Concern                     | Authority                                            |
| --------------------------- | --------------------------------------------------- |
| Reasoning / planning         | `ADVISORY_REASONER` (produces `PlanProposal`)       |
| Plan admission              | ACS — `packages/policy-gate` + `packages/work-items` |
| `admittedPlanHash` binding  | ACS — `packages/work-items` / this ADR              |
| Policy / risk               | ACS — `packages/policy-gate`                        |
| Approval                    | ACS — `packages/policy-gate` + `packages/work-items` |
| Execution authorization     | ACS — claim-time policy/approval/lease checks       |
| Physical execution          | `EXECUTION_PRINCIPAL` (ACS-authorized backend)      |
| Machine evidence            | `EVIDENCE_AUTHORITY` — `EvidenceManifest`           |
| Semantic review             | `ADVISORY_REASONER` (produces `ReviewFinding`)      |
| Verification policy         | ACS — `packages/policy-gate`                        |
| Verification decision       | ACS — `packages/work-items` (`Decision`)            |
| Terminal result acceptance  | ACS — `packages/work-items` only                    |
| Canonical audit             | ACS — hash-chained `audit_events`                   |

## Domain model

All contracts use deterministic canonical JSON (`stableHash` / `domainHash`
from `@agent-control-stack/shared`), explicit `schemaVersion` literals, and
`.strict()` Zod objects. New contracts live in `packages/advisory` (advisory
artifacts, reviewer grants, verification policy) and `packages/evidence`
(manifest, observations, workspace revision, the read-only surface). Neither
package owns durable authority state; persistence is a projection over
`packages/work-items` + the canonical audit chain.

### `PlanProposal` — `acs.plan-proposal.v1`

Immutable advisory artifact. Fields: `schemaVersion`, `proposalId`,
`workItemId`, `principalId`, `principalRole` (must be `ADVISORY_REASONER`),
`goal`, `assumptions[]`, `actions[]`, `expectedFiles[]`, `tests[]`,
`successCriteria[]`, `riskNotes[]`, `createdAt`, `proposalHash`.

`proposalHash = domainHash("acs:plan-proposal:v1", <every field except the
hash>)`. Untrusted until ACS admits it. Admission is `packages/policy-gate` +
`packages/work-items`, unchanged.

### `AdmittedPlan` — `acs.admitted-plan.v1`

An ACS-authorized, immutable plan revision. It does **not** replace
`ExecutionPlanRecord` / `ExecutionPlanAdmission`; it is the superset binding
that ties one admitted `ExecutionPlanDefinition` to *all* materially relevant
execution authority:

`admittedPlanHash = domainHash("acs:admitted-plan:v1", {`
`  schemaVersion, workItemId,`
`  proposalHash | null,`              — which advisory proposal, if any
`  executionPlanHash,`                — existing `executionPlanHash` (steps/actions/constraints)
`  requestedActionsHash,`             — hash of the work item's requested actions
`  workspace: { workspaceId, baseRevision },`  — workspace identity + base tree revision
`  sandboxProfile,`                   — named profile id (`dry_run` | `desktop_commander` | `bubblewrap-systemd-v1` | `engine-isolation-v1`)
`  networkProfile,`                   — `none` | `scoped-egress:<allowlistHash>`
`  capabilityProfileHash,`            — hash of the tool/capability allowlist
`  validationProfileHash,`            — hash of the validation/test profile
`  policyVersion`
`})`

Any change to any bound field yields a new `admittedPlanHash`. An approval or
execution authority issued for `admittedPlanHash` A **must not** authorize
`admittedPlanHash` B. The database-enforced floor remains the existing
`execution_plan_approvals` binding on `plan_hash` + `action_hash` +
`request_hash` (ADR 0012 / migration 006); `admittedPlanHash` is the ADR-0015
superset check, enforced by the governed-attempt coordinator and the
verification layer, recorded in the canonical audit, and covered by tests.

### Attempt phase

The top-level work-item lifecycle (`draft … succeeded/failed/blocked/cancelled`)
and the attempt status machine (`pending … quarantined`) are **not** changed.
Planning/review microstates would contaminate them. Instead an *attempt phase*
is an additive, non-authoritative projection over `execution_attempts`
(`current_phase` column, nullable) plus a canonical audit-event stream:

`planning → admitted → executing ⇄ collecting_evidence → reviewing →
accepted | rejected` (and `reviewing → executing` for a replan).

The phase never gates a work-item transition. `succeeded`/`failed` still flows
only through `packages/work-items` with the existing lease/hash/fencing checks.

### `EvidenceManifest` — `acs.evidence-manifest.v1`

An ACS-owned, content-addressed record built **only** from `EVIDENCE_AUTHORITY`
data. Fields: `schemaVersion`, `attemptId`, `workItemId`, `admittedPlanHash`,
`planHash`, `actionHash`, `baseWorkspaceRevision`, `resultWorkspaceRevision`,
`changedPaths[]`, `diffHash`, `commands[]` (each: executable metadata, argv
hash, `exitCode`, `stdoutHash`, `stderrHash`, bounded reference), `testEvidence`
(validation-run reference + pass/fail counts), `sandboxProfile`,
`networkProfile`, `networkDecisions` (allowed/denied counts),
`workerId`, `startedAt`, `finishedAt`, `manifestHash`.

`manifestHash = domainHash("acs:evidence-manifest:v1", <every field except the
hash>)`. It is append-only and immutable (SQLite trigger, migration 018). A
model-generated summary is never one of these fields. The canonical audit
chain records `evidence.manifest_recorded` carrying the exact `manifestHash`,
and every verification `Decision` references the exact manifest hash it used.

### `ReviewFinding` — `acs.review-finding.v1`

Immutable advisory result. Fields: `schemaVersion`, `findingId`, `workItemId`,
`attemptId`, `reviewerPrincipalId`, `reviewerRole` (`ADVISORY_REASONER`),
`reviewerProvider`, `evidenceManifestHash` (must match an existing manifest),
`verdict` (`PASS` | `NEEDS_CHANGES` | `BLOCK` | `UNKNOWN`), `findings[]` (each a
`Finding` — model interpretation, with `evidenceRefs`), `recommendedActions[]`,
`createdAt`, `findingHash`.

A `ReviewFinding` is evidence to ACS verification policy. It does not, on its
own, change any terminal work-item state.

### Observation vs Finding vs Decision

Kept structurally distinct, in three different packages:

- **`Observation`** (`packages/evidence`) — a machine-derived fact:
  `{ kind, source, value, observedAt }` where `source` names an
  `EVIDENCE_AUTHORITY` subsystem. Examples: `command.exit_code`,
  `tests.summary`, `workspace.changed_paths`, `sandbox.network_state`. Lives
  inside an `EvidenceManifest`.
- **`Finding`** (`packages/advisory`) — a model interpretation:
  `{ category, severity, summary, detail, evidenceRefs }`. Lives inside a
  `ReviewFinding`.
- **`Decision`** (`packages/work-items`) — an ACS authority outcome:
  `{ outcome, basis: { evidenceManifestHash, reviewFindingHashes[],
  verificationPolicyVersion }, decidedAt }` with `outcome` ∈
  `attempt_accepted | attempt_rejected | replan_required |
  verification_disputed | human_escalation_required`. Recorded as
  `verification.decision` in the canonical audit.

## Evidence plane

An attempt-scoped, **read-only** Evidence surface (`packages/evidence`,
optionally exposed by `apps/evidence-mcp` — a standalone stdio MCP server
modelled on `apps/mcp`, *not* routed through the gateway, so the public
contract surface is untouched).

Capabilities are read-only only: `work_item_info`, `attempt_info`,
`workspace_info`, `read_file`, `search_workspace`, `list_directory`,
`git_status`, `git_diff`, `git_changed_files`, `test_runs`, `test_output`,
`execution_summary`, `sandbox_summary`, `policy_decision`, `approval_summary`,
`audit_excerpt`, `evidence_manifest`.

**Forbidden by construction, not by policy toggle**: there is no capability —
no method, no MCP tool, no dispatch branch — for write, delete, shell/exec,
package install, commit, restart, arbitrary network, approval, retry/clone, or
any lifecycle mutation. The surface type is a `Readonly` capability map; a
compile-time exhaustiveness test and a runtime tool-name test assert absence.

## Reviewer authorization

A reviewer is authorized by a `ReviewerGrant` (`acs.reviewer-grant.v1`), not by
workspace membership. It binds: `principalId`, `principalRole`
(`ADVISORY_REASONER`), `workItemId`, `planId`, `admittedPlanHash`, `attemptId`,
`workspaceId`, `workspaceRevision`, `scopes` (only `acs:evidence:read`),
`issuedAt`, `expiresAt`, `grantHash`.

It reuses ACS auth primitives: a new MCP scope `acs:evidence:read` on the
existing scope list, an ACS-issued grant persisted as a `packages/work-items`
projection (`reviewer_grants`, append-only + single-consume) with
`reviewer.grant_issued` / `reviewer.grant_consumed` audit events, verified by
`apps/evidence-mcp`. It is not a second identity or token system — it is an
ACS-issued, ACS-verified, scope-limited grant analogous to an attempt lease.

A `ReviewerGrant` for attempt N does not match attempt N+1 (`attemptId`
mismatch) and does not match a changed workspace (`workspaceRevision` mismatch).

## Workspace freshness / TOCTOU

Execution authority binds to the workspace revision the admitted plan was
authorized against (`AdmittedPlan.workspace.baseRevision`).
`computeWorkspaceRevision(hostPath)` (`packages/evidence`) is a deterministic
digest of the worktree (`git rev-parse HEAD` + a hash of `git status
--porcelain=v1 -z`).

- Before execution: the coordinator asserts the live workspace revision equals
  the authorized `baseRevision` (or differs only by the authorized attempt's
  own recorded changes). Otherwise it fails closed and requires re-admission /
  replanning.
- Before terminal acceptance: recompute; if the workspace changed outside the
  authorized attempt, `submitWorkResult` fails closed and ACS records
  `verification.decision` with `outcome: replan_required`.

ACS never executes an admitted plan against an unknown base revision.

## Verification policy

A policy *layer* (`packages/policy-gate/src/verification-policy.ts`), not a
second result authority. It answers two questions and nothing else:

1. **Requirement** — given `{ riskClass, actionKinds, executorPrincipalId,
   executorProvider }` it returns a `VerificationRequirement`:
   `{ reviewersRequired, requireIndependentPrincipal, requireIndependentProvider,
   conflictResolution, humanEscalationRiskClasses }`. Defaults: `0` reviewers
   for read-only low-risk; `1` for source-code mutation; `2` for
   destructive/high risk; `requireIndependentPrincipal` always true when
   `reviewersRequired > 0` (so `executorPrincipal != reviewerPrincipal`);
   `requireIndependentProvider` configurable.
2. **Classification** — `classifyReviewOutcome(findings, requirement)` returns
   one of `pass | needs_changes | blocked | disputed | unknown |
   insufficient_reviews`. `BLOCK` from any reviewer ⇒ `blocked`. Disagreement
   among reviewers ⇒ `disputed` — **never a silent pick of one**. `UNKNOWN` or
   too few independent reviewers ⇒ `unknown` / `insufficient_reviews`.
   `conflictResolution` (`another_reviewer` | `unanimous` | `majority` |
   `designated_reviewer` | `human_approval`) decides what `disputed` requires
   next.

ACS `packages/work-items` remains the only thing that *accepts* a terminal
result. `submitWorkResult` gains a fail-closed guard: when a
`VerificationRequirement` is on record for the attempt and the recorded
outcome is not `pass`, `outcome: "succeeded"` is refused. This strengthens the
existing boundary; it does not create a new one. It is inert unless
verification policy is enabled for the attempt (`ACS_VERIFICATION_POLICY`,
default `off`), so existing dry-run behaviour is unchanged.

## Desktop Commander

Unchanged from `packages/desktop-commander-adapter` / the architecture doc.
Desktop Commander stays below the ACS authority boundary as an
`EXECUTION_PRINCIPAL` adapter. The governed topology is:

`ADVISORY_REASONER` plan proposal → ACS intake → ACS policy + approval → ACS
plan admission (`admittedPlanHash`) → ACS execution coordinator → Desktop
Commander adapter → machine → ACS evidence collector → `EvidenceManifest` →
read-only reviewer (`apps/evidence-mcp`, `acs:evidence:read`) → `ReviewFinding`
→ ACS verification policy + `Decision` → ACS result acceptance / audit.

Desktop Commander must not approve, self-authorize, own lifecycle, define
canonical evidence, become an orchestrator, or bypass sandbox/policy/audit.

## Consequences

- Model reasoning becomes an attributable, content-addressed, *untrusted*
  artifact with an explicit admission gate, instead of leaking into the
  authoritative plan.
- Machine evidence is content-addressed, attempt-and-revision-bound, and
  separated from model claims; the audit chain identifies the exact manifest
  used for any verification decision.
- Reviewers get a surface that structurally cannot act.
- ACS gains a fail-closed verification guard on result acceptance without a
  second result authority, a second lifecycle, or a second audit sink.
- New packages (`packages/advisory`, `packages/evidence`) and one new app
  (`apps/evidence-mcp`) are capability adapters / read models, per ADR 0009.
  They must not — and static/architecture tests assert they do not — create a
  second authoritative lifecycle, approval store, lease store, result store, or
  audit chain.

## Enforcement

1. Dependency/static tests: `packages/advisory` and `packages/evidence` do not
   import `apps/*`, do not depend on `apps/worker`/`apps/gateway`, and expose
   no method that mutates canonical state.
2. Adversarial tests (the 15 in the brief): advisory principals cannot mutate
   lifecycle; reviewers cannot approve; the review surface has no privileged
   tool; attempt-N reviewer credentials cannot read attempt N+1; a changed
   `admittedPlanHash` invalidates prior authority; a changed workspace revision
   invalidates stale authority; executor claims are not accepted as evidence
   without an `EvidenceManifest`; the manifest is content-addressed/immutable;
   findings reference the exact manifest; conflicting findings do not silently
   succeed; result acceptance remains in `packages/work-items`; the audit
   hash-chain invariants hold; existing policy/approval and Desktop Commander
   boundary tests stay green.
3. Every accepted governed result references the work item, lease,
   `admittedPlanHash`, `actionHash`, attempt, workspace revision,
   `evidenceManifestHash`, and the verification `Decision`.

## Rejected alternatives

### A dedicated advisory/verification orchestrator service

Rejected — it would duplicate dispatch, lifecycle, recovery, result, and audit
authority (the exact split-brain ADR 0009 and ADR 0008 remove).

### Let a reviewer verdict transition the work item directly

Rejected — a `ReviewFinding` is untrusted advisory evidence. Only ACS
verification policy + `packages/work-items` may conclude an attempt.

### Reuse `packages/verification`'s `pass/fail/inconclusive` verdicts verbatim

Kept as the *engine-verifier* contract; `ReviewFinding` deliberately uses
`PASS/NEEDS_CHANGES/BLOCK/UNKNOWN` because a semantic reviewer needs to express
"changes needed" and "blocked" distinctly, and ACS needs an explicit `disputed`
concept `pass/fail/inconclusive` cannot represent.

### Store advisory artifacts and evidence in their own tables with their own
### history semantics

Rejected as written — they are persisted as append-only *projections* over
`packages/work-items` with canonical audit events, so there is exactly one
authoritative history.

### Expose the evidence surface through the gateway `/mcp`

Rejected for this ADR — it would enlarge the public contract surface and
couple reviewer auth to connector auth. A standalone `apps/evidence-mcp` with
its own `acs:evidence:read` scope keeps the blast radius small. Revisit if a
remote reviewer transport is needed.

## Implementation checkpoint

This ADR is accepted in full. The landed control-plane checkpoint implements
the authority split, contracts, evidence surface, verification policy, and the
fail-closed `submitWorkResult` guard. It does **not** add a public reviewer
submission or verification-resolution API.

Current behavior when `ACS_VERIFICATION_POLICY=enforce` and reviewers are
required:

- the execution backend may complete;
- ACS records an attempt-bound `EvidenceManifest` and a
  `VerificationRequirement`;
- the attempt phase moves to `reviewing`;
- the worker returns `awaiting_independent_verification` and does **not**
  invoke `submit_work_result`;
- terminal `succeeded` remains unreachable until ACS records an
  `attempt_accepted` verification `Decision`.

Reviewer completion — retrieving attempt-scoped evidence, validating reviewer
independence, recording a `ReviewFinding`, deriving the ACS `Decision`, and
then allowing ACS to move out of `reviewing` — remains a future control-plane
milestone. Domain projections (`recordReviewFinding`,
`recordVerificationDecision`, `issueReviewerGrant`) exist for ACS-internal
use and tests; `apps/evidence-mcp` stays read-only by construction, and this
ADR still refuses to enlarge the gateway `/mcp` surface.
