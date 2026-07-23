# ACS-to-iii Authority Map

- **Status:** Phase 1 authoritative target architecture
- **Scope:** Authority only; no iii integration, live shell execution, deployment, service change, or credential change is authorized by this document.
- **Applies to:** Every privileged action requested through a human, Hermes, OpenClaw, AgentMemory, Codex Swarm, iii, or another worker.

`MUST`, `MUST NOT`, `SHALL`, and `SHALL NOT` are normative. “Current” describes repository behavior at base commit `22ebcc94b7a85d105b1400a557302a77eb6422d7`; “target” defines the required ACS-to-iii architecture. A current contradiction is a migration requirement, not permission to weaken the target.

## 1. Authority rule

ACS is the sole policy and execution-authorization control plane. The dedicated iii engine is the sole message-routing, queue-delivery, retry, and transport-trace engine. These authorities do not overlap.

| Concern                       | Exclusive authority        |
| ----------------------------- | -------------------------- |
| Human intent and approval     | Human through ACS          |
| Policy decisions              | ACS                        |
| Work-item state               | ACS SQLite ledger          |
| Action approval hashes        | ACS                        |
| Message routing               | Dedicated iii engine       |
| Queue delivery and retries    | Dedicated iii engine       |
| Execution                     | Individual bounded workers |
| Memory and historical context | AgentMemory                |
| Coding task execution         | Codex Swarm                |
| User conversation             | Hermes and OpenClaw        |
| Final authoritative result    | ACS SQLite ledger          |

“Exclusive authority” means that another component may carry, cache, display, or propose the information, but may not replace the named authority. iii transport state is not ACS work-item state. AgentMemory recall is not policy. A worker report is not a final result. A conversational confirmation is not approval.

## 2. Privileged-action lifecycle

Every privileged action has exactly one authority chain:

| Question                           | Answer                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may request it?                | A human, Hermes, or OpenClaw may propose intent to ACS. A bounded worker may return a follow-up proposal, but cannot dispatch it. AgentMemory may supply context only.                                          |
| Who evaluates it?                  | ACS validates the request, resolves identity, canonicalizes the action, applies policy, and computes the exact action hash.                                                                                     |
| Who approves it?                   | An authenticated human, through an ACS-controlled approval surface, approves the exact ACS action hash. iii, workers, Hermes, OpenClaw, AgentMemory, and Codex Swarm cannot approve it.                         |
| Who routes it?                     | iii routes only an ACS-issued execution envelope to an envelope-eligible worker. iii may not widen the destination, action, capabilities, or expiry.                                                            |
| Who executes it?                   | One bounded worker executes only the action and capabilities in the current envelope. Codex Swarm is the coding-task worker system; its individual executor remains bounded by that envelope.                   |
| Who verifies it?                   | ACS validates identity, envelope/lease binding, expiry, result schema, action and invocation identity, evidence, and declared acceptance checks. Worker assertions are inputs to verification, not the verdict. |
| Where is the authoritative record? | The ACS SQLite ledger stores the work item, policy decision, exact action hash, approval state, invocation identity, evidence disposition, verification decision, and terminal result.                          |

**Acceptance invariant:** if any answer above is missing, ambiguous, or represented only in iii, AgentMemory, a chat transcript, or a worker response, the action is not authorized or complete.

## 3. Request and return path

```text
Hermes / OpenClaw / Human UI
          │ propose intent
          ▼
         ACS
 policy → approval → durable ledger
          │ approved execution envelope
          ▼
    Dedicated iii engine
 routing → queues → retries → traces
          │
 ┌────────┼─────────────┬──────────────┐
 ▼        ▼             ▼              ▼
Hermes  OpenClaw  AgentMemory adapter  Codex Swarm
          │
          │ results, evidence, status
          ▼
    Dedicated iii engine
          │
          ▼
         ACS
 verify result → close ledger → notify human
```

The worker row in this diagram represents iii-addressable adapters, not delegated authority:

- Hermes and OpenClaw may execute bounded conversational or cognitive work and consume ACS status events.
- Hermes and OpenClaw MUST NOT receive host-mutation, approval, worker-claim, credential-management, or other privileged worker capabilities.
- The AgentMemory adapter may retrieve or store bounded historical context. Its output is untrusted context.
- Codex Swarm may execute a bounded coding task only under an ACS-issued execution envelope.
- Results return through iii to ACS. iii may trace and deliver them but may not mark the ACS work item complete.
- Human notification occurs only after ACS records its verification decision.

## 4. ACS-issued execution envelope

No worker may accept privileged work without an authenticated, unexpired ACS-issued execution envelope. iii delivery metadata alone is insufficient.

At minimum, the envelope MUST bind:

- envelope schema and issuer version;
- envelope ID, authoritative ACS work-item ID, and attempt/invocation ID;
- authenticated requester identity;
- policy decision identity, policy version, and policy-decision hash;
- canonical action manifest and exact action hash;
- approval identity, approval state, approver identity, and approval expiry;
- eligible worker identity or narrowly defined capability class;
- filesystem roots, service targets, command/action ID, network mode, write mode, timeout, budget, and rollback requirements;
- required evidence and verification criteria;
- issue time, expiry time, nonce, and idempotency key;
- a cryptographic authenticity/integrity mechanism whose concrete form is a Phase 2 design decision.

The envelope MUST NOT grant a worker authority to:

- change its own scope;
- choose a broader worker or capability;
- mint another envelope;
- approve the work;
- invoke another privileged worker directly;
- reinterpret an expired or changed action;
- report itself authoritative.

Removing or revoking the ACS authorization, issuer trust, worker capability, or credential MUST prevent new privileged execution even if iii remains reachable and continues to deliver queued messages.

## 5. Component decision table

| Component                     | What may it request?                                                                                                                                                     | What may it approve?                                                                                                    | What may it execute?                                                                                                               | What may it persist?                                                                                                                                      | What may it declare authoritative?                                                                                       | Credentials or capabilities it may hold                                                                                                                  | What it must never do                                                                                                                                                    | If compromised                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human operator**            | Any intended work through ACS; cancellation or review of existing work.                                                                                                  | Exact ACS action hashes through an authenticated ACS approval surface.                                                  | No automated worker action unless separately registered as a bounded worker; manual out-of-band actions are outside this pipeline. | Intent, reason, and approval input through ACS; no direct ledger mutation.                                                                                | Human intent and explicit approval only, not execution success.                                                          | Human ACS login/approval capability; no worker lease or iii routing administrator capability by default.                                                 | Approve from an untrusted chat confirmation, edit ledger rows, lend approval identity to an agent, or treat a worker claim as proof.                                     | Revoke the human identity, block new approvals, preserve prior records, and require a separately authenticated human to recover authority.                                                                  |
| **ACS**                       | Deterministic verification, reconciliation, cancellation, or recovery work derived from existing work items; it may not invent human intent for a new privileged action. | Policy allow/deny and whether human approval is required; it records human approval but does not impersonate the human. | Validation, canonicalization, verification, and ledger transitions; no direct privileged host mutation.                            | Authoritative work items, policy decisions, hashes, approvals, invocation identities, audit events, evidence disposition, and terminal results in SQLite. | Policy decision, authorization state, work-item lifecycle, verification decision, and final result.                      | Ledger access, envelope-issuer key, identity registry, policy configuration; no general worker host credential.                                          | Delegate policy to iii, accept memory/chat/worker assertions as authority, close unverified work, or continue privileged mutation when required audit persistence fails. | Stop envelope issuance and privileged transitions, revoke issuer credentials, preserve the ledger, verify audit integrity, and recover under human control.                                                 |
| **Dedicated iii engine**      | Delivery/retry/reconciliation operations for valid ACS envelopes only.                                                                                                   | Nothing.                                                                                                                | Routing, queue operations, bounded retries, deduplication, backpressure, and transport tracing; never the privileged action.       | Queue state, delivery attempts, retry state, and transport traces.                                                                                        | Delivery and transport status only.                                                                                      | Envelope-verification material, queue credentials, and narrowly scoped worker endpoints; no human-approval, ACS-ledger-write, or broad host credentials. | Approve, change policy, alter an envelope, infer authorization from reachability, create work items, or mark work complete.                                              | It may delay, drop, reorder, or replay messages, but cannot create authority. ACS stops dispatch/closure, workers reject invalid or duplicate invocations, and revoking ACS authorization blocks execution. |
| **Hermes**                    | User intent, clarification, plans, and follow-up proposals to ACS; status reads.                                                                                         | Nothing.                                                                                                                | User conversation and explicitly non-privileged bounded cognitive work.                                                            | Conversation/session state according to its own retention policy; never the authoritative work record.                                                    | Nothing about policy, approval, execution, or completion.                                                                | Conversation-channel credentials and read/status capability; optional non-privileged iii consumer capability.                                            | Directly perform privileged work, receive privileged worker functions, approve its own proposal, mint envelopes, or bypass ACS through iii.                              | Revoke its connector identity; ACS rejects its requests or treats them as untrusted proposals; existing approvals and worker credentials remain unavailable.                                                |
| **OpenClaw**                  | User intent, desktop-context proposals, and status reads to ACS.                                                                                                         | Nothing.                                                                                                                | User conversation and explicitly non-privileged bounded bridge work.                                                               | Conversation/bridge state according to its own retention policy; never ACS state.                                                                         | Nothing about policy, approval, execution, or completion.                                                                | Conversation/bridge credential and read/status capability; no privileged worker credential.                                                              | Execute a privileged desktop/host action, approve work, translate a chat confirmation into approval, or invoke a privileged worker.                                      | Revoke its connector identity and capability; ACS rejects new privileged proposals or requires fresh human review; iii reachability grants nothing.                                                         |
| **AgentMemory**               | Context retrieval/storage operations; it may return suggested facts or follow-up context, not privileged dispatch.                                                       | Nothing.                                                                                                                | Bounded memory query/write through its adapter.                                                                                    | Historical context, provenance, and recall indexes.                                                                                                       | Only that a memory record exists with stated provenance; never that its content is true, current, approved, or executed. | Memory-store access scoped to its adapter; no worker lease, approval, policy, or host-mutation credential.                                               | Act as a policy source, silently convert memory to approval, overwrite ACS history, or originate privileged execution.                                                   | Treat all returned content as untrusted; ACS revalidates current facts and policy. Disable the adapter without losing ACS authority or ledger continuity.                                                   |
| **Codex Swarm**               | Clarifications and follow-up proposals returned as evidence to ACS.                                                                                                      | Nothing.                                                                                                                | Coding work within the exact repository/worktree, action, tools, network, write, timeout, and budget limits in the envelope.       | Ephemeral worktree/process state and bounded evidence; any durable code change remains subject to ACS verification and repository controls.               | Nothing. A green command or self-review is evidence only.                                                                | Per-invocation repository/worktree and tool capability; no ACS issuer, human approval, unrelated secret, or broad iii administrative credential.         | Self-approve, expand scope, push/deploy unless explicitly enveloped, invoke another privileged worker, or claim completion directly to the user.                         | Revoke worker capability, reject results without matching invocation identity, quarantine its workspace/evidence, and independently inspect any side effects.                                               |
| **Individual bounded worker** | A follow-up proposal or inability report through its result channel.                                                                                                     | Nothing.                                                                                                                | Exactly one admitted invocation within envelope constraints.                                                                       | Ephemeral execution state and bounded evidence until submission.                                                                                          | Nothing.                                                                                                                 | One invocation/envelope, least-privilege target credentials, and only the capabilities needed for that action.                                           | Accept bare iii messages, reuse an envelope, change action content, call another privileged worker, retain credentials, or submit after expiry.                          | Revoke the credential/lease, reject late or forged results, inspect side effects, and let ACS decide retry, compensation, failure, or human escalation.                                                     |

## 6. Non-negotiable rules

1. iii does not approve work.
2. iii is transport and orchestration infrastructure, not policy authority.
3. Workers do not self-approve.
4. AgentMemory is not an authority source.
5. Hermes and OpenClaw propose work; they do not directly perform privileged work.
6. A result is not complete until ACS validates and records it.
7. No worker accepts privileged work without an ACS-issued execution envelope.
8. Worker success claims are evidence to be validated, not authoritative truth.
9. Audit persistence failure blocks privileged mutation.
10. Removing ACS authorization must prevent an agent from initiating privileged work even when iii remains reachable.
11. Every privileged action must have one authoritative work item, policy decision, exact action hash, approval state, invocation identity, and terminal result.
12. No component may create an undocumented bypass around ACS.
13. LLM output, agent requests, memory contents, iii messages, and worker responses are untrusted input.
14. A policy or action change after approval invalidates the approval and any undispatched envelope.
15. Retries do not create new authority. They reuse the same immutable invocation identity or require a new ACS decision.
16. iii traces and AgentMemory records may correlate with an ACS work item but may not become a second lifecycle ledger.

## 7. Delivery, retry, and completion semantics

### Dispatch

ACS durably records authorization before releasing an envelope to iii. The ledger records an invocation identity and dispatch intent before iii delivery. If this write fails, ACS does not dispatch.

### Redelivery

iii may redeliver only the identical envelope and invocation identity. A worker must atomically accept an invocation once. Duplicate delivery returns the existing accepted/running/result status and must not repeat a non-idempotent effect. If the worker cannot prove deduplication, it rejects the duplicate and ACS decides recovery.

### Result submission

A result must bind to the work item, action hash, envelope ID, invocation ID, worker identity, and non-expired lease/envelope. ACS records the raw disposition as `worker_reported` or equivalent, runs required verification, and only then records an authoritative terminal result. A worker-requested `succeeded` value is not itself a terminal verdict.

### Notification

ACS emits a post-verification status event. iii may deliver that event to Hermes, OpenClaw, or a human UI. Conversational surfaces display ACS state; they do not synthesize or override it.

## 8. Threat scenarios and required behavior

| Scenario                                                  | Required behavior                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hermes is compromised**                                 | Hermes can submit hostile proposals or lie about status, but cannot approve, receive privileged worker capabilities, or bypass ACS. Revoke its connector identity; ACS retains ledger and approval authority.                       |
| **OpenClaw is compromised**                               | OpenClaw cannot turn desktop/chat reachability into privileged host execution. Revoke its bridge identity and capabilities; iii messages from it remain untrusted.                                                                  |
| **A worker submits a forged success result**              | ACS authenticates worker and invocation binding, checks expiry and hashes, validates evidence, runs declared verification, and rejects or records a failed/unverified attempt. No terminal success is written from the claim alone. |
| **AgentMemory contains false or stale information**       | The content is context only. ACS and workers re-read current authoritative sources when material, record provenance, and never derive approval or completion from memory.                                                           |
| **iii is unavailable**                                    | ACS retains durable approved/not-dispatched or running/awaiting-result state. No direct worker fallback is allowed. Dispatch resumes only through iii with the same valid envelope or a new ACS decision after expiry.              |
| **iii redelivers an invocation**                          | The immutable invocation ID and idempotency key deduplicate delivery. A duplicate cannot repeat a privileged effect or obtain a fresh lease merely because it was redelivered.                                                      |
| **ACS crashes after approval but before dispatch**        | Approval and work-item state remain in SQLite. On recovery ACS reconciles whether dispatch intent exists; it issues no duplicate invocation and rechecks approval/policy/expiry before first dispatch.                              |
| **ACS crashes after dispatch but before acknowledgment**  | ACS treats delivery as uncertain. It queries/reconciles iii by invocation ID; it does not mint a different action or blindly redispatch a non-idempotent effect.                                                                    |
| **A worker crashes during execution**                     | Lease/envelope expiry prevents a stale result. ACS records timeout/loss after reconciliation and chooses retry only when idempotency and side-effect evidence permit; otherwise it blocks for human review or compensation.         |
| **The audit store cannot persist**                        | ACS does not authorize or dispatch a privileged mutation. If failure occurs after an external effect, ACS does not claim completion; it blocks, preserves available evidence, and requires reconciliation.                          |
| **An action changes after approval**                      | Canonicalization produces a different action hash. The approval and undispatched envelope become invalid; ACS requires a new policy decision and human approval. iii and workers reject the mismatch.                               |
| **A credential is removed from an agent**                 | New claims and execution fail even if iii can still reach the endpoint. Workers check current credential/capability and envelope validity at acceptance; cached transport reachability is not authority.                            |
| **A worker attempts to invoke another privileged worker** | The call is rejected because the first worker has no envelope-issuer or downstream invocation capability. It may return a follow-up proposal to ACS, which creates a separate governed work item if authorized.                     |
| **A result arrives after its execution envelope expires** | ACS records the late arrival as rejected/diagnostic evidence, does not close the work item as succeeded, and reconciles possible side effects before any retry.                                                                     |

## 9. Agreement with the current ACS repository

The target model above is intentionally stricter than the current Phase 1 code. The rows below separate controls evidenced in the current repository from contradictions that remain to be remediated later. An aligned row is limited to the cited behavior; it does not claim that the full target architecture is implemented.

### Aligned controls

| Target rule                                                                            | Current evidence                                                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACS is the enforcement boundary.                                                       | `docs/adr/0001-local-control-plane-boundary.md:13-28`; `docs/threat-model.md:43-80`.                                                                      |
| Policy fails closed and unknown/destructive actions are denied.                        | `packages/policy-gate/src/policy.ts:90-106`; `packages/policy-gate/src/rules.ts:36-59,120-126`.                                                           |
| ACS owns work-item state and lifecycle.                                                | `packages/work-items/src/state-machine.ts:4-25`; `packages/work-items/src/store.ts:526-578`.                                                              |
| ACS records current policy decisions and action fingerprints.                          | `packages/policy-gate/src/tools.ts:39-66`; `packages/work-items/src/store.ts:1349-1426`. The completeness of the runtime fingerprint is classified below. |
| MCP cannot use the legacy approval tool.                                               | `apps/gateway/src/mcp.ts:198-208`.                                                                                                                        |
| The connector alias requires a registered HUMAN actor.                                 | `apps/gateway/src/connector.ts:388-400,1168-1172`.                                                                                                        |
| Worker HTTP identity is credential-bound, and results are lease-bound.                 | `apps/gateway/src/server.ts:731-764,1026-1052`; `packages/work-items/src/store.ts:1518-1656`.                                                             |
| Audit and state mutation share a SQLite transaction; an invalid chain disables writes. | `packages/work-items/src/store.ts:1739-1809,1908-1948`; `docs/threat-model.md:122-127`.                                                                   |
| Worker evidence is explicitly labeled as worker-reported.                              | `packages/work-items/src/store.ts:1618-1632`; `packages/work-items/src/work-item.ts:93-124`.                                                              |
| Hermes and OpenClaw are modeled as registry participants, not policy engines.          | `storage/migrations/002_agent_registry.sql:85-99`.                                                                                                        |
| Memory projections are source-backed records rather than approval state.               | `packages/temporal-memory/src/index.ts:4-37`.                                                                                                             |

### Contradictions and implementation gaps

These findings are intentionally recorded rather than silently rewriting current behavior. Every row has the required three labels: **current implementation fact**, **target-architecture gap**, and **later-phase remediation**. “Blocking before...” describes a later implementation gate, not a Phase 1 documentation blocker.

| ID / later-phase consequence                                          | Current implementation fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Target-architecture gap                                                                                                                                                                         | Later-phase remediation                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUTH-01**<br>Blocking before iii cutover                            | No dedicated iii engine, queue contract, delivery identity, or ACS-to-iii adapter exists in the pinned repository. Current claim delivery uses an ACS SQLite FIFO lease (`packages/work-items/src/store.ts:1518-1553`) through the current gateway/worker paths (`apps/worker/src/index.ts:27-65,79-118`; `apps/gateway/src/tools/execute-approved.ts:16-36`).                                                                                                                                                                                               | The target assigns message routing, queue delivery, retries, and transport traces exclusively to a dedicated iii engine without granting it policy or approval authority.                       | Add iii only as transport/routing behind this authority map. No policy or approval code moves into iii.                                                             |
| **AUTH-02**<br>Blocking before privileged result acceptance           | `submitWorkResult` schema-validates and lease-validates a worker-selected terminal status, then immediately stores `succeeded`, `failed`, or `blocked` (`packages/work-items/src/store.ts:1596-1656`). There is no independent ACS verification state or decision before terminal success.                                                                                                                                                                                                                                                                   | The target requires worker evidence to remain provisional until ACS performs semantic verification and records the authoritative terminal result.                                               | Introduce provisional worker results plus explicit ACS verification/closure. Preserve `worker_reported` provenance; never equate it with authoritative success.     |
| **AUTH-03**<br>Blocking before worker dispatch via iii                | Current claims return a work item plus lease token, but no versioned ACS-issued execution-envelope contract binds the full policy decision, approval, invocation identity, worker capability, evidence requirements, and iii route (`apps/worker/src/index.ts:27-65,79-118`; `apps/gateway/src/tools/execute-approved.ts:16-36`). The existing AgentOS task envelope is legacy admission/compatibility material, not an ACS execution grant (`packages/agentos-contracts/README.md:5-11,25-30`; `docs/adr/0008-mission-intake-authority-boundary.md:67-79`). | The target requires every privileged worker invocation to carry an authenticated, unexpired ACS-issued envelope; a bare work item, lease, or iii message is insufficient.                       | Define and validate the envelope before routing integration. Workers reject bare work items and iii-only delivery metadata.                                         |
| **AUTH-04**<br>Documentation contradiction                            | Accepted ADR 0004 and `docs/protocol/approval-lifecycle.md` describe raw one-time approval tokens, while the current store uses exact-hash approval records and leaves `approval_token_hash` dormant (`docs/threat-model.md:124`; `packages/work-items/src/store.ts:1377-1394`).                                                                                                                                                                                                                                                                             | The target has one exact action-hash approval authority and no undocumented parallel bearer-token authority.                                                                                    | Reconcile the ADR/protocol in a separately reviewed documentation/contract change. Do not resurrect a parallel bearer token by accident.                            |
| **AUTH-05**<br>Blocking before all approval ingress is out-of-band    | `remoteMcpToolNames` removes `approve_work_item` but not the connector alias `work_item.approve`, and the explicit MCP denial checks only the legacy name (`apps/gateway/src/mcp.ts:18-20,198-208`). The alias checks for a HUMAN registry actor, but can still travel over the same MCP channel.                                                                                                                                                                                                                                                            | The target requires human approval through an ACS-controlled, genuinely out-of-band approval surface; conversational reachability and transport cannot become approval authority.               | Remove privileged approval capability from conversational/MCP surfaces or prove a separately authenticated out-of-band human channel. Status visibility may remain. |
| **AUTH-06**<br>Blocking before canonical human approval claims        | The direct HTTP approval route uses a configured coarse requester value (`user`) from gateway auth and does not require a canonical registered HUMAN actor (`apps/gateway/src/server.ts:669-683,1010-1023`).                                                                                                                                                                                                                                                                                                                                                 | The target requires approval to bind to a canonical authenticated human identity and the exact action hash, separate from requester, chat, worker, and transport credentials.                   | Bind approval to a canonical authenticated human registry identity and separate it from requester/chat/worker credentials.                                          |
| **AUTH-07**<br>Blocking before capability-based iii routing           | `claimNextApprovedWorkItem` selects the oldest approved row and binds a worker ID, but does not filter by declared worker capability (`packages/work-items/src/store.ts:1518-1552`).                                                                                                                                                                                                                                                                                                                                                                         | The target requires ACS to authorize an eligible worker or capability in the envelope and iii to route only within that bound set.                                                              | Add capability-bound envelope admission and routing; iii must not choose a broader worker or capability.                                                            |
| **AUTH-08**<br>Blocking before privileged Hermes/OpenClaw integration | The repository seeds Hermes/OpenClaw registry identities (`storage/migrations/002_agent_registry.sql:82-99`) but does not implement a status-only iii capability profile proving they cannot receive privileged worker functions.                                                                                                                                                                                                                                                                                                                            | The target permits conversation, proposal, and status consumption only; Hermes and OpenClaw cannot receive privileged worker capabilities.                                                      | Define least-privilege status/conversation adapters and negative tests before connecting either to iii.                                                             |
| **AUTH-09**<br>Required crash/retry hardening                         | Current CAS claim and lease checks constrain duplicate claims/results (`packages/work-items/src/store.ts:1518-1656`), but there is no iii invocation ID or end-to-end redelivery/reconciliation contract.                                                                                                                                                                                                                                                                                                                                                    | The target requires immutable invocation identity, idempotent redelivery, explicit uncertain-delivery handling, and no blind repeat of non-idempotent effects.                                  | Add immutable invocation identity, idempotency, uncertain-delivery reconciliation, late-result handling, and non-idempotent stop conditions.                        |
| **AUTH-10**<br>Naming/integration gap                                 | The repository contains an in-repo temporal-memory projection, not an AgentMemory adapter (`packages/temporal-memory/src/index.ts:4-37`), and no code proves AgentMemory provenance or least-privilege access.                                                                                                                                                                                                                                                                                                                                               | The target permits AgentMemory to supply historical context only; it cannot approve, route, verify, close, or overwrite the ACS ledger.                                                         | Build only a bounded context adapter with provenance/freshness semantics; preserve the non-authority rule.                                                          |
| **AUTH-11**<br>Blocking before exact-hash execution authorization     | The current runtime action hash is created by `packages/policy-gate/src/fingerprint.ts:4-19`. Stronger action-manifest and approval-binding schemas exist (`packages/work-items/src/contracts.ts:177-237`; `packages/work-items/src/store.ts:1362-1493`), but the repository does not show those stronger fields serving as runtime execution authorization.                                                                                                                                                                                                 | The target requires the exact canonical action manifest, policy decision, approval binding, invocation identity, and relevant envelope fields to be covered by one authoritative approval hash. | Make the full action-manifest and approval binding the runtime authorization input, then add mismatch and replay tests.                                             |
| **AUTH-12**<br>Blocking before ACS is the sole policy authority       | `packages/policy-gate/src/contracts.ts:26-45` invokes legacy `agentos-contracts` validation, risk policy, and routing before ACS policy. The legacy package calls this an acknowledged migration gap (`packages/agentos-contracts/README.md:5-11`).                                                                                                                                                                                                                                                                                                          | The target assigns policy decisions exclusively to ACS. Compatibility code may provide evidence but may not veto, approve, route, or create a second lifecycle authority.                       | De-authorize the legacy policy/router veto in a separately reviewed migration while retaining only explicitly non-authoritative compatibility evidence.             |

No row above claims that its target control is already implemented. These are documentation findings and later migration requirements; they do not authorize implementation during Phase 1.

## 10. Phase 2 migration requirements and boundary

Phase 1 freezes authority; it does not authorize iii installation, service changes, credentials, runtime integration, worker expansion, real shell execution, deployment, or cutover.

Phase 2 may begin only as bounded implementation against this map. Its first migration gates are:

1. versioned ACS execution-envelope and invocation contracts;
2. exact action-manifest and approval-hash binding at runtime;
3. explicit provisional-result and ACS-verification lifecycle;
4. canonical out-of-band human approval identity and removal of conversational/MCP approval capability;
5. a dedicated iii adapter with capability-bound routing and durable delivery/retry/idempotency;
6. status-only Hermes/OpenClaw adapters and a bounded AgentMemory context adapter;
7. de-authorization of legacy policy/router vetoes and reconciliation of conflicting approval documentation;
8. duplicate-delivery, crash-recovery, expiry, revocation, forged-result, worker-to-worker, and audit-failure tests.

No Phase 2 runtime activation may occur until those controls are independently reviewed and the exact deployment is separately approved.
