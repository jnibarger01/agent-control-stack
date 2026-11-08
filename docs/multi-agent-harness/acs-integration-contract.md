# ACS Integration Contract for the Desktop Harness (`harness.acs.v1`, proposed)

Status: **Proposed. Not implemented.** Normative for Slice 1 once accepted. Evidence tags: **[V]** verified by reading this checkout; **[P]** proposed, does not exist; **[U]** unverified, confirm before relying.

Read first: [PRD](prd.md) (invariants INV-1 to INV-10), [ADR 0029](../adr/0029-desktop-harness-is-an-acs-client.md), [`worker-leases.md`](../protocol/worker-leases.md), [`approval-lifecycle.md`](../protocol/approval-lifecycle.md), [`worker-identity.md`](../protocol/worker-identity.md), [`acs-jc-v1-capability-contract.md`](../protocol/acs-jc-v1-capability-contract.md), ADR 0014, 0022, 0024.

This contract has two halves: the **ACS boundary** (sections 1 to 9: who may do what, in which order, with which bindings) and the **adapter boundary** (section 10: the interface every agent runtime implements). Section 11 lists what ACS does not yet provide.

## 1. Authority statement

1. ACS is the sole authority for policy, approval, leases, fencing, capability issuance, audit and verified outcome (ADR 0008, 0009) [V].
2. The harness is a **client and a worker-class executor**. It may request, claim, observe, execute inside a lease, and submit results. It may not decide.
3. Nothing the harness stores locally (conversations, event log, caches) is authoritative for execution state. On disagreement, ACS wins and the run goes to reconciliation.
4. The adapter and the agent process beneath it are **untrusted**: their output is validated input, their reported success is a claim, their config is inspected not trusted.

## 2. Principals and credentials

| Principal             | Identity source                                                                                                                                                                   | May                                                                                          | Must never                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Operator (human)      | ACS user auth with operator role (OAuth device flow, ADR 0016) [V]                                                                                                                | Create runs, approve or reject, cancel, review results                                       | Delegate approval to the harness, agent or renderer                                                    |
| Harness service       | Worker credential with TTL/rotation/revoke ([`worker-identity.md`](../protocol/worker-identity.md)) [V]; worker id derived from the credential, body identity fields rejected [V] | Claim leased work, renew leases, submit results, report observations, request tool decisions | Approve anything; supply identity, lease or policy fields it was not given; read other workers' work   |
| Agent process         | None. Holds only a run-scoped gate token                                                                                                                                          | Ask the gate for a tool decision                                                             | Reach ACS beyond the gate; hold the lease token, worker credential or a long-lived provider credential |
| Renderer / CLI driver | Operator session only                                                                                                                                                             | Issue commands through harness-core; display events                                          | Hold execution authority or any credential beyond the operator session                                 |
| ACS gateway           | Itself                                                                                                                                                                            | Everything in section 1                                                                      | n/a                                                                                                    |

Gate token: random per run, delivered through a `0600` file and never argv (pattern from ADR 0024 [V]), valid only while the attempt's lease is active and the fencing epoch matches.

## 3. Entity mapping

| Harness concept | ACS anchor                                          | Notes                                                                                                                                                                              |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HarnessRun`    | **Work item** + current **attempt**                 | Requires the plan-backend decision in [ADR 0029](../adr/0029-desktop-harness-is-an-acs-client.md) (G1). ADR 0022 agent runs have no lease/plan/approval and are not an anchor [V]. |
| Run authority   | **Lease** (`lease_id`, `fencing_epoch`)             | Lease token stays in harness-core memory only [V token semantics in `worker-leases.md`]                                                                                            |
| Run approval    | **Approval record** bound to `actionHash`           | Existing hash covers requester, risk, action kind/params, command, cwd, paths [V]. Must be extended (G2).                                                                          |
| Tool decision   | **Tool check**                                      | Exists only for ADR 0022 agent runs, keyed by agent-run id (`POST /api/agent-runs/:id/tool-check`) [V]. Needs an attempt-keyed form (G3).                                          |
| Run result      | **Attempt result** (`POST /work-items/:id/results`) | Idempotent, immutable, lease/worker/action-hash checked [V].                                                                                                                       |
| Run event       | Harness projection + ACS audit event refs           | ACS audit chain is canonical (ADR 0011) [V]                                                                                                                                        |
| `parentRunId`   | Reserved                                            | Present in schemas, rejected unless null in Slice 1 (Phase 3 delegation)                                                                                                           |

### RunBinding

The harness receives these from ACS and echoes them on every authority-relevant call. It never constructs them.

```ts
interface RunBinding {
  workItemId: string;
  attemptId: string;
  leaseId: string; // opaque id, not the token
  fencingEpoch: number; // monotone; stale epoch = stop
  actionHash: string; // sha256 hex, from ACS policy evaluation
  planHash: string;
  inputHash: string;
  workspaceHash: string;
  policyVersion: string; // [P] must be inside the approved hash (G2)
  adapterId: string; // [P]
  adapterConfigHash: string; // [P] sha256 of effective agent config, see adapter spec §5
  governance: "governed" | "acs_guarded" | "os_sandboxed" | "host_permissions"; // [P]
}
```

Fields marked [P] are not in today's action hash. Until G2 lands they must not be described as approval-bound.

## 4. Run lifecycle

State owner is ACS for authority and the harness for process facts. Numbered steps are normative order.

1. **Request.** Operator submits task (agent, prompt, repository, limits) to ACS. ACS validates, evaluates policy, creates the work item and execution plan. Result: `approved` or `needs_approval` (or `deny`). The harness is not involved yet.
2. **Approval.** If required, a human approves via the authenticated gateway route; self-approval of high/critical risk is denied; the grant is request-bound, single-use, expiring (default 10 minutes) [V]. The harness may display the pending state; it has no approval call.
3. **Claim.** Harness calls `POST /worker/claim` with an empty body or `leaseMs`; ACS derives worker id from the credential, claims under a fresh attempt lease, consumes the approval, returns `RunBinding` plus the lease token [V response fields per `worker-leases.md`]. No eligible work returns `{claimed:false}`.
4. **Prepare.** Harness allocates the isolated workspace, writes the gate-token file, builds the adapter config, computes `adapterConfigHash`, and checks adapter `capabilities().governance` is at least what the work item requires. Mismatch: submit a failed result, never start.
5. **Start.** `adapter.start(request)`. The first event is `run.started` carrying the binding (not the lease token).
6. **Execute.** Events stream. Every tool decision goes through the gate (section 5). Harness renews the lease before expiry and re-reads authority on a bounded interval (section 7).
7. **Exit.** Adapter emits `adapter.exited {code, signal}`. This is a process fact only.
8. **Submit.** Harness submits the result with `lease_id`, `action_hash` and a bounded canonical payload. ACS validates and closes the lease atomically [V]. The harness reports `submitted`, not `succeeded`.
9. **Verify and review.** ACS-side independent verification and result assessment decide the outcome; a `succeeded` run is `pending_review` until a human accepts or rejects (ADR 0024 pattern [V]). Only then does the harness emit terminal `run.terminal` with the status ACS reports.

Terminal statuses: `succeeded`, `failed`, `cancelled`, `timed_out`, `outcome_unknown`. `review` is orthogonal: `pending | accepted | rejected`.

## 5. Approvals and tool gating

Rule: **an approval authorizes exactly one invocation.** The harness only transports the question and the answer.

1. **Invocation hash** [P]: `sha256("acs:harness-tool-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments, attemptId, workspaceHash, adapterConfigHash}))`. This follows the `acs.jc.v1` construction (`strictCanonicalJsonV1`, domain-separated prefix) [V] and adds the account-, workspace- and configuration-binding the architecture review requires. Arguments are never rewritten; the hash covers what the agent actually sent.
2. **Gate call** [P]: the agent-side hook posts `{toolName, arguments, invocationHash, adapterEventSeq}` to the attempt-keyed gate. ACS answers `allow`, `deny` (with reason) or `approval_required` (with `approvalId`, `expiresAt`).
3. **Waiting.** On `approval_required` the hook blocks, the adapter emits `approval.requested`, and the hook polls until resolved or until `expiresAt`. Timeout, ACS unreachable, malformed response, or lease loss all resolve to **deny** (fail closed; consistent with the ADR 0024 hook [V]).
4. **Approval record.** Created by ACS policy, granted by a human, consumed once atomically with the decision. The approval is checked against: exact `invocationHash`, requesting account, attempt/lease/epoch, expiry, not-already-consumed.
5. **Replay and swap.** Same hash again after consumption: new approval required. Different arguments: different hash: not covered. Both are tested negatives (FR-7).
6. **Governed capabilities** (mode `governed`, milestone M2 [P]): tool effects execute through the ACS MCP bridge using `acs.jc.v1` / `acs.dc.v1` capabilities (30 s TTL, single-use nonce, audience-bound) [V]. The gate then is the capability issuance path itself, not a separate hook.
7. **Local deny floor.** A local deny-list in the hook may tighten but never loosen an ACS decision [V per ADR 0024]. It is not a boundary and is documented as such.

## 6. Events and audit

### 6.1 Event envelope

```ts
interface RunEvent {
  runId: string;
  seq: number; // gapless, starts at 0, per run
  cursor: string; // opaque; resume = strictly after this cursor
  ts: string; // ISO 8601
  source: "adapter" | "acs" | "harness";
  type: RunEventType;
  data: Record<string, unknown>; // type-specific, strict-validated
  auditRef?: { eventId: string; hash: string }; // present for ACS-recorded facts
}
```

`RunEventType` (v1): `run.started`, `message.delta`, `message.complete`, `tool.requested`, `tool.decision`, `tool.started`, `tool.result`, `approval.requested`, `approval.resolved`, `artifact.created`, `usage`, `adapter.warning`, `adapter.exited`, `authority.changed`, `cancel.requested`, `cancel.completed`, `reconcile.started`, `reconcile.completed`, `run.submitted`, `run.terminal`.

### 6.2 Rules

1. `seq` is assigned by harness-core on append, not by the adapter, so adapters cannot create gaps or reorder.
2. The log is append-only. Redaction runs **before** append (shared redaction utilities in `packages/shared` [V exists; exact API [U]]); secrets never reach disk or the UI.
3. `source:"adapter"` events may not be `run.terminal`, `run.submitted`, `approval.resolved`, `authority.changed` or `cancel.completed`. Core drops and records an `adapter.warning` if an adapter attempts it.
4. Unknown adapter event kinds become `adapter.warning` with a content hash; they are never silently discarded.
5. Replay: `events(runId, cursor)` returns exactly the events with `seq` greater than the cursor's, in order, and then live events with no gap or duplicate across the boundary.
6. ACS-recorded facts (claim, approval consumed, lease expired, cancel, result accepted) carry `auditRef` and are written to the canonical chain by ACS, event names under a new `harness_run.*` namespace [P], following the existing `agent_run.*` convention [V].
7. Hash-chain verification remains an ACS function; the harness log is checked against ACS refs during reconcile, never the other way round.

## 7. Authority freshness and cancellation

### 7.1 Freshness

Before every gate decision, before every lease renewal, and at least every `authorityPollMs` (default 5 s, must be less than half the lease TTL [P]), harness-core reads attempt authority. It must see all of: work item in a running state, `leaseId` matches, lease `active` and **not expired**, `fencingEpoch` equals the claimed epoch, no cancel requested. Any failure: emit `authority.changed`, stop the agent (section 7.2), and move to reconciliation. A check-then-act read is not an atomic guarantee, so it is a floor; the atomic form is G4.

### 7.2 Cancellation order

1. Operator cancels at ACS (`POST /work-items/:id/cancel`, operator-authenticated; semantics for a running attempt [U], see G6). The harness cannot cancel on the operator's behalf with its own credential, except to abort for its own failure by submitting a `failed` result.
2. Harness observes cancel (poll or stream) and emits `cancel.requested`.
3. Gate immediately denies all new tool calls.
4. Adapter `cancel(runId)`: cooperative stop, then process-group termination after a grace period.
5. Harness verifies the process group is gone and no tool call was in flight, then emits `cancel.completed` and reports to ACS (G6).
6. If any of that cannot be verified within the deadline: terminal status is `outcome_unknown`, never `cancelled`.

Cancellation stops a process; it does not prove no side effect happened. ACS itself documents that lease expiry accounting does not prove a remote side effect stopped [V in `worker-leases.md`]. The contract keeps the same honesty.

## 8. `outcome_unknown` and reconciliation

### 8.1 Entry conditions

Any of: harness crashed or restarted with a non-terminal run; adapter event stream lost or malformed mid-run; agent exited while a tool call was in flight or approval pending; ACS unreachable at result submission; cancel not confirmed by deadline; lease lost or epoch changed while the agent was running; process liveness unknowable.

### 8.2 Rules

1. State is sticky. Only a `reconcile.completed` event backed by evidence can leave it.
2. `reconcile(runId)` gathers, and records as artifacts: ACS work item/attempt/lease/result state and audit refs; adapter-side facts (process alive, last seq, tool calls started without a result); workspace facts (`git status`/diff hash against the pre-run baseline).
3. Verdicts: `no_effects_proven` (workspace unchanged from baseline, no completed or in-flight mutating tool call recorded, process dead), `effects_present` (changes or completed mutating calls exist; becomes a normal result for review), `still_unknown` (cannot prove either way; stays `outcome_unknown` and surfaces to the operator).
4. **No blind retry.** There is no edge from `outcome_unknown` to a new attempt. Retry is an operator action through ACS (`POST /work-items/:id/retry` [V route]), creating a new attempt that requires its own approval if mutating.
5. Orphans: on restart, an agent process is signalled only if its pid and start time match what was recorded for this run (ADR 0024 rule [V]). An unverifiable process is left alone and reported.

## 9. Failure matrix (each row is a test)

| Failure                                                       | Required behavior                                                             | Status                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Missing, invalid, expired or revoked worker credential        | Claim fails closed; no run starts                                             | `failed` (never started)                       |
| Claim returns a binding the harness cannot validate           | Do not start; submit `failed` if a lease exists                               | `failed`                                       |
| Adapter governance below work item requirement                | Do not start                                                                  | `failed`                                       |
| Adapter `health()` reports `unsafe` (including bypass config) | Do not start                                                                  | `failed`                                       |
| Gate unreachable, slow past deadline, or malformed response   | Deny the call                                                                 | run continues or fails per agent behavior      |
| Approval expired, replayed, argument-swapped, or self-granted | Deny                                                                          | n/a                                            |
| Stale fencing epoch or lease expired or revoked               | Stop agent; no result submission with stale epoch                             | `outcome_unknown` until reconciled             |
| ACS unreachable mid-run                                       | Gate denies; continue only cooperative wind-down; retry reads with backoff    | `outcome_unknown` if not recovered by deadline |
| ACS unreachable at submission                                 | Keep result durably, retry submission idempotently                            | `outcome_unknown` until accepted               |
| Result submission rejected (409/403/410)                      | Do not retry with different identity; reconcile                               | `outcome_unknown`                              |
| Harness crash                                                 | Restart reconciles every non-terminal run                                     | per section 8                                  |
| Agent exits 0 with no changes and auth-failure output         | Not success (ADR 0024 `failure_signature`)                                    | `failed`                                       |
| Event store torn write                                        | Truncate to last valid record, re-derive `seq` from it; compare with ACS refs | reconcile if refs disagree                     |
| Duplicate cancel / duplicate result                           | Idempotent; exact replay returns original                                     | unchanged                                      |

## 10. Adapter contract (`harness.adapter.v1`)

Refines the architecture review's interface. Changes from the review: a `contractVersion`; capabilities that are _checkable_; cursors typed; `RunRequest` carries the ACS binding and gate (the adapter gets no lease token); `start` is idempotent per `runId`; the adapter cannot report success; `reconcile` returns evidence.

```ts
export interface AgentAdapter {
  readonly id: string;
  capabilities(): Promise<AgentCapabilities>;
  health(): Promise<AgentHealth>;
  start(request: RunRequest): Promise<RunHandle>; // idempotent per runId
  events(runId: string, cursor?: string): AsyncIterable<RunEvent>; // adapter-source events only
  status(runId: string): Promise<RunStatus>;
  cancel(runId: string): Promise<CancelResult>;
  reconcile(runId: string): Promise<ReconciliationResult>;
  resume?(runId: string, checkpoint: string): Promise<RunHandle>; // present only if capabilities().resume !== false
}

export interface AgentCapabilities {
  contractVersion: "harness.adapter.v1";
  adapterId: string;
  runtime: { name: string; version: string };
  governance: "governed" | "acs_guarded" | "os_sandboxed" | "host_permissions";
  isolation: { kind: "none" | "worktree" | "container" | "bubblewrap"; network: "none" | "allowlist" | "open" };
  streaming: boolean;
  toolCallVisibility: "per_call" | "summary" | "none";
  approvals: "blocking_gate" | "none";
  cancel: "cooperative" | "process_group" | "none"; // strongest guaranteed
  resume: false | { kind: "checkpoint" };
  reconcile: boolean;
  limits: { maxWallClockMs: number; maxToolCalls?: number; maxBudgetUsd?: number; maxOutputBytes: number };
  configHash: string; // sha256 of effective behavior-affecting config
}

export interface AgentHealth {
  status: "ready" | "degraded" | "unsafe" | "unavailable";
  checks: { name: string; ok: boolean; detail?: string }[]; // never includes secret values
}

export interface RunRequest {
  runId: string;
  binding: RunBinding; // no lease token
  task: { prompt: string; successCriteria: string[] };
  workspace: { allocationId: string; hostPath: string; baselineHash: string };
  limits: AgentCapabilities["limits"];
  gate: { url: string; tokenFile: string }; // per-run, 0600
  parentRunId: null; // Slice 1: must be null
}

export interface RunHandle {
  runId: string;
  adapterRunId: string;
  startedAt: string;
}

export interface RunStatus {
  state: "starting" | "running" | "awaiting_approval" | "exited" | "unknown";
  exit?: { code: number | null; signal: string | null };
  lastSeq: number;
  lastEventAt?: string;
}

export interface CancelResult {
  outcome: "terminated" | "already_exited" | "unconfirmed";
  inFlightToolCalls: number | "unknown";
  evidence: EvidenceRef[];
}

export interface ReconciliationResult {
  verdict: "no_effects_proven" | "effects_present" | "still_unknown";
  processAlive: boolean | "unknown";
  evidence: EvidenceRef[];
}

export interface EvidenceRef {
  kind: string;
  sha256: string;
  uri?: string;
}
```

### Conformance obligations (enforced by the shared suite, FR-2)

1. `capabilities()` is stable for a given config and truthful: `resume` absent unless `resume()` exists and passes the checkpoint test; `toolCallVisibility: "per_call"` requires a `tool.requested` for every tool call in a scripted scenario; `cancel: "process_group"` requires a scripted child tree to die.
2. `health()` returns `unsafe` for each seeded unsafe config; never throws; never echoes a secret.
3. `start()` twice with the same `runId` returns the same handle and starts one process.
4. `events()` obeys cursor semantics (section 6.2 rule 5) and emits only permitted types (rule 3).
5. `cancel()` is idempotent and never reports `terminated` while a descendant lives.
6. `reconcile()` is read-only with respect to the workspace and agent.
7. The adapter never imports ACS stores, never calls ACS routes directly, and never receives the lease token or worker credential.

## 11. Gaps in ACS today (all Ask-first; each is its own ACS slice)

| ID  | Gap                                                                                                                                                                                                              | Why needed                                                        | Evidence                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| G1  | No work-item plan backend for an interactive agent session. The plan contract fixes `network: "none"` and two backends; ADR 0022 explicitly rejected adding a third [V].                                         | Anchor runs on the real lease/approval/verification machinery     | ADR 0022 "Rejected alternatives"; decision in ADR 0029                                      |
| G2  | Action hash lacks `adapterId`, `adapterConfigHash`, `governance`, `policyVersion`.                                                                                                                               | INV-3: approval bound to configuration                            | `approval-lifecycle.md` hash fields [V]                                                     |
| G3  | Tool-check exists only for ADR 0022 agent runs, keyed by run id, with a deny-list floor and call budget; no invocation-hash approval binding and no interactive approval wait.                                   | INV-3, FR-7                                                       | `apps/gateway/src/agent-routes.ts:315` [V]                                                  |
| G4  | No atomic per-mutation authority consume. Bridge-level lease re-read is check-then-forward; `verifyAndReserve` nonces were process-memory only in the reviewed harness code.                                     | Executors must not accept offline-valid capabilities after cancel | Slice 1 assessment F-1, F-5, S5 [L]; later reported partly built in the absent worktree [U] |
| G5  | Unconfirmed HTTP surface for lease renewal and for reading attempt authority (lease status, epoch, cancel-requested) in one call. `renewAttemptLease` exists in the store [V]; its route is not confirmed.       | Section 7.1                                                       | `worker-leases.md` [V]; route search [U]                                                    |
| G6  | Cancellation of a _running leased_ attempt: effect on lease, and no way for the executor to acknowledge process death.                                                                                           | Section 7.2                                                       | `POST /work-items/:id/cancel` exists [V]; running-attempt semantics [U]                     |
| G7  | Result payload for an agent session (transcript hash, diff hash, tool-call log hash, usage) is not defined; `worker-results.md` was not read in this pass.                                                       | Section 4 step 8                                                  | [U]; read in T5                                                                             |
| G8  | Whether ACS emits a replayable event stream (approval/lease/cancel) usable by the harness, versus polling only.                                                                                                  | Section 6, latency of approvals                                   | [U]                                                                                         |
| G9  | Scoped, short-lived model credential for the agent (model proxy). Prior assessment says a proxy exists in the absent worktree [U]; the in-repo ADR 0014 path injects one credential into an isolated `HOME` [V]. | INV-5                                                             | `engineTaskSchema.credential` [V]; assessment [L]                                           |

Slice 1 scope shrinks to what ACS supports. It never grows a harness-side substitute for a gap.
